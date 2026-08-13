const SCHEMA = "flightproof/v1";
const ARRIVAL_TIME_DEFINITION = "GATE_IN";
const OAG_FLIGHT_INFO_URL = "https://api.oag.com/flight-instances/";
const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_ACTUAL_ARRIVAL_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const jsonHeaders = {
  ...corsHeaders,
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(body, status, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, "cache-control": cacheControl },
  });
}

function requireCode(value, minimum, maximum, label) {
  if (
    value.length < minimum ||
    value.length > maximum ||
    !/^[A-Z0-9]+$/.test(value)
  ) {
    throw new Error(`invalid_${label}`);
  }
  return value;
}

function requireUnix(value, label) {
  if (!/^[1-9]\d{0,11}$/.test(value)) {
    throw new Error(`invalid_${label}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid_${label}`);
  }
  return parsed;
}

function parseOagFlightNumber(value) {
  const match = /^([1-9]\d{0,3})([A-Z]?)$/.exec(value);
  if (!match) throw new Error("unsupported_oag_flight_number");

  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 9_999) {
    throw new Error("unsupported_oag_flight_number");
  }
  return { number, suffix: match[2] };
}

function rawPathname(requestUrl) {
  if (typeof requestUrl !== "string") throw new Error("invalid_path");
  const schemeEnd = requestUrl.indexOf("://");
  if (schemeEnd <= 0) throw new Error("invalid_path");
  const pathStart = requestUrl.indexOf("/", schemeEnd + 3);
  return pathStart === -1 ? "/" : requestUrl.slice(pathStart);
}

function hasRawDotSegment(pathname) {
  return pathname.split("/").some((segment) => {
    // RFC 3986 URL parsing treats literal and percent-encoded periods as dot
    // segments. Inspect the untouched text before constructing a URL, including
    // mixed spellings such as ".%2e" and "%2e.".
    const decodedPeriods = segment.replaceAll(/%2e/gi, ".");
    return decodedPeriods === "." || decodedPeriods === "..";
  });
}

export function parseFlightRequest(requestUrl) {
  if (typeof requestUrl !== "string") throw new Error("invalid_path");
  if (requestUrl.includes("?") || requestUrl.includes("#")) {
    throw new Error("invalid_query");
  }
  const rawPath = rawPathname(requestUrl);
  if (hasRawDotSegment(rawPath)) throw new Error("invalid_path");

  const url = new URL(requestUrl);
  // Reject every other form that URL parsing rewrites (for example backslashes)
  // instead of treating the normalized target as an alias for a valid flight.
  if (url.pathname !== rawPath) throw new Error("invalid_path");
  const parts = url.pathname.split("/");
  if (
    parts.length !== 9 ||
    parts[0] !== "" ||
    parts[1] !== "v1" ||
    parts[2] !== "flights"
  ) {
    throw new Error("invalid_path");
  }

  const carrier = requireCode(parts[3], 3, 3, "carrier_icao");
  const flightNumber = requireCode(parts[4], 1, 6, "flight_number");
  const oagFlightNumber = parseOagFlightNumber(flightNumber);
  const origin = requireCode(parts[5], 4, 4, "origin_icao");
  const destination = requireCode(parts[6], 4, 4, "destination_icao");
  const scheduledDepartureUnix = requireUnix(
    parts[7],
    "scheduled_departure_unix",
  );
  const scheduledArrivalUnix = requireUnix(
    parts[8],
    "scheduled_arrival_unix",
  );

  if (
    origin === destination ||
    scheduledArrivalUnix <= scheduledDepartureUnix ||
    scheduledArrivalUnix - scheduledDepartureUnix > 48 * 60 * 60
  ) {
    throw new Error("invalid_schedule");
  }

  return {
    carrier,
    flightNumber,
    oagFlightNumber,
    origin,
    destination,
    scheduledDepartureUnix,
    scheduledArrivalUnix,
    flightId:
      `${carrier}-${flightNumber}-${origin}-${destination}-` +
      `${scheduledDepartureUnix}-${scheduledArrivalUnix}`,
  };
}

function utcDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function buildOagUrl(requested) {
  // OAG's date filter is based on the flight's departure date. A UTC instant can
  // fall on the preceding/following local date, so search the three possible
  // dates and then require exact UTC schedule equality in the response.
  const departureDateRange =
    `${utcDate(requested.scheduledDepartureUnix - 24 * 60 * 60)}/` +
    `${utcDate(requested.scheduledDepartureUnix + 24 * 60 * 60)}`;
  const query = new URLSearchParams({
    CarrierCode: requested.carrier,
    FlightNumber: String(requested.oagFlightNumber.number),
    DepartureAirport: requested.origin,
    ArrivalAirport: requested.destination,
    DepartureDateTime: departureDateRange,
    CodeType: "ICAO",
    FlightType: "Scheduled",
    Codeshare: "Operating",
    Content: "Status",
    Limit: "100",
    version: "v2",
  });
  return `${OAG_FLIGHT_INFO_URL}?${query}`;
}

