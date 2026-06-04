/**
 * Tests for the `get_forecast` interpretation layer: the derived signals
 * (`rain_expected`, `overnight_min_temp_c`, `summary`) and the input defaulting
 * policy (`resolveRequest`).
 *
 * The derivations are exercised through {@link getForecast} with a fake
 * {@link ForecastFetcher} injected — the same Dependency-Inversion seam the
 * Worker uses — so we test observable behaviour, not private helpers. The fake
 * lets us feed exact hourly rows and assert what the model would receive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getForecast, resolveRequest } from "../src/tools/forecast.js";
import { RAIN_THRESHOLD_MM_PER_HOUR } from "../src/types.js";
import type {
  ForecastFetcher,
  ForecastParams,
  RawForecast,
  RawHourly,
} from "../src/fetchers/interface.js";

/** A fetcher that returns canned rows, so derivations are deterministic. */
class FakeFetcher implements ForecastFetcher {
  public readonly id = "fake";
  public lastParams: ForecastParams | undefined;
  public constructor(private readonly rows: readonly RawHourly[]) {}
  public async getForecast(params: ForecastParams): Promise<RawForecast> {
    this.lastParams = params;
    return { hourly: this.rows };
  }
}

/** Builds an hour with sensible defaults, overriding only what a test cares about. */
function hour(overrides: Partial<RawHourly> = {}): RawHourly {
  return {
    time: "2026-06-04T12:00",
    temperature_c: 15,
    precipitation_mm_per_hour: 0,
    wind_speed_kmh: 10,
    wind_gust_kmh: 20,
    cloud_cover_pct: 50,
    ...overrides,
  };
}

const REQUEST = {
  lat: -41.29,
  lon: 174.78,
  start: "2026-06-04T00:00:00.000Z",
  end: "2026-06-11T00:00:00.000Z",
  variables: ["temperature", "precipitation", "wind_speed", "wind_gust", "cloud_cover"] as const,
};

async function forecastFrom(rows: readonly RawHourly[]) {
  return getForecast(new FakeFetcher(rows), REQUEST);
}

describe("rain_expected", () => {
  it("is false for an empty window", async () => {
    const result = await forecastFrom([]);
    expect(result.rain_expected).toBe(false);
  });

  it("is false just below the threshold", async () => {
    const result = await forecastFrom([
      hour({ precipitation_mm_per_hour: RAIN_THRESHOLD_MM_PER_HOUR - 0.01 }),
    ]);
    expect(result.rain_expected).toBe(false);
  });

  it("is true exactly at the threshold (boundary is inclusive)", async () => {
    const result = await forecastFrom([
      hour({ precipitation_mm_per_hour: RAIN_THRESHOLD_MM_PER_HOUR }),
    ]);
    expect(result.rain_expected).toBe(true);
  });

  it("is true if any single hour exceeds the threshold", async () => {
    const result = await forecastFrom([
      hour({ precipitation_mm_per_hour: 0 }),
      hour({ precipitation_mm_per_hour: 0 }),
      hour({ precipitation_mm_per_hour: 5 }),
    ]);
    expect(result.rain_expected).toBe(true);
  });
});

