# FlightProof architecture

## Trust boundary

- Calling contracts, Studio, or CLI clients own transaction submission and any
  non-authoritative presentation of the result.
- `FlightProof` owns flight registration, allowlisted source enforcement, independent validator retrieval, source agreement, canonical resolution storage, and deterministic rule evaluation.
- External source adapters own raw aviation facts. A source is never trusted merely because a caller supplied its response; validators fetch it independently over HTTPS.
- Consumer contracts own premiums, escrow, payout rules, recipients, and final value transfer. FlightProof intentionally holds no insurance funds.

## Resolution flow

1. A caller registers the immutable carrier, route, and scheduled timestamps.
2. A caller requests resolution using only the canonical `flight_id`.
3. The contract derives every evidence URL from its immutable source prefixes and
   the registered flight, then the GenLayer leader retrieves each URL and accepts
   only `flightproof/v1` final observations matching that registration.
4. Validators independently retrieve and aggregate the same sources.
5. Consensus compares the final status and bounded delay interval.
6. The agreed result is stored once and becomes immutable.
7. Any application can read the outcome or use the deterministic delay/cancellation evaluators.

Registration records the transaction time but deliberately does not persist a
passenger or caller address. Repeating the same canonical registration is
idempotent for every wallet. FlightProof is a fact registry, so it also supports
historical flights. Insurance and escrow consumers must separately prove that
their policy was created before departure.

The registering transaction is still public chain metadata and can reveal a
wallet's interest in an itinerary. Privacy-sensitive consumers should register
through a policy contract/relayer or reuse an existing shared registration,
rather than asking a passenger wallet to publish it directly.

## Why an interval is stored

Providers can disagree by a few minutes about gate-in time. Storing a leader's exact minute would create unsafe boundary payouts. FlightProof records lower and upper delay bounds expanded by a configured consensus drift:

- `TRUE`: the entire interval meets the threshold.
- `FALSE`: the entire interval is below the threshold.
- `INCONCLUSIVE`: the threshold crosses the interval.

## Source adapter schema

```json
{
  "schema": "flightproof/v1",
  "flight_id": "BAW-75-EGLL-DNMM-1781268000-1781298600",
  "status": "ARRIVED",
  "scheduled_arrival_unix": 1781298600,
  "actual_arrival_unix": 1781312160,
  "arrival_time_definition": "GATE_IN",
  "cancelled": false,
  "diverted": false,
  "provider_record_id": "source-record-id",
  "observed_at_unix": 1781313000,
  "final": true
}
```

`CANCELLED` must be explicit in at least the configured minimum number of independent sources. A missing flight, HTTP 404, empty response, or unavailable provider never counts as a cancellation.

Final stored results use `flightproof/result/v1` and include the source policy
version, evidence URLs, consensus source count, scheduled arrival, gate-in
range, delay range, status, and resolution transaction time. The raw provider
payload is intentionally not stored.

## Production source policy

There is no universal public unauthenticated API that provides production-grade scheduled and actual gate times, cancellations, and diversions. A production deployment should pin independently operated normalized adapters backed by licensed aviation providers and/or allowlisted official airline or airport data. API credentials remain off-chain in those adapters and must never be committed to the contract or repository.

The included FlightAware worker is one production adapter reference. It emits
an arrival only from `actual_in` (block/gate-in), not estimated arrival or
runway touchdown, and emits cancellation only from an explicit provider flag.
At least one additional independently operated provider adapter is required
for the default two-source quorum. Demo fixture endpoints exercise consensus
but are not live aviation evidence and must never be marketed as such.

## Reuse boundary

FlightProof deliberately does not hold funds or decide policy eligibility. A
consumer can safely compose it by storing a `flight_id` and rule before
departure, then reading one of:

- `get_resolution(flight_id)` for the versioned full result;
- `evaluate_delay(flight_id, threshold_minutes)` for a conservative four-state
  decision (`PENDING`, `TRUE`, `FALSE`, `INCONCLUSIVE`);
- `evaluate_cancellation(flight_id)` for explicit cancellation; or
- `is_resolved(flight_id)` for lifecycle tracking.

Keeping resolution separate from payout avoids coupling one provider policy or
insurance product to the shared flight fact.

Consumers should allowlist a reviewed contract address and
`source_policy_version`, and inspect its source prefixes, quorum, spread, drift,
and finalization grace. A structurally compatible deployment can intentionally
use a different trust policy; schema compatibility alone is not an endorsement.
