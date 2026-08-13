# Source adapters

FlightProof validators fetch normalized HTTPS evidence themselves. Licensed
provider credentials cannot safely live in public contract code, so small
off-chain adapters keep credentials in server-side secret storage and expose
only the strict `flightproof/v1` final record.

Included reference implementations:

- `flightaware-worker/` maps FlightAware AeroAPI `actual_in`, explicit
  cancellation, and completed diversion records.
- `oag-worker/` maps OAG Flight Info API v2 `actualTime.inGate`, explicit
  `Canceled`, and completed `Diversion` records.

Both implementations fail closed on estimates, absence, ambiguous matches,
route or schedule mismatches, malformed responses, and provider errors. Neither
contains an API key or grants rights to redistribute provider data.

A production quorum must use independently controlled adapters backed by
different authoritative upstream providers. Two routes, domains, or Worker
deployments controlled by one operator or backed by one provider are useful for
testing but are not an independent production quorum.

Before deployment, obtain provider terms that explicitly permit the intended
public normalized output, validator access and caching, permanent on-chain
storage, and insurance/refund/passenger-rights use case. Evaluation or trial
terms are not assumed to permit those activities.

Any additional adapter must preserve the exact registered flight identity and
schedule, emit the schema documented in `ARCHITECTURE.md`, and return a non-200
response whenever the outcome is missing, estimated, ambiguous, conflicting,
or non-final. HTTP 404 and provider unavailability must never mean
cancellation.
