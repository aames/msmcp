/**
 * Tests for the {@link geocode} function: best-match selection, region
 * derivation precedence, the Nominatim request contract, and error handling for
 * no-match, bad coordinates, HTTP errors, and network failure.
 *
 * `fetch` is stubbed; no network access is required.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { geocode } from "../src/tools/geocode.js";

function stubFetch(body: unknown, init: ResponseInit = { status: 200 }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const WELLINGTON = {
  lat: "-41.2887953",
  lon: "174.7772114",
  display_name: "Wellington, Wellington City, New Zealand",
  address: { region: "Wellington" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("successful lookup", () => {
  it("returns the first (best) match parsed to numbers", async () => {
    stubFetch([WELLINGTON, { ...WELLINGTON, lat: "0", lon: "0" }]);
    const result = await geocode("Wellington");

    expect(result.lat).toBeCloseTo(-41.2887953, 6);
    expect(result.lon).toBeCloseTo(174.7772114, 6);
    expect(result.name).toBe("Wellington, Wellington City, New Zealand");
    expect(result.region).toBe("Wellington");
  });

  it("constrains the query to New Zealand with the required parameters and User-Agent", async () => {
    const fetchMock = stubFetch([WELLINGTON]);
    await geocode("Petone");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("Petone");
    expect(parsed.searchParams.get("countrycodes")).toBe("nz");
    expect(parsed.searchParams.get("format")).toBe("jsonv2");
    expect(parsed.searchParams.get("addressdetails")).toBe("1");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
  });
});

describe("region derivation precedence", () => {
  it("prefers region, then state, then county, then city", async () => {
    stubFetch([{ ...WELLINGTON, address: { state: "Otago", county: "Dunedin City", city: "Dunedin" } }]);
    expect((await geocode("x")).region).toBe("Otago");

    stubFetch([{ ...WELLINGTON, address: { county: "Dunedin City", city: "Dunedin" } }]);
    expect((await geocode("x")).region).toBe("Dunedin City");

    stubFetch([{ ...WELLINGTON, address: { city: "Dunedin" } }]);
    expect((await geocode("x")).region).toBe("Dunedin");
  });

  it("falls back to 'New Zealand' when no address parts are present", async () => {
    stubFetch([{ lat: "-45", lon: "170", display_name: "Somewhere" }]);
    expect((await geocode("x")).region).toBe("New Zealand");
  });
});

describe("error handling", () => {
  it("throws a clear no-match error on an empty result set", async () => {
    stubFetch([]);
    await expect(geocode("Zzqwxnowhereville")).rejects.toThrow(/No New Zealand location found/);
  });

  it("throws when the matched coordinate is unparseable", async () => {
    stubFetch([{ lat: "not-a-number", lon: "174", display_name: "Broken" }]);
    await expect(geocode("x")).rejects.toThrow(/unreadable coordinate/);
  });

  it("throws on a non-2xx HTTP status", async () => {
    stubFetch("rate limited", { status: 429, statusText: "Too Many Requests" });
    await expect(geocode("x")).rejects.toThrow(/HTTP 429/);
  });

  it("throws a reachability error on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("dns failure");
    }));
    await expect(geocode("x")).rejects.toThrow(/Could not reach the geocoding service/);
  });
});