function strictString(value) {
  return typeof value === "string" ? value : "";
}

function exactUpper(value) {
  const text = strictString(value);
  return /^[A-Z0-9]+$/.test(text) ? text : "";
}

function scheduledUtcUnix(movement) {
  const date = strictString(movement?.date?.utc);
  const rawTime = strictString(movement?.time?.utc);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const timeMatch = /^(?:([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?|([01]\d|2[0-3])([0-5]\d)([0-5]\d)?)$/.exec(rawTime);
  if (!timeMatch) return null;
  const hours = timeMatch[1] ?? timeMatch[4];
  const minutes = timeMatch[2] ?? timeMatch[5];
  const seconds = timeMatch[3] ?? timeMatch[6] ?? "00";
  const iso = `${date}T${hours}:${minutes}:${seconds}.000Z`;
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) return null;
  if (new Date(milliseconds).toISOString() !== iso) return null;
  return Math.floor(milliseconds / 1000);
}

function actualUtcUnix(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(?:Z|\+00:00)$/.exec(value);
  if (!match) return null;
  const seconds = match[4] ?? "00";
  const fraction = (match[5] ?? "").padEnd(3, "0");
  const canonical = `${match[1]}T${match[2]}:${match[3]}:${seconds}.${fraction || "000"}Z`;
  const milliseconds = Date.parse(canonical);
  if (!Number.isFinite(milliseconds)) return null;
  if (new Date(milliseconds).toISOString() !== canonical) return null;
  return Math.floor(milliseconds / 1000);
}

function serviceSuffix(value) {
  if (value === undefined || value === null || value === "") return "";
  return typeof value === "string" && /^[A-Z]$/.test(value) ? value : null;
}

function candidateMatches(record, requested) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  if (exactUpper(record.carrier?.icao) !== requested.carrier) return false;
  if (
    !Number.isSafeInteger(record.flightNumber) ||
    record.flightNumber !== requested.oagFlightNumber.number
  ) {
    return false;
  }
  if (serviceSuffix(record.serviceSuffix) !== requested.oagFlightNumber.suffix) {
    return false;
  }
  if (record.flightType !== "Scheduled") return false;
  if (record.isOperating !== true) return false;
  if (exactUpper(record.departure?.airport?.icao) !== requested.origin) {
    return false;
  }
  if (exactUpper(record.arrival?.airport?.icao) !== requested.destination) {
    return false;
  }
  if (
    scheduledUtcUnix(record.departure) !==
    requested.scheduledDepartureUnix
  ) {
    return false;
  }
  return (
    scheduledUtcUnix(record.arrival) === requested.scheduledArrivalUnix
  );
}

function hasUnfetchedPage(payload, recordCount) {
  const paging = payload?.paging;
  if (!paging || typeof paging !== "object" || Array.isArray(paging)) {
    return true;
  }
  if (
    !Number.isSafeInteger(paging.limit) ||
    paging.limit < 1 ||
    paging.limit > 1_000 ||
    recordCount > paging.limit
  ) {
    return true;
  }
  if (
    paging.next !== undefined &&
    paging.next !== null &&
    (typeof paging.next !== "string" || paging.next.trim() !== "")
  ) {
    return true;
  }
  if (
    !Number.isSafeInteger(paging.totalPages) ||
    paging.totalPages < 0 ||
    paging.totalPages > 1
  ) {
    return true;
  }
  if (recordCount > 0 && paging.totalPages !== 1) return true;
  if (
    !Number.isSafeInteger(paging.totalCount) ||
    paging.totalCount < 0 ||
    paging.totalCount !== recordCount
  ) {
    return true;
  }
  return false;
}

