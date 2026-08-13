import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildFlightAwareUrl,
  normalizeFlightAware,
  parseFlightRequest,
} from "../src/index.js";

const departure = 1_781_268_000;
const arrival = 1_781_298_600;
const now = arrival + 3 * 24 * 60 * 60;
const requestUrl =
  `https://adapter.example/v1/flights/BAW/75/EGLL/DNMM/` +
  `${departure}/${arrival}`;
const requested = parseFlightRequest(requestUrl);

function recordFor(scheduledDeparture, scheduledArrival, change) {
  const value = {
    ident_icao: "BAW75",
    fa_flight_id: `BAW75-${scheduledDeparture}-schedule-1`,
    origin: { code_icao: "EGLL" },
    destination: { code_icao: "DNMM" },
    scheduled_out: new Date(scheduledDeparture * 1000).toISOString(),
    scheduled_in: new Date(scheduledArrival * 1000).toISOString(),
    actual_in: new Date((scheduledArrival + 65 * 60) * 1000).toISOString(),
    cancelled: false,
    diverted: false,
  };
  change?.(value);
  return value;
}

function record(change) {
  return recordFor(departure, arrival, change);
}

function payload(records = [record()], overrides = {}) {
  return { links: null, num_pages: 1, flights: records, ...overrides };
}

function jsonProviderResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
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

async function callWorker(
  url = requestUrl,
  env = { FLIGHTAWARE_API_KEY: "test-key" },
) {
  return worker.fetch(new Request(url), env);
}

async function callWorkerWithRawUrl(
  url,
  env = { FLIGHTAWARE_API_KEY: "test-key" },
) {
  return worker.fetch({ method: "GET", url }, env);
}

test("parses a canonical FlightProof request", () => {
  const parsed = parseFlightRequest(requestUrl);
  assert.equal(parsed.flightId, `BAW-75-EGLL-DNMM-${departure}-${arrival}`);
});

test("rejects query strings, repeated slashes, trailing slashes, and aliases", () => {
  const invalidUrls = [
    `${requestUrl}?page=2`,
    `${requestUrl}?`,
    `${requestUrl}#fragment`,
    `${requestUrl}/`,
    requestUrl.replace("/v1/flights/", "/v1//flights/"),
    requestUrl.replace("/EGLL/", "/XXXX/../EGLL/"),
    requestUrl.replace("/EGLL/", "/XXXX/%2e%2e/EGLL/"),
    requestUrl.replace("/EGLL/", "/XXXX/%2E./EGLL/"),
    requestUrl.replace("/BAW/", "/baw/"),
    requestUrl.replace("/EGLL/", "/egll/"),
    requestUrl.replace(`/${departure}/`, `/0${departure}/`),
    requestUrl.replace(`/${arrival}`, `/0${arrival}`),
  ];
  for (const url of invalidUrls) {
    assert.throws(() => parseFlightRequest(url));
  }
  assert.throws(
    () => parseFlightRequest(requestUrl.replace("/75/", "/075/")),
    /noncanonical_flight_number/,
  );
  assert.throws(
    () => parseFlightRequest(requestUrl.replace("/75/", "/00075A/")),
    /noncanonical_flight_number/,
  );
});

