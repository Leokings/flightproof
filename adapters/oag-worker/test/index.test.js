import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildOagUrl,
  normalizeOag,
  parseFlightRequest,
} from "../src/index.js";

const departure = 1_781_268_000;
const arrival = 1_781_298_600;
const now = arrival + 3 * 24 * 60 * 60;
const requestUrl =
  `https://adapter.example/v1/flights/BAW/75/EGLL/DNMM/` +
  `${departure}/${arrival}`;
const requested = parseFlightRequest(requestUrl);

function movement(unix, airport) {
  const iso = new Date(unix * 1000).toISOString();
  return {
    airport: { icao: airport },
    date: { utc: iso.slice(0, 10) },
    time: { utc: iso.slice(11, 19) },
  };
}

function oagRecord(change) {
  const value = {
    carrier: { icao: "BAW" },
    flightNumber: 75,
    serviceSuffix: "",
    flightType: "Scheduled",
    isOperating: true,
    departure: movement(departure, "EGLL"),
    arrival: movement(arrival, "DNMM"),
    scheduleInstanceKey: "schedule-key-75",
    statusDetails: [
      {
        statusKey: "status-key-75",
        state: "InGate",
        arrival: {
          actualTime: {
            inGate: {
              utc: new Date((arrival + 65 * 60) * 1000).toISOString(),
            },
          },
        },
      },
    ],
  };
  change?.(value);
  return value;
}

function oagPayload(records = [oagRecord()], paging = {}) {
  return {
    data: records,
    paging: {
      limit: 100,
      totalCount: records.length,
      totalPages: 1,
      next: null,
      ...paging,
    },
  };
}

function jsonProviderResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

