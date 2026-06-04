/**
 * The `get_forecast` MCP tool: turns a lat/lon into an hourly NZ forecast plus
 * derived advice signals.
 *
 * This is the interpretation layer. It owns the *policy* — applying default
 * windows and variables, deriving the rain flag, overnight low, and summary —
 * while delegating the *mechanism* of fetching to an injected
 * {@link ForecastFetcher}. The fetcher is passed in (Dependency Inversion), so
 * this module never references Open-Meteo, MetService, or the `FETCHER` env var.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ForecastFetcher } from "../fetchers/interface.js";
import {
  DEFAULT_FORECAST_VARIABLES,
  FORECAST_VARIABLES,
  RAIN_THRESHOLD_MM_PER_HOUR,
  type ForecastResult,
  type ForecastVariable,
  type HourlyForecast,
} from "../types.js";

/** Length of the default forecast window when no `end` is supplied. */
const DEFAULT_WINDOW_DAYS = 7;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Local-time hours that count as "overnight" for the overnight-low derivation. */
const OVERNIGHT_START_HOUR = 18; // 18:00 inclusive
const OVERNIGHT_END_HOUR = 8; // up to 08:00 inclusive

const GET_FORECAST_DESCRIPTION = [
  "Return an hourly New Zealand weather forecast for a latitude/longitude coordinate.",
  "If you have a place name rather than coordinates, call geocode first and pass its lat/lon here.",
  "Each hour includes temperature (°C), precipitation rate (mm/hour), wind speed and gust (km/h), and cloud cover (%).",
  "Important: precipitation is reported as a flux (mm/hour rate), NOT a probability of rain —",
  "base any rain advice on the rain_expected flag, which is true when any hour exceeds a light-drizzle threshold.",
  "Also returns overnight_min_temp_c (the overnight low) and a one-sentence summary you can build advice from.",
  "This server is NZ-focused; data quality is best within New Zealand.",
].join(" ");

const getForecastInputShape = {
  lat: z
    .number()
    .min(-90)
    .max(90)
    .describe("Latitude in decimal degrees (WGS84), e.g. -41.29 for Wellington."),
  lon: z
    .number()
    .min(-180)
    .max(180)
    .describe("Longitude in decimal degrees (WGS84), e.g. 174.78 for Wellington."),
  start: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      "Inclusive start of the window as an ISO 8601 datetime. Defaults to now.",
    ),
  end: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      `Inclusive end of the window as an ISO 8601 datetime. Defaults to ${DEFAULT_WINDOW_DAYS} days after start.`,
    ),
  variables: z
    .array(z.enum(FORECAST_VARIABLES))
    .nonempty()
    .optional()
    .describe(
      "Which variables to include. Defaults to the full set: temperature, precipitation, wind_speed, wind_gust, cloud_cover.",
    ),
};

const hourlyOutputShape = {
  time: z.string(),
  temperature_c: z.number(),
  precipitation_mm_per_hour: z.number(),
  wind_speed_kmh: z.number(),
  wind_gust_kmh: z.number(),
  cloud_cover_pct: z.number(),
};

const getForecastOutputShape = {
  hourly: z.array(z.object(hourlyOutputShape)),
  rain_expected: z.boolean(),
  overnight_min_temp_c: z.number().nullable(),
  summary: z.string(),
  fetcher_used: z.string(),
};

/** Validated, defaults-applied inputs to {@link getForecast}. */
interface ResolvedRequest {
  readonly lat: number;
  readonly lon: number;
  readonly start: string;
  readonly end: string;
  readonly variables: readonly ForecastVariable[];
}

/**
 * Produces a fully-derived {@link ForecastResult} using the supplied fetcher.
 *
 * @param fetcher the active provider, injected by the caller.
 * @throws Error (with a relayable message) if the fetcher fails.
 */
export async function getForecast(
  fetcher: ForecastFetcher,
  request: ResolvedRequest,
): Promise<ForecastResult> {
  const raw = await fetcher.getForecast({
    lat: request.lat,
    lon: request.lon,
    start: request.start,
    end: request.end,
    variables: request.variables,
  });

  const hourly: readonly HourlyForecast[] = raw.hourly;

  return {
    hourly,
    rain_expected: deriveRainExpected(hourly),
    overnight_min_temp_c: deriveOvernightMin(hourly),
    summary: buildSummary(hourly),
    fetcher_used: fetcher.id,
  };
}