test("rejects malformed codes and schedules", () => {
  assert.throws(
    () => parseFlightRequest("https://adapter.example/v1/flights/BA/1/X/Y/1/2"),
    /invalid_carrier_icao/,
  );
  assert.throws(
    () =>
      parseFlightRequest(
        `https://adapter.example/v1/flights/BAW/75/EGLL/EGLL/${departure}/${arrival}`,
      ),
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

test("builds a bounded FlightAware request for the exact identifier", () => {
  const url = new URL(buildFlightAwareUrl(requested));
  assert.equal(url.origin, "https://aeroapi.flightaware.com");
  assert.equal(url.pathname, "/aeroapi/flights/BAW75");
  assert.equal(url.searchParams.get("max_pages"), "2");
  assert.equal(
    url.searchParams.get("start"),
    new Date((departure - 12 * 60 * 60) * 1000).toISOString(),
  );
  assert.equal(
    url.searchParams.get("end"),
    new Date((departure + 36 * 60 * 60) * 1000).toISOString(),
  );
});

test("requires exact identity, route, departure, and arrival schedule", () => {
  const mismatches = [
    (value) => {
      value.ident_icao = "VIR75";
    },
    (value) => {
      value.ident_icao = 75;
    },
    (value) => {
      value.origin.code_icao = "EGKK";
    },
    (value) => {
      value.destination.code_icao = "DGAA";
    },
    (value) => {
      value.scheduled_out = new Date((departure + 1) * 1000).toISOString();
    },
    (value) => {
      value.scheduled_in = new Date((arrival - 1) * 1000).toISOString();
    },
    (value) => {
      value.scheduled_out = "2026-02-30T18:25:00Z";
    },
  ];

  for (const mutate of mismatches) {
    assert.equal(normalizeFlightAware(payload([record(mutate)]), requested, now), null);
  }
});

test("fails closed unless exactly one schedule record matches", () => {
  assert.equal(normalizeFlightAware(payload([]), requested, now), null);
  assert.equal(
    normalizeFlightAware(payload([record(), record()]), requested, now),
    null,
  );

  const unrelated = record((value) => {
    value.ident_icao = "VIR75";
  });
  assert.equal(
    normalizeFlightAware(payload([unrelated, record()]), requested, now)
      ?.status,
    "ARRIVED",
  );
});

test("requires complete and well-shaped AeroAPI pagination", () => {
  assert.equal(normalizeFlightAware(payload(), requested, now)?.status, "ARRIVED");
  assert.equal(
    normalizeFlightAware(
      payload([record()], { links: { next: null }, num_pages: 2 }),
      requested,
      now,
    )?.status,
    "ARRIVED",
  );

  const malformed = [
    { links: { next: "/aeroapi/flights/BAW75?cursor=opaque" } },
    { links: { next: "" } },
    { links: {} },
    { links: [] },
    { links: "none" },
    { num_pages: 0 },
    { num_pages: 3 },
    { num_pages: "1" },
  ];
  for (const overrides of malformed) {
    assert.equal(
      normalizeFlightAware(payload([record()], overrides), requested, now),
      null,
    );
  }

  const missingLinks = payload();
  delete missingLinks.links;
  assert.equal(normalizeFlightAware(missingLinks, requested, now), null);
  const missingPages = payload();
  delete missingPages.num_pages;
  assert.equal(normalizeFlightAware(missingPages, requested, now), null);
});

test("normalizes one final gate-in arrival", () => {
  const result = normalizeFlightAware(payload(), requested, now);
  assert.deepEqual(result, {
    schema: "flightproof/v1",
    flight_id: requested.flightId,
    status: "ARRIVED",
    scheduled_arrival_unix: arrival,
    actual_arrival_unix: arrival + 65 * 60,
    arrival_time_definition: "GATE_IN",
    cancelled: false,
    diverted: false,
    provider_record_id: "BAW75-1781268000-schedule-1",
    observed_at_unix: now,
    final: true,
  });
});

test("normalizes only an explicit non-diverted cancellation with no actual_in", () => {
  const cancelled = record((value) => {
    value.cancelled = true;
    value.actual_in = null;
  });
  assert.equal(
    normalizeFlightAware(payload([cancelled]), requested, now)?.status,
    "CANCELLED",
  );

  const withoutProperty = record((value) => {
    value.cancelled = true;
    delete value.actual_in;
  });
  assert.equal(
    normalizeFlightAware(payload([withoutProperty]), requested, now)?.status,
    "CANCELLED",
  );

  const conflicts = [
    (value) => {
      value.cancelled = true;
      value.diverted = true;
      value.actual_in = null;
    },
    (value) => {
      value.cancelled = true;
    },
    (value) => {
      value.cancelled = true;
      value.actual_in = "";
    },
  ];
  for (const mutate of conflicts) {
    assert.equal(
      normalizeFlightAware(payload([record(mutate)]), requested, now),
      null,
    );
  }
});

test("requires cancelled and diverted to be exact booleans", () => {
  const invalid = [
    (value) => {
      delete value.cancelled;
    },
    (value) => {
      delete value.diverted;
    },
    (value) => {
      value.cancelled = "false";
    },
    (value) => {
      value.diverted = 0;
    },
  ];
  for (const mutate of invalid) {
    assert.equal(
      normalizeFlightAware(payload([record(mutate)]), requested, now),
      null,
    );
  }
});

test("normalizes a diversion only after bounded actual gate-in", () => {
  const completed = record((value) => {
    value.diverted = true;
  });
  assert.equal(
    normalizeFlightAware(payload([completed]), requested, now)?.status,
    "DIVERTED",
  );

  const pending = record((value) => {
    value.diverted = true;
    value.actual_in = null;
  });
  assert.equal(normalizeFlightAware(payload([pending]), requested, now), null);
});

test("requires a nonempty stable fa_flight_id", () => {
  const invalidIds = [undefined, null, "", " ", "unstable/id", 75];
  for (const id of invalidIds) {
    const candidate = record((value) => {
      value.fa_flight_id = id;
    });
    assert.equal(
      normalizeFlightAware(payload([candidate]), requested, now),
      null,
    );
  }
});

test("bounds actual gate-in by schedule and transaction time", () => {
  const upper = arrival + 7 * 24 * 60 * 60;
  const validBounds = [departure, upper];
  for (const actual of validBounds) {
    const candidate = record((value) => {
      value.actual_in = new Date(actual * 1000).toISOString();
    });
    assert.equal(
      normalizeFlightAware(payload([candidate]), requested, upper)?.status,
      "ARRIVED",
    );
  }

  const invalid = [
    { actual: departure - 1, observed: now },
    { actual: upper + 1, observed: upper + 1 },
    { actual: now + 301, observed: now },
  ];
  for (const { actual, observed } of invalid) {
    const candidate = record((value) => {
      value.actual_in = new Date(actual * 1000).toISOString();
    });
    assert.equal(
      normalizeFlightAware(payload([candidate]), requested, observed),
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

      const post = await worker.fetch(
        new Request(requestUrl, { method: "POST" }),
        { FLIGHTAWARE_API_KEY: "test-key" },
      );
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("cache-control"), "no-store");
    },
  );
});

test("requires a nonblank server-side FlightAware key", async () => {
  await withMockFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    async () => {
      for (const env of [{}, { FLIGHTAWARE_API_KEY: "   " }]) {
        const response = await callWorker(requestUrl, env);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: "adapter_not_configured",
        });
      }
    },
  );
});

