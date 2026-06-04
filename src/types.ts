/**
 * Shared domain types for the msmcp NZ weather server.
 *
 * These describe the *public* shapes returned by the MCP tools. They are
 * deliberately decoupled from any particular forecast provider: the
 * {@link ForecastFetcher} boundary (see `fetchers/interface.ts`) is responsible
 * for translating a provider's wire format into {@link RawForecast}, and the
 * tool layer derives the user-facing {@link ForecastResult} from there.
 */

/**
 * A place name resolved to coordinates. Returned by the `geocode` tool.
 *
 * Coordinates use the WGS84 datum (standard GPS lat/lon), matching what every
 * downstream weather API expects.
 */
export interface GeocodedLocation {
  [key: string]: unknown;
  readonly lat: number;
  readonly lon: number;
  readonly name: string;
  readonly region: string;
}

/**
 * The canonical set of forecast variables this server understands.
 *
 * Using a closed union (rather than free-form strings) keeps the fetcher
 * implementations honest: every fetcher must map exactly these names, and the
 * compiler flags any drift. The string values are the names exposed to MCP
 * clients via the `variables` parameter of `get_forecast`.
 */
export const FORECAST_VARIABLES = [
  "temperature",
  "precipitation",
  "wind_speed",
  "wind_gust",
  "cloud_cover",
] as const;

export type ForecastVariable = (typeof FORECAST_VARIABLES)[number];

/**
 * The default variable set used when a caller does not specify `variables`.
 * Kept identical to the full set in Phase 1; declared separately so the
 * default can diverge later (e.g. trimming to reduce MetService billing units)
 * without touching call sites.
 */
export const DEFAULT_FORECAST_VARIABLES: readonly ForecastVariable[] =
  FORECAST_VARIABLES;

/**
 * A single hour of forecast data, normalised to consistent units regardless of
 * which fetcher produced it.
 */
export interface HourlyForecast {
  /** ISO 8601 timestamp for the start of the hour, in the location's local time. */
  readonly time: string;
  /** Air temperature, degrees Celsius. */
  readonly temperature_c: number;
  /** Precipitation accumulated in this hour, expressed as a rate in mm/hour. */
  readonly precipitation_mm_per_hour: number;
  /** Sustained wind speed at 10 m, km/h. */
  readonly wind_speed_kmh: number;
  /** Wind gust at 10 m, km/h. */
  readonly wind_gust_kmh: number;
  /** Total cloud cover, percent (0–100). */
  readonly cloud_cover_pct: number;
}

/**
 * The fully-derived forecast returned by the `get_forecast` tool.
 *
 * In addition to the raw hourly series, this carries a small number of
 * derived signals that let an LLM give good weather advice without having to
 * scan the entire array itself.
 */
export interface ForecastResult {
  [key: string]: unknown;
  readonly hourly: readonly HourlyForecast[];
  /**
   * True if any hour in the window has measurable precipitation
   * (> {@link RAIN_THRESHOLD_MM_PER_HOUR}).
   *
   * Note: this is derived from precipitation *flux*, not probability of
   * precipitation — no provider in scope exposes a PoP variable.
   */
  readonly rain_expected: boolean;
  /**
   * Minimum temperature observed during overnight hours (18:00–08:00 local)
   * within the window, or `null` if the window contains no overnight hours.
   */
  readonly overnight_min_temp_c: number | null;
  /** One plain-English sentence summarising the window, for the model to build advice from. */
  readonly summary: string;
  /** Identifier of the fetcher that produced this forecast (for debugging). */
  readonly fetcher_used: string;
}

/**
 * Precipitation flux at or above this rate (mm/hour) is treated as
 * "rain expected". 0.1 mm/hr is light drizzle — low enough to flag a damp day,
 * high enough to ignore sensor noise.
 */
export const RAIN_THRESHOLD_MM_PER_HOUR = 0.1;
