/**
 * Tests for {@link MetServiceFetcher}: unit conversion, `noData` filtering,
 * defensive shape validation, the outbound request contract, and — importantly
 * — that the API key never leaks into an error message.
 *
 * `fetch` is stubbed; no network access is required.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MetServiceFetcher } from "../src/fetchers/metservice.js";
import type { ForecastParams } from "../src/fetchers/interface.js";

const API_KEY = "test-secret-key-DO-NOT-LEAK";

const PARAMS: ForecastParams = {
  lat: -43.53,
  lon: 172.63,
  start: "2026-06-04T00:00:00.000Z",
  end: "2026-06-04T02:00:00.000Z",
  variables: ["temperature", "precipitation", "wind_speed", "wind_gust", "cloud_cover"],
};

/**
 * Builds a well-formed MetOcean point-time payload with `n` hours. Every value
 * defaults to a known input so conversions can be asserted; `noData` is all-good
 * unless a test overrides it.
 */
function payload(n: number) {
  const times = Array.from({ length: n }, (_, i) => `2026-06-04T0${i}:00:00.000Z`);
  const column = (value: number) => ({
    data: Array.from({ length: n }, () => value),
    noData: Array.from({ length: n }, () => 0),
  });
  return {
    dimensions: { time: { data: times } },
    variables: {
      "air.temperature.at-2m": column(288.15), // 15 °C
      "precipitation.rate": column(0.5), // mm/hr (passthrough)
      "wind.speed.at-10m": column(10), // 36 km/h
      "wind.speed.gust.at-10m": column(20), // 72 km/h
      "cloud.cover": column(83), // % (passthrough)
    },
  };
}

function stubFetch(body: unknown, init: ResponseInit = { status: 200 }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unit conversion", () => {
  it("converts Kelvin to Celsius and m/s to km/h, passing rate and cloud through", async () => {
    stubFetch(payload(1));
    const { hourly } = await new MetServiceFetcher(API_KEY).getForecast(PARAMS);

    expect(hourly).toHaveLength(1);
    const row = hourly[0]!;
    expect(row.temperature_c).toBeCloseTo(15, 6);
    expect(row.wind_speed_kmh).toBeCloseTo(36, 6);
    expect(row.wind_gust_kmh).toBeCloseTo(72, 6);
    expect(row.precipitation_mm_per_hour).toBe(0.5);
    expect(row.cloud_cover_pct).toBe(83);
    expect(row.time).toBe("2026-06-04T00:00:00.000Z");
  });
});

describe("noData filtering", () => {
  it("drops an hour when any variable flags it as not-good", async () => {
    const body = payload(3);
    // Flag hour index 1 as unreliable on a single variable.
    body.variables["wind.speed.gust.at-10m"].noData[1] = 2;

    stubFetch(body);
    const { hourly } = await new MetServiceFetcher(API_KEY).getForecast(PARAMS);

    expect(hourly).toHaveLength(2);
    expect(hourly.map((h) => h.time)).toEqual([
      "2026-06-04T00:00:00.000Z",
      "2026-06-04T02:00:00.000Z",
    ]);
  });

  it("returns no hours when every hour is flagged", async () => {
    const body = payload(2);
    body.variables["air.temperature.at-2m"].noData = [1, 1];

    stubFetch(body);
    const { hourly } = await new MetServiceFetcher(API_KEY).getForecast(PARAMS);

    expect(hourly).toEqual([]);
  });
});

describe("defensive validation", () => {
  it("throws when the time dimension is missing", async () => {
    stubFetch({ variables: {} });
    await expect(new MetServiceFetcher(API_KEY).getForecast(PARAMS)).rejects.toThrow(
      /dimensions\.time/,
    );
  });

  it("throws when a requested variable column is absent", async () => {
    const body = payload(1) as { variables: Record<string, unknown> };
    delete body.variables["cloud.cover"];
    stubFetch(body);
    await expect(new MetServiceFetcher(API_KEY).getForecast(PARAMS)).rejects.toThrow(
      /missing variable: cloud\.cover/,
    );
  });

  it("throws when a column length does not match the time axis", async () => {
    const body = payload(3);
    body.variables["precipitation.rate"].data = [0.1]; // too short
    stubFetch(body);
    await expect(new MetServiceFetcher(API_KEY).getForecast(PARAMS)).rejects.toThrow(
      /inconsistent array lengths/,
    );
  });
});

describe("outbound request contract", () => {
  it("POSTs the point/time request with the key header and a 1h interval body", async () => {
    const fetchMock = stubFetch(payload(1));
    await new MetServiceFetcher(API_KEY).getForecast(PARAMS);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/point/time");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(API_KEY);

    const sent = JSON.parse(init.body as string);
    expect(sent.points).toEqual([{ lat: PARAMS.lat, lon: PARAMS.lon }]);
    expect(sent.time).toEqual({ from: PARAMS.start, to: PARAMS.end, interval: "1h" });
    expect(sent.variables).toContain("air.temperature.at-2m");
  });
});

describe("the API key never leaks", () => {
  it("keeps the key out of a non-2xx error message", async () => {
    stubFetch("upstream boom", { status: 500, statusText: "Internal Server Error" });
    await expect(
      new MetServiceFetcher(API_KEY).getForecast(PARAMS),
    ).rejects.toThrow(expect.not.stringContaining(API_KEY));
  });

  it("keeps the key out of a network-failure error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));
    await expect(
      new MetServiceFetcher(API_KEY).getForecast(PARAMS),
    ).rejects.toThrow(expect.not.stringContaining(API_KEY));
  });
});
