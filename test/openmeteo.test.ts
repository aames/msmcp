/**
 * Tests for {@link OpenMeteoFetcher}: zipping the column-oriented response into
 * per-hour rows, clipping to the requested window, the request URL contract, and
 * defensive handling of malformed or error responses.
 *
 * `fetch` is stubbed; no network access is required.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenMeteoFetcher } from "../src/fetchers/openmeteo.js";
import type { ForecastParams } from "../src/fetchers/interface.js";

const PARAMS: ForecastParams = {
  lat: -41.29,
  lon: 174.78,
  start: "2026-06-04T00:00:00.000Z",
  end: "2026-06-04T05:00:00.000Z",
  variables: ["temperature", "precipitation", "wind_speed", "wind_gust", "cloud_cover"],
};

/** A column-oriented response with `times` and matching-length series. */
function payload(times: readonly string[]) {
  const fill = (v: number) => times.map(() => v);
  return {
    hourly: {
      time: [...times],
      temperature_2m: fill(15),
      precipitation: fill(0),
      wind_speed_10m: fill(10),
      wind_gusts_10m: fill(20),
      cloud_cover: fill(50),
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

describe("row zipping", () => {
  it("zips parallel columns into per-hour rows (units pass through)", async () => {
    stubFetch(payload(["2026-06-04T01:00", "2026-06-04T02:00"]));
    const { hourly } = await new OpenMeteoFetcher().getForecast(PARAMS);

    expect(hourly).toHaveLength(2);
    expect(hourly[0]).toEqual({
      time: "2026-06-04T01:00",
      temperature_c: 15,
      precipitation_mm_per_hour: 0,
      wind_speed_kmh: 10,
      wind_gust_kmh: 20,
      cloud_cover_pct: 50,
    });
  });
});

describe("window clipping", () => {
  it("drops hours outside the inclusive [start, end] window", async () => {
    stubFetch(
      payload([
        "2026-06-04T00:00", // == start bound -> kept
        "2026-06-04T03:00", // inside -> kept
        "2026-06-04T05:00", // == end bound -> kept
        "2026-06-04T06:00", // after end -> dropped
      ]),
    );
    const { hourly } = await new OpenMeteoFetcher().getForecast(PARAMS);
    expect(hourly.map((h) => h.time)).toEqual([
      "2026-06-04T00:00",
      "2026-06-04T03:00",
      "2026-06-04T05:00",
    ]);
  });
});

describe("request contract", () => {
  it("requests the mapped hourly variable names with timezone=auto", async () => {
    const fetchMock = stubFetch(payload(["2026-06-04T01:00"]));
    await new OpenMeteoFetcher().getForecast(PARAMS);

    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.searchParams.get("latitude")).toBe("-41.29");
    expect(url.searchParams.get("longitude")).toBe("174.78");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("hourly")).toBe(
      "temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,cloud_cover",
    );
  });
});

describe("error handling", () => {
  it("throws with the upstream reason on an error payload", async () => {
    stubFetch({ error: true, reason: "No data for this location" });
    await expect(new OpenMeteoFetcher().getForecast(PARAMS)).rejects.toThrow(
      /No data for this location/,
    );
  });

  it("throws when a requested series is missing", async () => {
    const body = payload(["2026-06-04T01:00"]) as { hourly: Record<string, unknown> };
    delete body.hourly.cloud_cover;
    stubFetch(body);
    await expect(new OpenMeteoFetcher().getForecast(PARAMS)).rejects.toThrow(
      /missing the "cloud_cover" series/,
    );
  });

  it("throws when a series is shorter than the time axis", async () => {
    const body = payload(["2026-06-04T01:00", "2026-06-04T02:00"]);
    body.hourly.precipitation = [0]; // too short
    stubFetch(body);
    await expect(new OpenMeteoFetcher().getForecast(PARAMS)).rejects.toThrow(
      /shorter than its time series/,
    );
  });

  it("throws on a non-2xx HTTP status", async () => {
    stubFetch("nope", { status: 502, statusText: "Bad Gateway" });
    await expect(new OpenMeteoFetcher().getForecast(PARAMS)).rejects.toThrow(/502/);
  });
});