async function withMockFetch(mockFetch, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function callWorker(env = { OAG_SUBSCRIPTION_KEY: "test-key" }) {
  return worker.fetch(new Request(requestUrl), env);
}

test("parses the canonical FlightProof route", () => {
  const parsed = parseFlightRequest(requestUrl);
  assert.equal(parsed.flightId, `BAW-75-EGLL-DNMM-${departure}-${arrival}`);
  assert.deepEqual(parsed.oagFlightNumber, { number: 75, suffix: "" });
});

test("parses OAG numeric flight numbers with an optional service suffix", () => {
  const parsed = parseFlightRequest(requestUrl.replace("/75/", "/75A/"));
  assert.equal(parsed.flightNumber, "75A");
  assert.deepEqual(parsed.oagFlightNumber, { number: 75, suffix: "A" });
});

test("rejects aliases, query strings, and noncanonical path forms", () => {
  const invalidUrls = [
    requestUrl.replace("/75/", "/0075/"),
    requestUrl.replace("/BAW/", "/baw/"),
    requestUrl.replace("/EGLL/", "/egll/"),
    requestUrl.replace("/BAW/75/", "/BAW//75/"),
    `${requestUrl}/`,
    `${requestUrl}?source=oag`,
    `${requestUrl}#fragment`,
    requestUrl.replace(`/${departure}/`, `/0${departure}/`),
  ];
  for (const url of invalidUrls) {
    assert.throws(() => parseFlightRequest(url));
  }
});

test("rejects literal and percent-encoded dot segments before URL parsing", () => {
  const rawAliases = [
    requestUrl.replace("/BAW/75/", "/BAW/./75/"),
    requestUrl.replace("/BAW/75/", "/BAW/discarded/../75/"),
    requestUrl.replace("/BAW/75/", "/BAW/%2e/75/"),
    requestUrl.replace("/BAW/75/", "/BAW/%2E/75/"),
    requestUrl.replace("/BAW/75/", "/BAW/discarded/%2e%2e/75/"),
    requestUrl.replace("/BAW/75/", "/BAW/discarded/.%2E/75/"),
    requestUrl.replace("/BAW/75/", "/BAW/discarded/%2e./75/"),
  ];
  for (const alias of rawAliases) {
    assert.throws(() => parseFlightRequest(alias), /invalid_path/);
  }
});

test("rejects malformed paths, codes, flight numbers, and schedules", () => {
  assert.throws(
    () => parseFlightRequest("https://adapter.example/v1/not-flights"),
    /invalid_path/,
  );
  assert.throws(
    () =>
      parseFlightRequest(
        `https://adapter.example/v1/flights/BA/75/EGLL/DNMM/${departure}/${arrival}`,
      ),
    /invalid_carrier_icao/,
  );
  assert.throws(
    () => parseFlightRequest(requestUrl.replace("/75/", "/AB75/")),
    /unsupported_oag_flight_number/,
  );
  assert.throws(
    () => parseFlightRequest(requestUrl.replace("/75/", "/0000/")),
    /unsupported_oag_flight_number/,
  );
  assert.throws(
    () => parseFlightRequest(requestUrl.replace("/DNMM/", "/EGLL/")),
    /invalid_schedule/,
  );
  assert.throws(
    () =>
      parseFlightRequest(
        requestUrl.replace(`/${arrival}`, `/${departure + 49 * 60 * 60}`),
      ),
    /invalid_schedule/,
  );
});

test("builds a narrow official OAG v2 operating-flight status query", () => {
  const url = new URL(buildOagUrl(requested));
  const previousDate = new Date((departure - 86_400) * 1000)
    .toISOString()
    .slice(0, 10);
  const nextDate = new Date((departure + 86_400) * 1000)
    .toISOString()
    .slice(0, 10);

  assert.equal(url.origin, "https://api.oag.com");
  assert.equal(url.pathname, "/flight-instances/");
  assert.equal(url.searchParams.get("CarrierCode"), "BAW");
  assert.equal(url.searchParams.get("FlightNumber"), "75");
  assert.equal(url.searchParams.get("DepartureAirport"), "EGLL");
  assert.equal(url.searchParams.get("ArrivalAirport"), "DNMM");
  assert.equal(
    url.searchParams.get("DepartureDateTime"),
    `${previousDate}/${nextDate}`,
  );
  assert.equal(url.searchParams.get("CodeType"), "ICAO");
  assert.equal(url.searchParams.get("FlightType"), "Scheduled");
  assert.equal(url.searchParams.get("Codeshare"), "Operating");
  assert.equal(url.searchParams.get("Content"), "Status");
  assert.equal(url.searchParams.get("version"), "v2");
});

test("normalizes a final actual gate-in arrival", () => {
  const result = normalizeOag(oagPayload(), requested, now);
  assert.deepEqual(result, {
    schema: "flightproof/v1",
    flight_id: requested.flightId,
    status: "ARRIVED",
    scheduled_arrival_unix: arrival,
    actual_arrival_unix: arrival + 65 * 60,
    arrival_time_definition: "GATE_IN",
    cancelled: false,
    diverted: false,
    provider_record_id: "status-key-75",
    observed_at_unix: now,
    final: true,
  });
});

test("accepts OAG scheduled UTC time with or without colons", () => {
  const compact = oagRecord((record) => {
    record.departure.time.utc = record.departure.time.utc.replaceAll(":", "");
    record.arrival.time.utc = record.arrival.time.utc.replaceAll(":", "");
  });
  assert.equal(normalizeOag(oagPayload([compact]), requested, now)?.status, "ARRIVED");
});

test("normalizes only an explicit, non-conflicting cancellation", () => {
  const cancelled = oagRecord((record) => {
    record.statusDetails[0] = {
      statusKey: "cancel-key-75",
      state: "Canceled",
      arrival: {
        estimatedTime: {
          inGate: { utc: new Date(arrival * 1000).toISOString() },
        },
      },
    };
  });
  const result = normalizeOag(oagPayload([cancelled]), requested, now);
  assert.equal(result?.status, "CANCELLED");
  assert.equal(result?.actual_arrival_unix, 0);
  assert.equal(result?.cancelled, true);

  const contradictoryActual = oagRecord((record) => {
    record.statusDetails[0].state = "Canceled";
  });
  assert.equal(
    normalizeOag(oagPayload([contradictoryActual]), requested, now),
    null,
  );

  const contradictoryDiversion = oagRecord((record) => {
    record.statusDetails[0].state = "Canceled";
    record.statusDetails[0].irregularOperationType = "Diversion";
    delete record.statusDetails[0].arrival;
  });
  assert.equal(
    normalizeOag(oagPayload([contradictoryDiversion]), requested, now),
    null,
  );
});

test("normalizes a diversion only after actual gate-in", () => {
  const completed = oagRecord((record) => {
    record.statusDetails[0].irregularOperationType = "Diversion";
    record.statusDetails[0].diversionType = "Unplanned";
    record.statusDetails[0].arrival.airport = { icao: "GMMN" };
  });
  const result = normalizeOag(oagPayload([completed]), requested, now);
  assert.equal(result?.status, "DIVERTED");
  assert.equal(result?.diverted, true);
  assert.equal(result?.actual_arrival_unix, arrival + 65 * 60);

  const landedOnly = oagRecord((record) => {
    record.statusDetails[0].state = "Landed";
    record.statusDetails[0].irregularOperationType = "Diversion";
    record.statusDetails[0].arrival.actualTime = {
      onGround: {
        utc: new Date((arrival + 30 * 60) * 1000).toISOString(),
      },
    };
  });
  assert.equal(normalizeOag(oagPayload([landedOnly]), requested, now), null);

  const inGateWithoutGateTime = oagRecord((record) => {
    record.statusDetails[0].irregularOperationType = "Diversion";
    delete record.statusDetails[0].arrival.actualTime.inGate;
  });
  assert.equal(
    normalizeOag(oagPayload([inGateWithoutGateTime]), requested, now),
    null,
  );
});

test("never promotes estimates, runway times, pending states, or recoveries", () => {
  const mutations = [
    (record) => {
      record.statusDetails[0].state = "Scheduled";
    },
    (record) => {
      record.statusDetails[0].state = "Landed";
    },
    (record) => {
      record.statusDetails[0].arrival = {
        estimatedTime: record.statusDetails[0].arrival.actualTime,
      };
    },
    (record) => {
      record.statusDetails[0].arrival.actualTime = {
        onGround: record.statusDetails[0].arrival.actualTime.inGate,
      };
    },
    (record) => {
      record.statusDetails[0].irregularOperationType = "Recovery";
    },
    (record) => {
      record.statusDetails[0].state = "Proposed";
    },
  ];

  for (const mutate of mutations) {
    const record = oagRecord(mutate);
    assert.equal(normalizeOag(oagPayload([record]), requested, now), null);
  }
});

test("requires exact carrier, flight, suffix, route, and both schedule instants", () => {
  const mismatches = [
    (record) => {
      record.carrier.icao = "VIR";
    },
    (record) => {
      record.flightNumber = 76;
    },
    (record) => {
      record.flightNumber = "75";
    },
    (record) => {
      record.serviceSuffix = "A";
    },
    (record) => {
      record.flightType = "Unscheduled";
    },
    (record) => {
      record.isOperating = false;
    },
    (record) => {
      delete record.isOperating;
    },
    (record) => {
      record.isOperating = null;
    },
    (record) => {
      record.isOperating = "true";
    },
    (record) => {
      record.departure.airport.icao = "EGKK";
    },
    (record) => {
      record.arrival.airport.icao = "DGAA";
    },
    (record) => {
      record.departure = movement(departure + 1, "EGLL");
    },
    (record) => {
      record.arrival = movement(arrival - 1, "DNMM");
    },
    (record) => {
      record.departure.date.utc = "2026-02-30";
    },
  ];

  for (const mutate of mismatches) {
    assert.equal(
      normalizeOag(oagPayload([oagRecord(mutate)]), requested, now),
      null,
    );
  }
});

test("matches a requested OAG service suffix exactly", () => {
  const suffixRequest = parseFlightRequest(requestUrl.replace("/75/", "/75A/"));
  const match = oagRecord((record) => {
    record.serviceSuffix = "A";
  });
  assert.equal(
    normalizeOag(oagPayload([match]), suffixRequest, now)?.status,
    "ARRIVED",
  );
});

test("fails closed on zero matches, duplicate exact matches, or pagination", () => {
  assert.equal(normalizeOag(oagPayload([]), requested, now), null);
  assert.equal(
    normalizeOag(oagPayload([oagRecord(), oagRecord()]), requested, now),
    null,
  );
  assert.equal(
    normalizeOag(
      oagPayload([oagRecord()], {
        totalCount: 2,
        totalPages: 2,
        next: "https://api.oag.com/flight-instances/?After=opaque",
      }),
      requested,
      now,
    ),
    null,
  );
  assert.equal(
    normalizeOag({ data: [oagRecord()] }, requested, now),
    null,
  );
});

test("rejects internally inconsistent pagination metadata", () => {
  assert.equal(
    normalizeOag(
      oagPayload([oagRecord()], { totalPages: 0 }),
      requested,
      now,
    ),
    null,
  );
  assert.equal(
    normalizeOag(oagPayload([oagRecord()], { limit: 0 }), requested, now),
    null,
  );
  assert.equal(
    normalizeOag(
      oagPayload([oagRecord()], { totalCount: 0 }),
      requested,
      now,
    ),
    null,
  );
});

test("requires one unambiguous status detail and a stable provider key", () => {
  const missing = oagRecord((record) => {
    delete record.statusDetails;
  });
  assert.equal(normalizeOag(oagPayload([missing]), requested, now), null);

  const duplicate = oagRecord((record) => {
    record.statusDetails.push({ ...record.statusDetails[0] });
  });
  assert.equal(normalizeOag(oagPayload([duplicate]), requested, now), null);

  const noKey = oagRecord((record) => {
    delete record.statusDetails[0].statusKey;
    delete record.scheduleInstanceKey;
  });
  assert.equal(normalizeOag(oagPayload([noKey]), requested, now), null);

  const scheduleKeyFallback = oagRecord((record) => {
    delete record.statusDetails[0].statusKey;
  });
  assert.equal(
    normalizeOag(oagPayload([scheduleKeyFallback]), requested, now)
      ?.provider_record_id,
    "schedule-key-75",
  );
});

test("rejects malformed, implausible, and future actual gate-in times", () => {
  const mutations = [
    (record) => {
      record.statusDetails[0].arrival.actualTime.inGate.utc =
        "2026-06-12T18:25:00";
    },
    (record) => {
      record.statusDetails[0].arrival.actualTime.inGate.utc = "not-a-date";
    },
    (record) => {
      record.statusDetails[0].arrival.actualTime.inGate.utc =
        "2026-02-30T18:25:00Z";
    },
    (record) => {
      record.statusDetails[0].arrival.actualTime.inGate.utc = new Date(
        (departure - 1) * 1000,
      ).toISOString();
    },
    (record) => {
      record.statusDetails[0].arrival.actualTime.inGate.utc = new Date(
        (arrival + 7 * 86_400 + 1) * 1000,
      ).toISOString();
    },
    (record) => {
      record.statusDetails[0].arrival.actualTime.inGate.utc = new Date(
        (now + 301) * 1000,
      ).toISOString();
    },
  ];

  for (const mutate of mutations) {
    assert.equal(
      normalizeOag(oagPayload([oagRecord(mutate)]), requested, now),
      null,
    );
  }
});

test("answers CORS preflight and rejects unsupported methods without fetching", async () => {
  await withMockFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    async () => {
      const options = await worker.fetch(
        new Request(requestUrl, { method: "OPTIONS" }),
        {},
      );
      assert.equal(options.status, 204);
      assert.equal(options.headers.get("access-control-allow-origin"), "*");
      assert.equal(
        options.headers.get("access-control-allow-methods"),
        "GET, OPTIONS",
      );

      const post = await worker.fetch(
        new Request(requestUrl, { method: "POST" }),
        { OAG_SUBSCRIPTION_KEY: "test-key" },
      );
      assert.equal(post.status, 405);
      assert.deepEqual(await post.json(), { error: "method_not_allowed" });
      assert.equal(post.headers.get("cache-control"), "no-store");
    },
  );
});