test("returns controlled 400 responses for noncanonical public routes", async () => {
  await withMockFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    async () => {
      for (const url of [
        `${requestUrl}?page=2`,
        `${requestUrl}?`,
        requestUrl.replace("/v1/flights/", "/v1//flights/"),
        requestUrl.replace("/75/", "/075/"),
        requestUrl.replace("/EGLL/", "/XXXX/../EGLL/"),
        requestUrl.replace("/EGLL/", "/XXXX/%2e%2e/EGLL/"),
        requestUrl.replace("/BAW/", "/baw/"),
        requestUrl.replace("/DNMM/", "/dnmm/"),
        requestUrl.replace(`/${departure}/`, `/0${departure}/`),
        requestUrl.replace(`/${arrival}`, `/0${arrival}`),
      ]) {
        // A request-like object preserves the raw URL so this test verifies the
        // Worker boundary before WHATWG URL dot-segment normalization.
        const response = await callWorkerWithRawUrl(url);
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    },
  );
});

test("never redirects x-apikey and returns successful evidence with no-store", async () => {
  await withMockFetch(
    async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      assert.equal(url.origin, "https://aeroapi.flightaware.com");
      assert.equal(url.pathname, "/aeroapi/flights/BAW75");
      assert.equal(headers.get("x-apikey"), "super-secret-key");
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(url.href.includes("super-secret-key"), false);
      return jsonProviderResponse(payload());
    },
    async () => {
      const response = await callWorker(requestUrl, {
        FLIGHTAWARE_API_KEY: " super-secret-key ",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.schema, "flightproof/v1");
      assert.equal(body.flight_id, requested.flightId);
      assert.equal(body.final, true);
      assert.equal("super-secret-key" in body, false);
    },
  );
});

