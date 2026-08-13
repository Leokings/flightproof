# FlightAware source adapter

This Cloudflare Worker converts FlightAware AeroAPI records into the strict
`flightproof/v1` JSON consumed by the Intelligent Contract. It keeps the
provider API key off-chain and returns HTTP 409 until the provider exposes an
explicit final cancellation or an actual **gate-in** (`actual_in`) timestamp.
Missing flights, estimates, touchdown-only times, and provider failures never
become final outcomes.

The adapter fails closed unless AeroAPI returns exactly one record whose
carrier, route, scheduled departure, and scheduled arrival exactly match the
registered FlightProof identity, and pagination proves that no result sets were
left unfetched. Public request codes must already be uppercase and timestamps
must be canonical decimal seconds without leading zeros. Successful evidence
is also returned with `Cache-Control: no-store`; callers must not rely on an
intermediary cache as a second source.

## Endpoint

```text
GET /v1/flights/{carrier_icao}/{flight_number}/{origin_icao}/{destination_icao}/{scheduled_departure_unix}/{scheduled_arrival_unix}
```

Example:

```text
https://adapter.example/v1/flights/BAW/75/EGLL/DNMM/1781268000/1781298600
```

## Run and deploy

```powershell
node --test
npx wrangler@4.113.0 secret put FLIGHTAWARE_API_KEY
npx wrangler@4.113.0 deploy
```

For quorum, deploy and configure at least one additional independently
operated adapter backed by a separate authoritative provider. Two paths on the
same host are not independent sources.

## Rate limits and abuse controls

Every successful request reaches FlightAware because evidence is deliberately
not cached. Before exposing the Worker publicly, enforce a per-client and
per-flight rate limit with Cloudflare WAF Rate Limiting rules or a Workers Rate
Limiting binding, and set a provider-budget alert. Choose limits below the
AeroAPI plan's sustained and burst quotas; return `429` before making the
provider request when a client exceeds them.

Rate Limiting bindings need an account-specific numeric `namespace_id`, so the
repository does not ship an unsafe placeholder as active configuration. Add a
binding like this to `wrangler.jsonc`, then call its `limit()` method before the
AeroAPI fetch:

```jsonc
"ratelimits": [
  {
    "name": "FLIGHT_LOOKUP_RATE_LIMITER",
    "namespace_id": "<account-unique-integer>",
    "simple": { "limit": 60, "period": 60 }
  }
]
```

Do not key a limit only by the public flight path: one abusive client could
otherwise consume the shared allowance for all users. Prefer a trusted client
identity or Cloudflare's verified request IP, and layer a global provider-budget
limit over it.

FlightAware access is licensed and usage-priced. Confirm that the chosen plan
permits your intended public adapter before deployment; do not expose or commit
the API key.
