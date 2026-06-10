/**
 * MetService implementation of {@link ForecastFetcher}.
 *
 * MetService (via the MetOcean point-time API) is NZ's national forecaster and
 * the intended production provider. Its response is column-oriented: a shared
 * `time` axis plus one parallel `data` array per requested variable, each with
 * a matching `noData` array flagging unreliable samples. The bulk of the work
 * here is zipping those columns into per-hour rows, converting units to this
 * server's normalised set, and dropping any hour MetService could not vouch for.
 *
 * ## Timezone
 *
 * The API answers in UTC, but the {@link RawHourly} contract requires
 * location-local timestamps — the tool layer derives the overnight band from
 * the hour digits in the string. We convert every timestamp to NZ local time
 * (`Pacific/Auckland`, DST-aware via `Intl`). Caveat: the Chatham Islands run
 * 45 minutes ahead of the mainland; their overnight band will be offset by
 * that much, which we accept for an NZ-mainland-focused server.
 *
 * Switching `FETCHER=metservice` is a configuration change, not a structural
 * one (Open/Closed): the tool layer depends only on {@link ForecastFetcher}.
 *
 * @see https://forecast-v2.metoceanapi.com — POST /point/time
 */

import type {
  ForecastFetcher,
  ForecastParams,
  RawForecast,
  RawHourly,
} from "./interface.js";

/** The MetOcean point time-series endpoint MetService data is served through. */
const METSERVICE_POINT_TIME_URL =
  "https://forecast-v2.metoceanapi.com/point/time";

/** Fixed sampling interval. The window is clipped upstream via `from`/`to`. */
const FORECAST_INTERVAL = "1h";

/**
 * A `noData` flag of `0` means the sample is GOOD; any other value (GAP, FILL,
 * ERROR_INTERNAL, INVALID_*) marks the sample as unreliable. We drop the entire
 * hour when any requested variable is flagged, rather than emit a partial row.
 */
const NO_DATA_GOOD = 0;

/**
 * The IANA zone all of mainland NZ shares. Used to convert the API's UTC
 * timestamps to the local wall-clock time the {@link RawHourly} contract
 * requires (see the module doc for the Chatham Islands caveat).
 */
const NZ_TIMEZONE = "Pacific/Auckland";

/**
 * Formats a UTC instant as NZ local date/time parts. `en-CA` gives ISO-style
 * numeric parts; `h23` keeps midnight as `00` rather than `24`. Module-level so
 * the (relatively expensive) formatter is built once per isolate, not per row.
 */
const NZ_LOCAL_TIME_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: NZ_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Absolute zero offset for converting Kelvin to degrees Celsius. */
const KELVIN_TO_CELSIUS_OFFSET = 273.15;

/** Conversion factor from metres per second to kilometres per hour. */
const METERS_PER_SECOND_TO_KMH = 3.6;

/**
 * The MetOcean API variable names this server consumes, expressed as a closed
 * tuple so the response type and the row builder stay in lockstep.
 */
const API_VARIABLES = [
  "air.temperature.at-2m",
  "precipitation.rate",
  "wind.speed.at-10m",
  "wind.speed.gust.at-10m",
  "cloud.cover",
] as const;

type ApiVariableName = (typeof API_VARIABLES)[number];

/**
 * A single variable column in the response: parallel `data` and `noData`
 * arrays, index-aligned with the shared `time` axis.
 */
interface ApiVariableColumn {
  readonly data?: readonly number[];
  readonly noData?: readonly number[];
}

/**
 * The slice of the MetOcean response we consume. `dimensions.time.data` is the
 * shared time axis; `variables[name]` holds each requested column.
 */
interface MetServiceResponse {
  readonly dimensions?: {
    readonly time?: { readonly data?: readonly string[] };
  };
  readonly variables?: Readonly<
    Partial<Record<ApiVariableName, ApiVariableColumn>>
  >;
}

/** Per-variable unit conversions into this server's normalised units. */
const CONVERTERS: Readonly<
  Record<ApiVariableName, (value: number) => number>
> = {
  "air.temperature.at-2m": (kelvin) => kelvin - KELVIN_TO_CELSIUS_OFFSET,
  "precipitation.rate": (mmPerHour) => mmPerHour,
  "wind.speed.at-10m": (mPerS) => mPerS * METERS_PER_SECOND_TO_KMH,
  "wind.speed.gust.at-10m": (mPerS) => mPerS * METERS_PER_SECOND_TO_KMH,
  "cloud.cover": (percent) => percent,
};

/**
 * A response column resolved and validated against the time axis: parallel
 * `data`/`noData` arrays known to match the axis length, plus the converter for
 * its unit. The row builder reads from these without re-checking shape.
 */
interface ResolvedColumn {
  readonly data: readonly number[];
  readonly noData: readonly number[];
  readonly convert: (value: number) => number;
}

/** The full set of resolved columns, keyed by API variable name. */
type ResolvedColumns = Readonly<Record<ApiVariableName, ResolvedColumn>>;

export class MetServiceFetcher implements ForecastFetcher {
  public readonly id = "metservice";

