/**
 * The {@link ForecastFetcher} boundary.
 *
 * This is the single seam between the tool layer and any concrete weather
 * provider. The tool layer (`tools/forecast.ts`) depends only on this
 * interface and the {@link RawForecast} shape — it has no knowledge of whether
 * Open-Meteo, MetService, or a future provider produced the data. This is the
 * Dependency Inversion principle in practice: high-level policy (deriving
 * advice) does not depend on low-level detail (HTTP calls to a vendor).
 *
 * Adding a provider is therefore an Open/Closed operation: implement this
 * interface in a new file and register it in the factory, with no edits to the
 * tool layer.
 */

import type { ForecastVariable } from "../types.js";

/**
 * Inputs to a forecast request, already validated and normalised by the tool
 * layer. `start`/`end` are concrete here (the tool layer applies defaults),
 * so fetchers never have to invent a window.
 */
export interface ForecastParams {
  /** Latitude in decimal degrees (WGS84). */
  readonly lat: number;
  /** Longitude in decimal degrees (WGS84). */
  readonly lon: number;
  /** Inclusive start of the forecast window, ISO 8601. */
  readonly start: string;
  /** Inclusive end of the forecast window, ISO 8601. */
  readonly end: string;
  /** Variables to fetch. Never empty — the tool layer applies defaults. */
  readonly variables: readonly ForecastVariable[];
}

/**
 * Provider output normalised to this server's units and variable names, but
 * *before* any derived signals (rain flag, summary, etc.) are computed.
 *
 * Fetchers are responsible for unit conversion and windowing; the tool layer
 * is responsible for interpretation. Keeping that split means a new provider
 * only has to answer "what are the numbers?", never "what do they mean?".
 */
export interface RawForecast {
  /**
   * Hourly series, ascending in time, already clipped to the requested
   * window. Units match {@link import("../types.js").HourlyForecast}.
   */
  readonly hourly: readonly RawHourly[];
}

/**
 * A single normalised hour as produced by a fetcher.
 *
 * Identical in shape to the public `HourlyForecast`, but kept as a distinct
 * type so the public output type can evolve (e.g. gain fields the fetcher
 * doesn't supply) without coupling the provider contract to it.
 */
export interface RawHourly {
  readonly time: string;
  readonly temperature_c: number;
  readonly precipitation_mm_per_hour: number;
  readonly wind_speed_kmh: number;
  readonly wind_gust_kmh: number;
  readonly cloud_cover_pct: number;
}

/**
 * Fetches normalised weather forecasts from a concrete provider.
 *
 * Implementations must:
 *  - convert provider units to the units documented on {@link RawHourly};
 *  - return hours within `[params.start, params.end]`, ascending in time;
 *  - throw an `Error` with a human-readable message on failure (the tool layer
 *    relays the message to the model, so it must be clear and free of stack
 *    traces or secrets).
 */
export interface ForecastFetcher {
  /** Stable identifier surfaced in `ForecastResult.fetcher_used` for debugging. */
  readonly id: string;
  getForecast(params: ForecastParams): Promise<RawForecast>;
}
