/**
 * Open-Meteo implementation of {@link ForecastFetcher}.
 *
 * Open-Meteo is a free, key-less forecast API. In Phase 1 it is the active
 * provider. Its hourly response is column-oriented (parallel arrays keyed by
 * variable), so the bulk of the work here is zipping those columns back into
 * per-hour rows and clipping them to the requested window.
 *
 * Units returned by Open-Meteo with the parameters we request already match
 * this server's normalised units (°C, mm, km/h, %), so no unit conversion is
 * required — but we assert the response shape defensively because a silent
 * shape change upstream would otherwise produce `NaN`s downstream.
 *
 * @see https://open-meteo.com/en/docs
 */

import type {
  ForecastFetcher,
  ForecastParams,
  RawForecast,
  RawHourly,
} from "./interface.js";
import type { ForecastVariable } from "../types.js";

/** Base URL of the Open-Meteo forecast endpoint. */
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * Maps this server's normalised variable names to Open-Meteo's `hourly`
 * parameter names. Centralising the mapping keeps the provider's naming
 * quirks out of the rest of the codebase.
 */
const VARIABLE_TO_OPEN_METEO: Readonly<Record<ForecastVariable, string>> = {
  temperature: "temperature_2m",
  precipitation: "precipitation",
  wind_speed: "wind_speed_10m",
  wind_gust: "wind_gusts_10m",
  cloud_cover: "cloud_cover",
};

/**
 * Shape of the slice of the Open-Meteo response we consume. Open-Meteo returns
 * one parallel array per requested variable plus a `time` array; every array
 * shares the same length and index alignment.
 */
interface OpenMeteoResponse {
  readonly hourly?: {
    readonly time?: readonly string[];
    readonly temperature_2m?: readonly number[];
    readonly precipitation?: readonly number[];
    readonly wind_speed_10m?: readonly number[];
    readonly wind_gusts_10m?: readonly number[];
    readonly cloud_cover?: readonly number[];
  };
  /** Present when Open-Meteo rejects a request (e.g. bad coordinates). */
  readonly error?: boolean;
  readonly reason?: string;
}

export class OpenMeteoFetcher implements ForecastFetcher {
  public readonly id = "openmeteo";

  public async getForecast(params: ForecastParams): Promise<RawForecast> {
    const response = await this.requestForecast(params);
    const payload = (await response.json()) as OpenMeteoResponse;

    if (payload.error === true) {
      throw new Error(
        `Open-Meteo rejected the request: ${payload.reason ?? "unknown reason"}.`,
      );
    }

    const hourly = this.toHourlyRows(payload);
    return { hourly: this.clipToWindow(hourly, params.start, params.end) };
  }

  /**
   * Issues the HTTP request and fails loudly (with a clean message) on any
   * non-2xx status, so the caller never tries to parse an error body as data.
   */
  private async requestForecast(params: ForecastParams): Promise<Response> {
    const url = this.buildUrl(params);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new Error(
        `Could not reach the Open-Meteo forecast service. ${describeCause(cause)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Open-Meteo returned HTTP ${response.status} (${response.statusText}).`,
      );
    }
    return response;
  }

  private buildUrl(params: ForecastParams): string {
    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.searchParams.set("latitude", String(params.lat));
    url.searchParams.set("longitude", String(params.lon));
    url.searchParams.set(
      "hourly",
      params.variables.map((v) => VARIABLE_TO_OPEN_METEO[v]).join(","),
    );
    // `timezone=auto` makes Open-Meteo return timestamps in the location's
    // local time, which is what overnight-window derivation expects.
    url.searchParams.set("timezone", "auto");
    // Open-Meteo serves whole-day buckets; we request the full 7-day horizon
    // and clip to the caller's window ourselves for precise control.
    url.searchParams.set("forecast_days", "7");
    return url.toString();
  }

  /**
   * Zips the column-oriented response into per-hour rows.
   *
   * If a requested variable is absent from the response (e.g. the upstream
   * schema drifted), its column reads as `undefined` and we surface a clear
   * error rather than emitting `NaN`-laden rows.
   */
  private toHourlyRows(payload: OpenMeteoResponse): RawHourly[] {
    const hourly = payload.hourly;
    const times = hourly?.time;
    if (!hourly || !times) {
      throw new Error(
        "Open-Meteo response did not contain an hourly time series.",
      );
    }

    return times.map((time, index) => ({
      time,
      temperature_c: readColumn(hourly.temperature_2m, index, "temperature"),
      precipitation_mm_per_hour: readColumn(
        hourly.precipitation,
        index,
        "precipitation",
      ),
      wind_speed_kmh: readColumn(hourly.wind_speed_10m, index, "wind_speed"),
      wind_gust_kmh: readColumn(hourly.wind_gusts_10m, index, "wind_gust"),
      cloud_cover_pct: readColumn(hourly.cloud_cover, index, "cloud_cover"),
    }));
  }

  /**
   * Restricts the series to `[start, end]`. Open-Meteo timestamps lack an
   * explicit offset (they are local wall-clock for the location), so we compare
   * lexicographically on the ISO strings — valid because the format is
   * fixed-width (`YYYY-MM-DDTHH:mm`) and the bounds are normalised to the same
   * shape by {@link toComparableBound}.
   */
  private clipToWindow(
    rows: readonly RawHourly[],
    start: string,
    end: string,
  ): RawHourly[] {
    const lower = toComparableBound(start);
    const upper = toComparableBound(end);
    return rows.filter((row) => row.time >= lower && row.time <= upper);
  }
}

/**
 * Reads a value from a parallel column, throwing a precise error if the column
 * is missing or shorter than the `time` array.
 */
function readColumn(
  column: readonly number[] | undefined,
  index: number,
  variableName: string,
): number {
  if (column === undefined) {
    throw new Error(
      `Open-Meteo response is missing the "${variableName}" series.`,
    );
  }
  const value = column[index];
  if (value === undefined) {
    throw new Error(
      `Open-Meteo "${variableName}" series is shorter than its time series.`,
    );
  }
  return value;
}

/**
 * Normalises an ISO datetime bound to Open-Meteo's `YYYY-MM-DDTHH:mm` minute
 * precision so it can be compared lexicographically against response
 * timestamps. Seconds and any timezone designator are dropped.
 */
function toComparableBound(iso: string): string {
  // `2026-06-04T18:30:00Z` -> `2026-06-04T18:30`
  return iso.slice(0, 16);
}

/** Extracts a safe, message-only description from an unknown thrown value. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown network error.";
}