test("requires a server-side OAG subscription key", async () => {
  await withMockFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    async () => {
      const response = await callWorker({});
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "adapter_not_configured",
      });
    },
  );
});

test("returns a controlled 400 for invalid public routes", async () => {
  await withMockFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    async () => {
      const response = await worker.fetch(
        new Request("https://adapter.example/not-a-flight"),
        { OAG_SUBSCRIPTION_KEY: "test-key" },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_path" });
    },
  );
});

test("worker rejects a raw dot-segment target before provider fetch", async () => {
  const rawAlias = requestUrl.replace(
    "/BAW/75/",
    "/BAW/discarded/%2e%2e/75/",
  );
  await withMockFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    async () => {
      // A plain request-shaped object preserves the raw target for this unit
      // test. The Fetch Request constructor may normalize it before Worker code.
      const response = await worker.fetch(
        { method: "GET", url: rawAlias },
        { OAG_SUBSCRIPTION_KEY: "test-key" },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_path" });
    },
  );
});

test("keeps Subscription-Key in the provider header and returns public schema", async () => {
  await withMockFetch(
    async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      assert.equal(url.origin, "https://api.oag.com");
      assert.equal(url.searchParams.get("CarrierCode"), "BAW");
      assert.equal(headers.get("Subscription-Key"), "super-secret-key");
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(url.href.includes("super-secret-key"), false);
      return jsonProviderResponse(oagPayload());
    },
    async () => {
      const response = await callWorker({
        OAG_SUBSCRIPTION_KEY: " super-secret-key ",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(
        response.headers.get("cache-control"),
        "no-store",
      );
      const body = await response.json();
      assert.equal(body.schema, "flightproof/v1");
      assert.equal(body.flight_id, requested.flightId);
      assert.equal(body.status, "ARRIVED");
      assert.equal(body.arrival_time_definition, "GATE_IN");
      assert.equal(body.final, true);
      assert.equal("super-secret-key" in body, false);
    },
  );
});

test("maps provider network and HTTP failures without exposing a body", async () => {
  await withMockFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "provider_unavailable" });
    },
  );

  await withMockFetch(
    async () =>
      new Response('{"provider":"details must not escape"}', {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "provider_error",
        provider_status: 429,
      });
    },
  );
});