  /**
   * @param apiKey MetService (`x-api-key`) credential. Held privately and only
   *   ever sent as a request header — never echoed into error messages.
   */
  public constructor(private readonly apiKey: string) {}

  public async getForecast(params: ForecastParams): Promise<RawForecast> {
    const response = await this.requestForecast(params);
    const payload = (await response.json()) as MetServiceResponse;

    const times = payload.dimensions?.time?.data;
    if (times === undefined) {
      throw new Error("MetService response missing variable: dimensions.time");
    }

    const columns = this.resolveColumns(payload, times.length);
    const localTimes = times.map(toNzLocalTime);
    return { hourly: zipGoodHours(localTimes, columns) };
  }

  /**
   * Issues the POST request and fails loudly (with a clean, key-free message)
   * on a network error or any non-2xx status, so the caller never parses an
   * error body as data.
   */
  private async requestForecast(params: ForecastParams): Promise<Response> {
    const body = JSON.stringify(this.buildRequestBody(params));

    let response: Response;
    try {
      response = await fetch(METSERVICE_POINT_TIME_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body,
      });
    } catch (cause) {
      throw new Error(
        `Could not reach MetService forecast API. ${describeCause(cause)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `MetService API returned HTTP ${response.status}: ${response.statusText}`,
      );
    }
    return response;
  }

  private buildRequestBody(params: ForecastParams): unknown {
    return {
      points: [{ lat: params.lat, lon: params.lon }],
      // The RawHourly contract requires all five fields, so we always request
      // the full set rather than the (advisory) `params.variables` subset.
      variables: API_VARIABLES,
      time: {
        from: params.start,
        to: params.end,
        interval: FORECAST_INTERVAL,
      },
    };
  }

  /**
   * Resolves every requested variable against the response, validating that its
   * column is present and that its `data`/`noData` arrays align with the time
   * axis. Resolving every column up front means the row builder can index into
   * them freely without re-checking shape.
   */
  private resolveColumns(
    payload: MetServiceResponse,
    timeLength: number,
  ): ResolvedColumns {
    const resolved = {} as Record<ApiVariableName, ResolvedColumn>;

    for (const apiName of API_VARIABLES) {
      const column = payload.variables?.[apiName];
      if (
        column === undefined ||
        column.data === undefined ||
        column.noData === undefined
      ) {
        throw new Error(`MetService response missing variable: ${apiName}`);
      }
      if (
        column.data.length !== timeLength ||
        column.noData.length !== timeLength
      ) {
        throw new Error(
          `MetService response has inconsistent array lengths for variable: ${apiName}`,
        );
      }
      resolved[apiName] = {
        data: column.data,
        noData: column.noData,
        convert: CONVERTERS[apiName],
      };
    }

    return resolved;
  }
}

/**
 * Converts a UTC ISO timestamp from the API to NZ local time in the same
 * `YYYY-MM-DDTHH:mm` shape Open-Meteo produces, keeping the {@link RawHourly}
 * contract identical across providers.
 *
 * @throws Error (clean, relayable) if the timestamp cannot be parsed — failing
 *   loudly beats silently emitting an hour the overnight derivation would
 *   misclassify.
 */
function toNzLocalTime(utcIso: string): string {
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`MetService returned an unreadable timestamp: "${utcIso}".`);
  }

  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of NZ_LOCAL_TIME_FORMAT.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const { year, month, day, hour, minute } = parts;
  if (!year || !month || !day || !hour || !minute) {
    throw new Error("Could not convert a MetService timestamp to NZ local time.");
  }

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Zips the resolved columns into per-hour rows, skipping any hour where *any*
 * variable's `noData` flag is non-zero. Unit conversion is applied per column.
 */
function zipGoodHours(
  times: readonly string[],
  columns: ResolvedColumns,
): RawHourly[] {
  const temperature = columns["air.temperature.at-2m"];
  const precipitation = columns["precipitation.rate"];
  const windSpeed = columns["wind.speed.at-10m"];
  const windGust = columns["wind.speed.gust.at-10m"];
  const cloudCover = columns["cloud.cover"];

  const rows: RawHourly[] = [];

  for (let index = 0; index < times.length; index += 1) {
    if (!isHourGood(columns, index)) {
      continue;
    }

    // Non-null assertions are safe: `resolveColumns` guarantees every column's
    // `data` is the same length as `times`, so this index is always populated.
    rows.push({
      time: times[index]!,
      temperature_c: temperature.convert(temperature.data[index]!),
      precipitation_mm_per_hour: precipitation.convert(
        precipitation.data[index]!,
      ),
      wind_speed_kmh: windSpeed.convert(windSpeed.data[index]!),
      wind_gust_kmh: windGust.convert(windGust.data[index]!),
      cloud_cover_pct: cloudCover.convert(cloudCover.data[index]!),
    });
  }

  return rows;
}

/** True when every variable reports a GOOD sample at the given time index. */
function isHourGood(columns: ResolvedColumns, index: number): boolean {
  return API_VARIABLES.every(
    (apiName) => columns[apiName].noData[index] === NO_DATA_GOOD,
  );
}

/** Extracts a safe, message-only description from an unknown thrown value. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown network error.";
}
