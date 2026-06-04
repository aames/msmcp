/**
 * The `geocode` MCP tool: resolves an NZ place name to coordinates.
 *
 * This module separates three concerns:
 *  - the pure {@link geocode} function (testable without MCP),
 *  - the Zod input/output schemas (the wire contract), and
 *  - {@link registerGeocodeTool}, which wires the above onto an `McpServer`.
 *
 * Geocoding uses Nominatim (OpenStreetMap). Per Nominatim's usage policy we
 * must send a descriptive `User-Agent`; requests are constrained to New Zealand
 * (`countrycodes=nz`) because this server is intentionally NZ-only.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GeocodedLocation } from "../types.js";

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

/**
 * Identifies this application to Nominatim. Required by their usage policy;
 * anonymous or generic agents may be blocked.
 */
const NOMINATIM_USER_AGENT = "msmcp/1.0";

/**
 * Tool description shown to the model. This is the primary API: it must tell
 * the model exactly when to reach for the tool and what it gets back.
 */
const GEOCODE_DESCRIPTION = [
  "Resolve a New Zealand place name, suburb, or street address to latitude/longitude coordinates.",
  "This tool is NZ-only — it will not return results outside New Zealand.",
  "Call this FIRST whenever you have a location by name (e.g. \"Ponsonby\", \"Petone\", \"123 Lambton Quay\") rather than coordinates,",
  "then pass the returned lat/lon to get_forecast.",
  "Returns the best-matching location's coordinates, display name, and region.",
].join(" ");

/** Input schema (Zod raw shape) for the tool. */
const geocodeInputShape = {
  place: z
    .string()
    .min(1, "place must not be empty")
    .describe(
      "An NZ place name, suburb, or address to resolve, e.g. \"Wellington\", \"Sumner\", or \"1 Queen Street, Auckland\".",
    ),
};

/** Output schema (Zod raw shape) mirroring {@link GeocodedLocation}. */
const geocodeOutputShape = {
  lat: z.number().describe("Latitude in decimal degrees (WGS84)."),
  lon: z.number().describe("Longitude in decimal degrees (WGS84)."),
  name: z.string().describe("Human-readable name of the matched location."),
  region: z.string().describe("Region or administrative area of the match."),
};

/**
 * Subset of a Nominatim `jsonv2` result that we depend on. `address` is
 * requested via `addressdetails=1` and used to derive a human-friendly region.
 */
interface NominatimResult {
  readonly lat: string;
  readonly lon: string;
  readonly display_name: string;
  readonly address?: {
    readonly state?: string;
    readonly region?: string;
    readonly county?: string;
    readonly city?: string;
  };
}

/**
 * Resolves a place name to a single best-match {@link GeocodedLocation}.
 *
 * @throws Error with a model-friendly message when no NZ match is found or the
 *   geocoding service is unavailable.
 */
export async function geocode(place: string): Promise<GeocodedLocation> {
  const results = await fetchNominatimResults(place);

  const best = results[0];
  if (best === undefined) {
    throw new Error(
      `No New Zealand location found for "${place}". Try a more specific name, or include a nearby town or region.`,
    );
  }

  const lat = Number.parseFloat(best.lat);
  const lon = Number.parseFloat(best.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error(
      `Geocoding returned an unreadable coordinate for "${place}".`,
    );
  }

  return {
    lat,
    lon,
    name: best.display_name,
    region: deriveRegion(best),
  };
}

/** Performs the Nominatim request and returns its parsed results. */
async function fetchNominatimResults(
  place: string,
): Promise<readonly NominatimResult[]> {
  const url = buildNominatimUrl(place);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": NOMINATIM_USER_AGENT },
    });
  } catch (cause) {
    throw new Error(
      `Could not reach the geocoding service. ${cause instanceof Error ? cause.message : "Unknown network error."}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Geocoding service returned HTTP ${response.status} (${response.statusText}).`,
    );
  }

  return (await response.json()) as NominatimResult[];
}

function buildNominatimUrl(place: string): string {
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set("q", place);
  url.searchParams.set("countrycodes", "nz");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "3");
  url.searchParams.set("addressdetails", "1");
  return url.toString();
}

/**
 * Picks the most useful "region" label from Nominatim's address breakdown,
 * preferring broad administrative areas over a city, and falling back to a
 * neutral label when none are present.
 */
function deriveRegion(result: NominatimResult): string {
  const address = result.address;
  return (
    address?.region ??
    address?.state ??
    address?.county ??
    address?.city ??
    "New Zealand"
  );
}

/**
 * Registers the `geocode` tool on the given MCP server.
 *
 * Errors thrown by {@link geocode} are caught and returned as an MCP error
 * result whose `content` is a plain, relayable string — never a raw stack
 * trace.
 */
export function registerGeocodeTool(server: McpServer): void {
  server.registerTool(
    "geocode",
    {
      title: "Geocode an NZ place name",
      description: GEOCODE_DESCRIPTION,
      inputSchema: geocodeInputShape,
      outputSchema: geocodeOutputShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ place }) => {
      try {
        const location = await geocode(place);
        return {
          content: [{ type: "text", text: JSON.stringify(location, null, 2) }],
          structuredContent: location as unknown as Record<string, unknown>,
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

/** Reduces an unknown thrown value to a clean, relayable message. */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Geocoding failed.";
}
