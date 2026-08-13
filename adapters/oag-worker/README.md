# FlightProof OAG reference adapter

This Cloudflare Worker is a second, independently operated flight-data adapter for FlightProof. It converts a narrowly matched OAG Flight Info API v2 record into the public `flightproof/v1` evidence schema. It never accepts provider URLs or credentials from callers.

This is a reference implementation, not authorization to redistribute OAG data. Review the licensing section before deploying it anywhere public.

## Public route

```text
GET /v1/flights/{carrier_icao}/{flight_number}/{origin_icao}/{destination_icao}/{scheduled_departure_unix}/{scheduled_arrival_unix}
```

Example:

```text
GET /v1/flights/BAW/75/EGLL/DNMM/1781268000/1781298600
```

All carrier/airport codes and any service suffix must be uppercase. `flight_number` must be the canonical integer representation from 1 to 9999, with an optional one-letter OAG service suffix; leading-zero aliases are rejected. Query strings, fragments, trailing slashes, repeated slashes, backslash rewrites, and literal or percent-encoded `.`/`..` path segments are rejected so each flight has one public request target. The response is intentionally minimal:

```json
{
  "schema": "flightproof/v1",
  "flight_id": "BAW-75-EGLL-DNMM-1781268000-1781298600",
  "status": "ARRIVED",
  "scheduled_arrival_unix": 1781298600,
  "actual_arrival_unix": 1781302500,
  "arrival_time_definition": "GATE_IN",
  "cancelled": false,
  "diverted": false,
  "provider_record_id": "<OAG status or schedule key>",
  "observed_at_unix": 1781302600,
  "final": true
}
```

The adapter queries OAG with `CodeType=ICAO`, `FlightType=Scheduled`, `Codeshare=Operating`, `Content=Status`, and API `version=v2`. It then requires `isOperating === true` and exact equality for carrier, flight number and suffix, scheduled route, scheduled departure UTC, and scheduled arrival UTC. A missing, null, or non-boolean operating flag fails closed.

Finality is deliberately conservative:

- `ARRIVED` requires OAG state `InGate` and `statusDetails[0].arrival.actualTime.inGate.utc`.
- `CANCELLED` requires the explicit OAG state `Canceled` and no contradictory diversion or gate-in.
- `DIVERTED` requires `irregularOperationType=Diversion`, state `InGate`, and an actual in-gate time.
- Estimated in-gate, actual on-ground, `Landed`, recovery legs, unknown states, duplicate exact matches, multiple status details, and incomplete pagination all return HTTP `409 final_outcome_not_available`.

The Worker reads upstream bodies as a bounded stream and cancels once they exceed 2,000,000 bytes. It rejects malformed/non-JSON responses, does not echo OAG error bodies, permits only `GET`/`OPTIONS`, and returns CORS headers because GenLayer validators must be able to read the normalized endpoint. Every response, including successful final evidence, uses `Cache-Control: no-store`: OAG may correct status data, so an intermediary must not freeze an earlier normalized result.

## Configuration and deployment

Use Node.js 20 or newer.

```bash
npm test
npx wrangler secret put OAG_SUBSCRIPTION_KEY
npm run deploy
```

For local development, put `OAG_SUBSCRIPTION_KEY=...` in an untracked `.dev.vars` file or inject it through Wrangler. Never commit the key. The Worker sends it only in OAG's `Subscription-Key` request header, sets redirect handling to `error`, and never places the key in the public URL or response.

End users and contract callers do not need OAG credentials. The adapter operator does: a project-owned OAG subscription key and an appropriate production license are mandatory.

## Public proxy abuse and quota controls

This endpoint is intentionally unauthenticated for independent GenLayer validators, but every request can spend quota against a paid OAG key. This reference Worker does not include a distributed quota ledger. Before assigning it a public production hostname:

