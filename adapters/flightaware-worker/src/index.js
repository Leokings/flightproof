const SCHEMA = "flightproof/v1";
const ARRIVAL_TIME_DEFINITION = "GATE_IN";
const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_ACTUAL_ARRIVAL_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

function jsonResponse(body, status, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, "cache-control": cacheControl },
  });
}

function requireCode(value, minimum, maximum, label) {
  if (value !== value.trim() || value !== value.toUpperCase()) {
    throw new Error(`noncanonical_${label}`);
  }
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

function requireFlightNumber(value) {
  const normalized = requireCode(value, 1, 6, "flight_number");
  if (normalized.length > 1 && normalized.startsWith("0")) {
    throw new Error("noncanonical_flight_number");
  }
  return normalized;
}

function utcUnix(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?(?:Z|\+00:00)$/.exec(value);
  if (!match) return null;
  const seconds = match[4] ?? "00";
  const fraction = (match[5] ?? "").padEnd(3, "0");
  const canonical =
    `${match[1]}T${match[2]}:${match[3]}:${seconds}.` +
    `${fraction || "000"}Z`;
  const milliseconds = Date.parse(canonical);
  if (!Number.isFinite(milliseconds)) return null;
  if (new Date(milliseconds).toISOString() !== canonical) return null;
  return Math.floor(milliseconds / 1000);
}

function airportCode(value) {
  if (typeof value === "string") return value.toUpperCase();
  if (!value || typeof value !== "object") return "";
  const code = value.code_icao ?? value.code ?? value.icao;
  return typeof code === "string" ? code.toUpperCase() : "";
}

export function parseFlightRequest(requestUrl) {
  const rawUrl = String(requestUrl);
  if (rawUrl.includes("?") || rawUrl.includes("#") || rawUrl.includes("\\")) {
    throw new Error("invalid_path");
  }
  const schemeEnd = rawUrl.indexOf("://");
  const pathStart = rawUrl.indexOf("/", schemeEnd + 3);
  if (schemeEnd <= 0 || pathStart < 0) {
    throw new Error("invalid_path");
  }
  const rawPath = rawUrl.slice(pathStart);
  const rawParts = rawPath.split("/");
  for (const rawPart of rawParts) {
    const decodedDots = rawPart.replace(/%2e/gi, ".");
    if (decodedDots === "." || decodedDots === "..") {
      throw new Error("invalid_path");
    }
  }

  const url = new URL(rawUrl);
  if (url.pathname !== rawPath) {
    throw new Error("invalid_path");
  }
  const parts = rawParts;
  if (
    parts.length !== 9 ||
    parts[0] !== "" ||
    parts[1] !== "v1" ||
    parts[2] !== "flights"
  ) {
    throw new Error("invalid_path");
  }

  const carrier = requireCode(parts[3], 3, 3, "carrier_icao");
  const flightNumber = requireFlightNumber(parts[4]);
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
    origin,
    destination,
    scheduledDepartureUnix,
    scheduledArrivalUnix,
    flightId:
      `${carrier}-${flightNumber}-${origin}-${destination}-` +
      `${scheduledDepartureUnix}-${scheduledArrivalUnix}`,
  };
}

function candidateMatches(record, requested) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const expectedIdent = `${requested.carrier}${requested.flightNumber}`;
  const identValue = record.ident_icao ?? record.ident;
  const ident =
    typeof identValue === "string" ? identValue.toUpperCase() : "";
  if (ident !== expectedIdent) return false;
  if (airportCode(record.origin) !== requested.origin) return false;
  if (airportCode(record.destination) !== requested.destination) return false;

  const scheduledOut = utcUnix(record.scheduled_out);
  const scheduledIn = utcUnix(record.scheduled_in);
  return (
    scheduledOut === requested.scheduledDepartureUnix &&
    scheduledIn === requested.scheduledArrivalUnix
  );
}

function providerRecordId(record) {
  const value = record?.fa_flight_id;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    return null;
  }
  return value;
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

function hasCompletePagination(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  if (
    !Object.hasOwn(payload, "num_pages") ||
    !Number.isSafeInteger(payload.num_pages) ||
    payload.num_pages < 1 ||
    payload.num_pages > 2 ||
    !Object.hasOwn(payload, "links")
  ) {
    return false;
  }
  if (payload.links === null) return true;
  if (
    typeof payload.links !== "object" ||
    Array.isArray(payload.links) ||
    !Object.hasOwn(payload.links, "next")
  ) {
    return false;
  }
  return payload.links.next === null;
}

export function normalizeFlightAware(
  payload,
  requested,
  nowUnix = Math.floor(Date.now() / 1000),
) {
  const flights = Array.isArray(payload?.flights) ? payload.flights : null;
  if (!flights || !hasCompletePagination(payload)) return null;
  const candidates = flights.filter((record) =>
    candidateMatches(record, requested),
  );
  // An exact duplicate is an identity ambiguity, not permission to select the
  // provider's first/closest result.
  if (candidates.length !== 1) return null;

  const record = candidates[0];
  if (
    typeof record.cancelled !== "boolean" ||
    typeof record.diverted !== "boolean"
  ) {
    return null;
  }
  const recordId = providerRecordId(record);
  if (!recordId) return null;

  let status;
  let actualArrivalUnix = 0;
  if (record.cancelled === true) {
    const actualAbsent =
      record.actual_in === undefined || record.actual_in === null;
    if (record.diverted !== false || !actualAbsent) return null;
    status = "CANCELLED";
  } else if (record.cancelled === false) {
    const actualArrival = utcUnix(record.actual_in);
    if (!validActualArrival(actualArrival, requested, nowUnix)) return null;
    actualArrivalUnix = actualArrival;
    status = record.diverted === true ? "DIVERTED" : "ARRIVED";
  } else {
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

export function buildFlightAwareUrl(requested) {
  const start = new Date(
    (requested.scheduledDepartureUnix - 12 * 60 * 60) * 1000,
  ).toISOString();
  const end = new Date(
    (requested.scheduledDepartureUnix + 36 * 60 * 60) * 1000,
  ).toISOString();
  const ident = encodeURIComponent(`${requested.carrier}${requested.flightNumber}`);
  const query = new URLSearchParams({ start, end, max_pages: "2" });
  return `https://aeroapi.flightaware.com/aeroapi/flights/${ident}?${query}`;
}

async function readCappedBytes(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    total += chunk.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the deterministic size error if cancellation itself fails.
      }
      throw new Error("provider_response_too_large");
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

  const bytes = await readCappedBytes(response);
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
      return new Response(null, { status: 204, headers: jsonHeaders });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const apiKey =
      typeof env?.FLIGHTAWARE_API_KEY === "string"
        ? env.FLIGHTAWARE_API_KEY.trim()
        : "";
    if (!apiKey) {
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
      providerResponse = await fetch(buildFlightAwareUrl(requested), {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-apikey": apiKey,
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

    const normalized = normalizeFlightAware(payload, requested);
    if (!normalized) {
      return jsonResponse({ error: "final_outcome_not_available" }, 409);
    }
    return jsonResponse(normalized, 200);
  },
};