test("maps provider network and HTTP failures without exposing provider bodies", async () => {
  await withMockFetch(
    async () => {
      throw new Error("network down or redirect rejected");
    },
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "provider_unavailable" });
    },
  );

  await withMockFetch(
    async () =>
      new Response('{"secret":"must not escape"}', {
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

test("enforces declared and streamed provider body byte limits", async () => {
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

  // The JavaScript string is below the cap in UTF-16 code units but exceeds it
  // on the wire in UTF-8, exercising the byte-based streaming boundary.
  await withMockFetch(
    async () =>
      new Response(`{"padding":"${"é".repeat(1_000_000)}"}`, {
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const response = await callWorker();
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "provider_response_too_large",
      });
    },
  );
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

test("worker rejects contradictory, out-of-bounds, duplicate, and id-less evidence", async () => {
  const contradictory = record((value) => {
    value.cancelled = true;
    value.diverted = true;
    value.actual_in = null;
  });
  const beforeDeparture = record((value) => {
    value.actual_in = new Date((departure - 1) * 1000).toISOString();
  });
  const afterSevenDays = record((value) => {
    value.actual_in = new Date(
      (arrival + 7 * 24 * 60 * 60 + 1) * 1000,
    ).toISOString();
  });
  const missingId = record((value) => {
    delete value.fa_flight_id;
  });
  const hostilePayloads = [
    payload([contradictory]),
    payload([beforeDeparture]),
    payload([afterSevenDays]),
    payload([record(), record()]),
    payload([missingId]),
  ];

  for (const providerPayload of hostilePayloads) {
    await withMockFetch(
      async () => jsonProviderResponse(providerPayload),
      async () => {
        const response = await callWorker();
        assert.equal(response.status, 409);
        assert.equal(response.headers.get("cache-control"), "no-store");
      },
    );
  }
});

test("worker rejects gate-in beyond the five-minute clock-skew allowance", async () => {
  const current = Math.floor(Date.now() / 1000);
  const dynamicDeparture = current - 2 * 60 * 60;
  const dynamicArrival = current - 60 * 60;
  const dynamicUrl =
    `https://adapter.example/v1/flights/BAW/75/EGLL/DNMM/` +
    `${dynamicDeparture}/${dynamicArrival}`;
  const future = recordFor(dynamicDeparture, dynamicArrival, (value) => {
    value.actual_in = new Date((current + 10 * 60) * 1000).toISOString();
  });

  await withMockFetch(
    async () => jsonProviderResponse(payload([future])),
    async () => {
      const response = await callWorker(dynamicUrl);
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
    },
  );
});

test("worker rejects incomplete or malformed AeroAPI pagination", async () => {
  const incomplete = payload([record()], {
    links: { next: "/aeroapi/flights/BAW75?cursor=opaque" },
  });
  const missingLinks = payload();
  delete missingLinks.links;
  const malformedPages = payload([record()], { num_pages: "1" });

  for (const providerPayload of [incomplete, missingLinks, malformedPages]) {
    await withMockFetch(
      async () => jsonProviderResponse(providerPayload),
      async () => {
        const response = await callWorker();
        assert.equal(response.status, 409);
        assert.equal(response.headers.get("cache-control"), "no-store");
      },
    );
  }
});

test("returns 409 and no-store until exactly one final outcome exists", async () => {
  const pending = record((value) => {
    value.actual_in = null;
  });
  await withMockFetch(
    async () => jsonProviderResponse(payload([pending])),
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