describe("overnight_min_temp_c", () => {
  it("is null when the window has no overnight hours", async () => {
    // 09:00–17:00 are all daytime (band is 18:00–08:00).
    const result = await forecastFrom([
      hour({ time: "2026-06-04T09:00", temperature_c: 4 }),
      hour({ time: "2026-06-04T12:00", temperature_c: 8 }),
      hour({ time: "2026-06-04T17:00", temperature_c: 6 }),
    ]);
    expect(result.overnight_min_temp_c).toBeNull();
  });

  it("includes the 18:00 and 08:00 band edges and takes the minimum", async () => {
    const result = await forecastFrom([
      hour({ time: "2026-06-04T18:00", temperature_c: 11 }), // band start (inclusive)
      hour({ time: "2026-06-04T23:00", temperature_c: 7 }),
      hour({ time: "2026-06-05T03:00", temperature_c: 5 }), // coldest, after midnight
      hour({ time: "2026-06-05T08:00", temperature_c: 9 }), // band end (inclusive)
      hour({ time: "2026-06-05T13:00", temperature_c: 2 }), // daytime — must be ignored
    ]);
    expect(result.overnight_min_temp_c).toBe(5);
  });

  it("ignores daytime lows even when they are colder than the overnight low", async () => {
    const result = await forecastFrom([
      hour({ time: "2026-06-04T12:00", temperature_c: -3 }), // daytime, coldest overall
      hour({ time: "2026-06-04T22:00", temperature_c: 6 }),
    ]);
    expect(result.overnight_min_temp_c).toBe(6);
  });

  it("does not count an hour with a malformed timestamp", async () => {
    const result = await forecastFrom([
      hour({ time: "not-a-timestamp", temperature_c: -10 }),
      hour({ time: "2026-06-04T20:00", temperature_c: 8 }),
    ]);
    expect(result.overnight_min_temp_c).toBe(8);
  });
});

describe("summary", () => {
  it("reports no data for an empty window", async () => {
    const result = await forecastFrom([]);
    expect(result.summary).toBe(
      "No forecast data is available for the requested window.",
    );
  });

  it("says 'Mostly dry' and rounds the peak gust when there is no rain", async () => {
    const result = await forecastFrom([
      hour({ time: "2026-06-04T12:00", wind_gust_kmh: 17.4 }),
      hour({ time: "2026-06-04T13:00", wind_gust_kmh: 18.6 }), // peak, rounds to 19
    ]);
    expect(result.summary).toBe("Mostly dry with gusts to 19 km/h.");
  });

  it("says 'Rainy' and appends a rounded overnight low when present", async () => {
    const result = await forecastFrom([
      hour({ time: "2026-06-04T20:00", precipitation_mm_per_hour: 2, wind_gust_kmh: 64.6, temperature_c: 8.4 }),
    ]);
    expect(result.summary).toBe("Rainy with gusts to 65 km/h, overnight low 8°C.");
  });
});

describe("fetcher_used", () => {
  it("reports the id of the fetcher that produced the data", async () => {
    const result = await forecastFrom([hour()]);
    expect(result.fetcher_used).toBe("fake");
  });

  it("passes the resolved request straight through to the fetcher", async () => {
    const fetcher = new FakeFetcher([hour()]);
    await getForecast(fetcher, REQUEST);
    expect(fetcher.lastParams).toEqual(REQUEST);
  });
});

describe("resolveRequest (defaulting policy)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults start to now and end to 7 days after start", () => {
    const resolved = resolveRequest({
      lat: -41.29,
      lon: 174.78,
      start: undefined,
      end: undefined,
      variables: undefined,
    });
    expect(resolved.start).toBe("2026-06-04T00:00:00.000Z");
    expect(resolved.end).toBe("2026-06-11T00:00:00.000Z");
  });

  it("derives end from a supplied start (7-day window)", () => {
    const resolved = resolveRequest({
      lat: 0,
      lon: 0,
      start: "2026-01-01T00:00:00.000Z",
      end: undefined,
      variables: undefined,
    });
    expect(resolved.end).toBe("2026-01-08T00:00:00.000Z");
  });

  it("defaults an omitted variable list to the full set", () => {
    const resolved = resolveRequest({
      lat: 0, lon: 0, start: undefined, end: undefined, variables: undefined,
    });
    expect(resolved.variables).toEqual([
      "temperature", "precipitation", "wind_speed", "wind_gust", "cloud_cover",
    ]);
  });

  it("defaults an empty variable list to the full set", () => {
    const resolved = resolveRequest({
      lat: 0, lon: 0, start: undefined, end: undefined, variables: [],
    });
    expect(resolved.variables).toHaveLength(5);
  });

  it("preserves an explicit variable subset", () => {
    const resolved = resolveRequest({
      lat: 0, lon: 0, start: undefined, end: undefined, variables: ["temperature"],
    });
    expect(resolved.variables).toEqual(["temperature"]);
  });
});