test("enforces declared and actual provider body byte limits", async () => {
  await withMockFetch(
    async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "2000001",
        },
      }),
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "provider_response_too_large",
      });
    },
  );

  let streamCancelled = false;
  await withMockFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1_500_000));
            controller.enqueue(new Uint8Array(600_000));
          },
          cancel() {
            streamCancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "provider_response_too_large",
      });
    },
  );
  assert.equal(streamCancelled, true);
});

test("rejects non-JSON, malformed JSON, invalid UTF-8, and bad lengths", async () => {
  const responses = [
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () =>
      new Response("{broken", {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "unknown",
        },
      }),
  ];

  for (const makeResponse of responses) {
    await withMockFetch(async () => makeResponse(), async () => {
      const response = await callWorker();
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "invalid_provider_response",
      });
    });
  }
});

test("returns 409 and no-store until one final outcome exists", async () => {
  const estimateOnly = oagRecord((record) => {
    record.statusDetails[0].state = "Landed";
    record.statusDetails[0].arrival = {
      estimatedTime: {
        inGate: { utc: new Date(arrival * 1000).toISOString() },
      },
    };
  });
  await withMockFetch(
    async () => jsonProviderResponse(oagPayload([estimateOnly])),
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: "final_outcome_not_available",
      });
    },
  );
});