/** True if any hour has precipitation at or above the rain threshold. */
function deriveRainExpected(hourly: readonly HourlyForecast[]): boolean {
  return hourly.some(
    (hour) => hour.precipitation_mm_per_hour >= RAIN_THRESHOLD_MM_PER_HOUR,
  );
}

/**
 * Minimum temperature across overnight hours (18:00–08:00 local) in the
 * window, or `null` if the window contains no overnight hours.
 */
function deriveOvernightMin(
  hourly: readonly HourlyForecast[],
): number | null {
  const overnightTemps = hourly
    .filter((hour) => isOvernight(hour.time))
    .map((hour) => hour.temperature_c);

  return overnightTemps.length > 0 ? Math.min(...overnightTemps) : null;
}

/**
 * Whether a local-time ISO timestamp falls in the overnight band. The band
 * wraps midnight, so it is the union of [18:00, 24:00) and [00:00, 08:00].
 */
function isOvernight(isoLocalTime: string): boolean {
  const hour = parseLocalHour(isoLocalTime);
  if (hour === null) {
    return false;
  }
  return hour >= OVERNIGHT_START_HOUR || hour <= OVERNIGHT_END_HOUR;
}

/**
 * Extracts the hour-of-day from an Open-Meteo-style local timestamp
 * (`YYYY-MM-DDTHH:mm`). Returns `null` if the shape is unexpected, so callers
 * fail safe rather than miscounting.
 */
function parseLocalHour(isoLocalTime: string): number | null {
  const match = /T(\d{2}):/.exec(isoLocalTime);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  return Number.isNaN(hour) ? null : hour;
}

/**
 * Builds a single plain-English sentence summarising the window. Designed to
 * give an LLM enough to reason from without re-reading the hourly array:
 * mentions rain, peak gusts, and the overnight low when available.
 */
function buildSummary(hourly: readonly HourlyForecast[]): string {
  if (hourly.length === 0) {
    return "No forecast data is available for the requested window.";
  }

  const peakGust = Math.round(
    Math.max(...hourly.map((hour) => hour.wind_gust_kmh)),
  );
  const overnightMin = deriveOvernightMin(hourly);
  const rainy = deriveRainExpected(hourly);

  const clauses: string[] = [];
  clauses.push(rainy ? "Rainy" : "Mostly dry");
  clauses.push(`with gusts to ${peakGust} km/h`);
  if (overnightMin !== null) {
    clauses.push(`overnight low ${Math.round(overnightMin)}°C`);
  }

  // "Rainy with gusts to 65 km/h, overnight low 8°C"
  return `${clauses[0]} ${clauses[1]}${clauses[2] ? `, ${clauses[2]}` : ""}.`;
}

/**
 * Applies default window and variable selection to the raw tool input.
 * Exported only conceptually via {@link registerGetForecastTool}; kept here so
 * the defaulting policy lives next to the values it defaults.
 */
function resolveRequest(input: {
  lat: number;
  lon: number;
  start: string | undefined;
  end: string | undefined;
  variables: readonly ForecastVariable[] | undefined;
}): ResolvedRequest {
  const start = input.start ?? new Date().toISOString();
  const end =
    input.end ??
    new Date(
      Date.parse(start) + DEFAULT_WINDOW_DAYS * MILLISECONDS_PER_DAY,
    ).toISOString();

  return {
    lat: input.lat,
    lon: input.lon,
    start,
    end,
    variables:
      input.variables && input.variables.length > 0
        ? input.variables
        : DEFAULT_FORECAST_VARIABLES,
  };
}

/**
 * Registers the `get_forecast` tool on the given MCP server, bound to the
 * active fetcher.
 *
 * @param server the MCP server to register on.
 * @param fetcher the active forecast provider (chosen by the server wiring).
 */
export function registerGetForecastTool(
  server: McpServer,
  fetcher: ForecastFetcher,
): void {
  server.registerTool(
    "get_forecast",
    {
      title: "Get an hourly NZ weather forecast",
      description: GET_FORECAST_DESCRIPTION,
      inputSchema: getForecastInputShape,
      outputSchema: getForecastOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const result = await getForecast(fetcher, resolveRequest(input));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: toMessage(error) }],
          isError: true,
        };
      }
    },
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Forecast lookup failed.";
}