function providerRecordId(record, detail) {
  const candidates = [
    detail?.statusKey,
    record?.statusKey,
    record?.scheduleInstanceKey,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      candidate.length >= 1 &&
      candidate.length <= 256 &&
      /^[A-Za-z0-9._:-]+$/.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function validActualArrival(actual, requested, nowUnix) {
  return (
    Number.isSafeInteger(actual) &&
    actual >= requested.scheduledDepartureUnix &&
    actual <=
      requested.scheduledArrivalUnix + MAX_ACTUAL_ARRIVAL_DELAY_SECONDS &&
    actual <= nowUnix + MAX_CLOCK_SKEW_SECONDS
  );
}

export function normalizeOag(
  payload,
  requested,
  nowUnix = Math.floor(Date.now() / 1000),
) {
  const records = Array.isArray(payload?.data) ? payload.data : null;
  if (!records || hasUnfetchedPage(payload, records.length)) return null;

  const candidates = records.filter((record) =>
    candidateMatches(record, requested),
  );
  // Duplicate exact matches are an identity ambiguity, not permission to pick
  // whichever provider record happened to be returned first.
  if (candidates.length !== 1) return null;

  const record = candidates[0];
  if (!Array.isArray(record.statusDetails) || record.statusDetails.length !== 1) {
    return null;
  }
  const detail = record.statusDetails[0];
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return null;
  }

  const recordId = providerRecordId(record, detail);
  if (!recordId) return null;

  const state = detail.state;
  const irregularOperation = detail.irregularOperationType;
  const isOrdinary =
    irregularOperation === undefined ||
    irregularOperation === null ||
    irregularOperation === "";
  const actualValue = detail.arrival?.actualTime?.inGate?.utc;
  const hasActualValue =
    actualValue !== undefined && actualValue !== null && actualValue !== "";
  const actualArrival = actualUtcUnix(actualValue);

  let status;
  let actualArrivalUnix = 0;
  if (state === "Canceled") {
    // A cancellation must be explicit and must not conflict with a diversion or
    // a reported gate-in. Estimated times do not become actual outcomes.
    if (!isOrdinary || hasActualValue) return null;
    status = "CANCELLED";
  } else if (state === "InGate" && irregularOperation === "Diversion") {
    if (!validActualArrival(actualArrival, requested, nowUnix)) return null;
    status = "DIVERTED";
    actualArrivalUnix = actualArrival;
  } else if (state === "InGate" && isOrdinary) {
    if (!validActualArrival(actualArrival, requested, nowUnix)) return null;
    status = "ARRIVED";
    actualArrivalUnix = actualArrival;
  } else {
    // Scheduled/OutGate/InAir/Landed, recoveries, estimates, and unknown states
    // are deliberately non-final.
    return null;
  }

  return {
    schema: SCHEMA,
    flight_id: requested.flightId,
    status,
    scheduled_arrival_unix: requested.scheduledArrivalUnix,
    actual_arrival_unix: actualArrivalUnix,
    arrival_time_definition: ARRIVAL_TIME_DEFINITION,
    cancelled: status === "CANCELLED",
    diverted: status === "DIVERTED",
    provider_record_id: recordId,
    observed_at_unix: nowUnix,
    final: true,
  };
}

async function readProviderPayload(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new Error("invalid_provider_response");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error("invalid_provider_response");
    }
    if (parsedLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("provider_response_too_large");
    }
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error("invalid_provider_response");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("invalid_provider_response");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw new Error("invalid_provider_response");
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        try {
          await reader.cancel("invalid_provider_response");
        } catch {
          // Preserve the controlled adapter error even if cancellation fails.
        }
        throw new Error("invalid_provider_response");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        try {
          await reader.cancel("provider_response_too_large");
        } catch {
          // The size result is known; cancellation is best-effort cleanup.
        }
        throw new Error("provider_response_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_provider_response");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid_provider_response");
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const subscriptionKey =
      typeof env?.OAG_SUBSCRIPTION_KEY === "string"
        ? env.OAG_SUBSCRIPTION_KEY.trim()
        : "";
    if (!subscriptionKey) {
      return jsonResponse({ error: "adapter_not_configured" }, 503);
    }

    let requested;
    try {
      requested = parseFlightRequest(request.url);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : "invalid_request" },
        400,
      );
    }

    let providerResponse;
    try {
      providerResponse = await fetch(buildOagUrl(requested), {
        method: "GET",
        headers: {
          accept: "application/json",
          "Subscription-Key": subscriptionKey,
        },
        redirect: "error",
      });
    } catch {
      return jsonResponse({ error: "provider_unavailable" }, 503);
    }

    if (!providerResponse.ok) {
      return jsonResponse(
        { error: "provider_error", provider_status: providerResponse.status },
        502,
      );
    }

    let payload;
    try {
      payload = await readProviderPayload(providerResponse);
    } catch (error) {
      const code =
        error instanceof Error &&
        error.message === "provider_response_too_large"
          ? error.message
          : "invalid_provider_response";
      return jsonResponse({ error: code }, 502);
    }

    const normalized = normalizeOag(payload, requested);
    if (!normalized) {
      return jsonResponse({ error: "final_outcome_not_available" }, 409);
    }
    // OAG can correct a previously published status. Do not let an intermediary
    // freeze a normalized result before validators independently observe it.
    return jsonResponse(normalized, 200);
  },
};