- Enable [Cloudflare incoming URL normalization](https://developers.cloudflare.com/rules/normalization/how-it-works/) and create a WAF custom rule on `raw.http.request.uri.path` that allows only the exact canonical route grammar above, with an empty query. Explicitly block raw literal/mixed/percent-encoded dot segments and percent escapes. Use the [raw field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/raw.http.request.uri.path/) rather than only `http.request.uri.path`, which may already be normalized.
- Create a [Cloudflare WAF rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) scoped to this hostname, the canonical raw `/v1/flights/` route, an empty query, and `GET`. Do not give aliases separate rate-limit buckets. Start conservatively, return `429`, and tune from observed validator traffic; validators may use multiple IPs, so an IP-only rule is an abuse brake rather than a complete budget control.
- Configure OAG quota/billing alerts and Cloudflare traffic alerts. Log counts by status and watch provider `429`/quota responses, request spikes, and repeated flight IDs. Never log `Subscription-Key`.
- Add an account-wide request budget or circuit breaker before launch if an unexpected bill is material. A Cloudflare Durable Object can enforce an atomic global allowance and short per-flight retry interval; fail closed when the allowance is exhausted. Do not use KV alone for a strict counter because updates are eventually consistent.
- Keep Cloudflare DDoS/WAF protections enabled and restrict the Worker route to its dedicated hostname. Do not add a provider-URL passthrough or general-purpose proxy route.
- If signed access is introduced, confirm every GenLayer validator can construct and verify it deterministically. Never embed a shared OAG or proxy secret in the contract.

`no-store` is deliberate despite its quota cost. Rate limiting and an explicit request budget should control spend without caching a provider result that OAG may later correct.

### Raw-path limitation at the Worker boundary

The adapter checks the URL string it receives before calling JavaScript's `URL` parser. However, the Fetch API and Cloudflare's HTTP/URL processing can remove dot segments before `request.url` reaches Worker code; after that happens, the original spelling cannot be reconstructed inside the Worker. Cloudflare also notes that even its `raw.http.request.uri.path` field may receive basic HTTP-server normalization.

Therefore the Worker check is defense in depth, not the sole control. The production deployment must enforce and rate-limit the canonical grammar at the earliest available Cloudflare WAF phase using raw fields, enable incoming URL normalization consistently, and verify the deployed edge with literal and encoded dot-segment probes sent without client-side path normalization. Do not launch the paid-key proxy if the selected Cloudflare plan/configuration cannot make those aliases share one rejection and rate-limit policy.

## OAG fields and operating window

This implementation follows OAG's current Flight Info API v2 documentation:

- [OAG Developer Portal and v2 quickstart](https://developers.oag.com/)
- [Flight Info API migration guide, endpoint, parameters, response envelope, and field mapping](https://knowledge.oag.com/docs/flight-info-api-migration-fvxml)
- [OAG status-field definitions](https://knowledge.oag.com/docs/flight-info-alerts-event-samples-status-field-definitions)
- [OAG diversion/recovery behavior](https://knowledge.oag.com/docs/q2-2024-release-notes-flight-info-api)

OAG advertises live flight status coverage from 48 hours before departure through 24 hours after arrival. Resolve while the licensed product still exposes the instance, or obtain historical-status rights from OAG; do not assume this adapter creates historical access.

## Licensing and public-output warning

OAG's public [Flight Info API Evaluation License Agreement](https://www.oag.com/flight-info-api-evaluation-license-agreement) describes the trial as a 14-day, internal-evaluation license and restricts transmitting data to third parties, derivative works, and secondary databases. A public validator endpoint and permanent on-chain result are not merely internal evaluation.

**Do not publicly deploy this adapter, expose its normalized responses, or persist OAG-derived results on-chain under trial/evaluation terms.** Before production, obtain written commercial terms that explicitly permit the intended minimal public output, validator access and caching, permanent on-chain storage, and the intended insurance/refund/passenger-rights use case. Confirm retention and attribution requirements with OAG as well.

The open CORS policy and `no-store` response policy are technical choices of this reference design; they do not grant redistribution rights. If the commercial license does not permit public normalized evidence, this adapter cannot be used as a FlightProof validator source without a different OAG-approved delivery architecture.
