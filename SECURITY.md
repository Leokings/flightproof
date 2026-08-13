# FlightProof security review

## Audit status

**Conditional pass for a GenLayer prototype.** No unresolved Critical or High
contract-code findings were identified in the audited file after remediation.
This review is not a warranty, formal certification, or approval to handle
production insurance funds.

This is a documented internal engineering security review. No independent
third-party auditor identity or certification is asserted.

> **Production source gate:** FlightProof is **not production multi-source**
> until at least two adapters with independently controlled ownership and
> independently sourced authoritative upstream flight data are deployed and
> configured. Two domains, two routes, or two deployments backed by the same
> operator or upstream provider do not satisfy this requirement.

## Audited snapshot

| Item | Audited value |
| --- | --- |
| Review date | 2026-08-09 |
| Primary scope | `contracts/flight_proof.py` |
| Contract SHA-256 | `1B19F4045933175D6FE977D2BAE15C875A3B6B6B04DC2AC04868FDACED5266BC` |
| OAG adapter SHA-256 | `594C2D0EE8F014966D7B1500758D2A75F02591E218715092CB233B6B2582B132` |
| FlightAware adapter SHA-256 | `46D6D8504A5FAA3C836153335CA3C413DD85C6FE9A7761BBD3D2C9F3C7AF8B6F` |
| Contract | `FlightProof` |
| ABI | 11 methods: 9 view, 2 write |
| GenVM runner | Pinned `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |

The primary review covered nondeterministic leader/validator behavior, external
web-source policy, URL construction, storage and finality, input and schema
edge cases, Python/GenVM compatibility, and reusable-oracle semantics.
Supporting code was reviewed where it directly affects that boundary:

- the normalized adapter schema and the FlightAware and OAG Worker references;
- deployment constructor arguments and execution-success checks;
- direct validator tests and GLSim integration coverage; and
- the consumer trust boundary documented in `ARCHITECTURE.md`.

The review did not audit the GenLayer protocol implementation, validator node
software, wallet/browser extensions, Cloudflare or aviation-provider accounts,
the operator's executed provider agreements, live DNS/TLS configuration, or an
eventual consumer payout contract. Public provider terms were reviewed only to
identify deployment gates; that review is not legal advice.

## Verification results

| Verification | Result |
| --- | --- |
| `genvm-lint check contracts/flight_proof.py --json` | Pass: AST safety and SDK validation |
| GenVM schema extraction | Pass: 8 constructor parameters, 11 methods |
| Strict typecheck | Pass: 0 errors, 0 warnings, 0 informational diagnostics |
| Direct tests | Pass: 109/109 |
| GLSim integrations | Pass: 3/3 with 5 validators |
| Combined contract tests | Pass: 112/112 |
| OAG adapter unit tests | Pass: 26/26 |
| FlightAware adapter unit tests | Pass: 24/24 |
| Combined adapter unit tests | Pass: 50/50 |

Network evidence now exercises the full exact-`75` fixture path. On StudioNet,
deployment, registration, and resolution finalized; registration received
`4 AGREE / 1 IDLE`, while resolution received `3 AGREE / 2 IDLE`. On Bradbury,
the exact reviewed source deployment, registration, and resolution all
finalized with GenVM success and `5/5 AGREE`. Both networks stored `ARRIVED`
with delay bounds `62..68`; finalized views returned `TRUE` at 60 minutes,
`INCONCLUSIVE` at 65, `FALSE` at 70, and cancellation `FALSE`.

This is fixture-backed protocol evidence, not proof of live or authoritative
flight data. Both repository-hosted demo records were reachable during the
finalized demonstrations, but are controlled by the same repository and the
second configured URL redirects to the same GitHub raw-content service. The
validator votes prove agreement over those static fixtures only; they do not
establish source independence, licensing, or production suitability.

The repository is private. The Bradbury constructor records
`main`-branch GitHub fixture prefixes as immutable policy, so those URLs are not
a durable anonymous evidence feed after privatization. This availability change
does not alter the historical finalized snapshot, but the deployment must not
be presented as continuously operational. The annotated `v0.1.0` release tag
does not retroactively change the deployed constructor policy.

The direct suite includes manual execution of the captured validator against
independently changed web observations. GLSim 0.29.2 uses one shared mock set
for its simulated validators, so per-validator divergent web views cannot be
expressed there. Direct tests execute divergent observations, status, delay,
tampering, and transient-error cases by rerunning the captured validator with
changed web mocks. The five-validator GLSim suite verifies two successful
finalizations plus a failed-source quorum where execution fails and
`is_resolved` remains false.

The adapter suites exercise canonical URL construction, secret handling,
redirect rejection, exact flight and schedule identity, duplicate and pagination
ambiguity, explicit finality, time bounds, response media type, fatal UTF-8 and
byte caps, provider failures, CORS, and `no-store` evidence responses. These are
mocked boundary tests; they do not prove live-provider compatibility or rights.

The Windows test environment uses test-only compatibility shims for gltest
file-descriptor/datetime handling and a GLSim proxy-class cache issue. Those
shims do not modify the deployed contract or its consensus logic.

The linter reports informational warning `I200`: a newer pinned `py-genlayer`
runner is available. The audited runner remains concrete and network-safe; any
runner upgrade must be reviewed and the complete suite rerun before deployment.

## Threat model and guarantees

FlightProof assumes callers may be adversarial and a nondeterministic leader
may propose a forged result. Validators therefore refetch the contract-derived
source URLs and require exact equality with a strictly typed canonical result.

The contract provides consensus over what the configured source adapters
report. It does **not** prove that:

- separately named domains are independently owned;
- two adapters use independent upstream aviation data;
- an upstream provider is correct or immune to later correction;
- a claimant supplied the original insured schedule; or
- a downstream payout rule was created before the flight.

Those properties belong to deployment governance and the consumer contract.
FlightProof intentionally holds no insurance or escrow funds.

## Major findings remediated

### High: Canonical registration poisoning

The original flight identifier omitted scheduled arrival, allowing the first
caller to lock a shared identity to a conflicting arrival schedule. Scheduled
arrival is now part of the canonical identifier, so alternate schedules create
separate records and cannot poison an existing identity.

### High: Caller-controlled source URL policy escape

Raw evidence URLs were previously supplied to `resolve_flight` and checked with
a string prefix. Path normalization such as `../`, encoded traversal, flexible
endpoints, or redirects could undermine the intended path allowlist.

The contract now derives every evidence URL from immutable source prefixes and
the validated registration. Constructor validation rejects unsafe prefixes,
credentials, query strings, fragments, percent encoding, traversal, control
characters, non-ASCII input, overlaps, and duplicate authorities.

### High: Decision-changing validator tolerance

A forged leader interval could previously remain within the configured numeric
tolerance while changing `evaluate_delay` from `INCONCLUSIVE` to `TRUE` or
`FALSE`. Validators now require the complete, strictly typed canonical result
to exactly equal their independently rederived result. Unknown keys, missing
keys, booleans, numeric strings, altered bounds, and incorrect source counts
are rejected.

### Medium: Malformed-source availability failure

A value such as JSON `1e309` can decode to infinity and previously caused an
uncaught conversion error, allowing one malformed allowed source to abort an
otherwise valid quorum. Response processing is now isolated per source,
response size is bounded, and timestamps and flags require exact integer and
boolean types.

### Medium: Premature or future outcome finalization

Resolution now opens only after scheduled arrival plus the configured
finalization grace. A separate five-minute clock-skew limit prevents source
uncertainty settings from authorizing a materially future gate-in timestamp.

### Medium: Unsafe deployment-policy parameters

Source spread, consensus drift, finalization grace, prefix length, quorum, and
source authority are bounded or validated. The deployment helper mirrors the
contract limits and requires a finalized transaction with successful contract
execution before reporting a usable address.

### Medium: Unnecessary itinerary linkage

The stored `registered_by` address was removed because it unnecessarily linked
a wallet to an exact route and schedule. Transaction sender and calldata remain
public at the protocol level; privacy-sensitive consumers should use a shared
policy contract or relayer where appropriate.

### Medium: Missing-key TreeMap access

Direct indexing into the boolean existence maps could trap on an absent key in
the official GenVM storage implementation instead of producing the intended
false value. That could break new registration and missing-record views. All
existence checks now use `TreeMap.get(key, False)`. Direct and five-validator
GLSim execution passed after this storage fix.

### High: FlightAware redirect, identity, and finality boundary

The initial FlightAware Worker followed provider redirects while carrying the
`x-apikey` header, accepted schedule records within broad time tolerances, and
could discard a contradictory `actual_in` while emitting cancellation. It now
uses `redirect: "error"`, requires one exact route and schedule record with a
stable provider ID, requires exact finality booleans, rejects contradictory
cancellation/diversion state, and applies the contract's gate-in time bounds.

### Medium: Adapter canonicalization and hostile-provider handling

The adapters previously differed on leading-zero and path aliases, caching,
operating-flight checks, pagination ambiguity, and response-body validation.
Both now reject noncanonical and dot-segment paths, return evidence as
`no-store`, enforce exact provider identity, reject incomplete or internally
inconsistent pagination, keep secrets in fixed-host headers with redirects
disabled, and enforce JSON media type, fatal UTF-8 decoding, and a streamed
two-megabyte byte cap. OAG also requires `isOperating === true` so marketing
records fail closed.

## Residual risks

### High: Real source independence is operational, not provable on-chain

The contract requires distinct URL authorities, but one organization can still
control multiple domains or multiple adapters can depend on the same upstream
feed. A compromised or colluding source quorum can make honest GenLayer
validators agree on false data.

The repository contains two proprietary-provider reference implementations,
one backed by FlightAware and one backed by OAG. Passing local unit tests does
not establish that either adapter is publicly deployed, appropriately licensed,
independently controlled, or operationally independent. Demo fixture endpoints
are testing infrastructure, not independent aviation evidence. Production use
requires at least two reviewed live adapters that satisfy all of those source
independence and licensing conditions.

### High deployment gate: Provider rights are not established by this repository

No executed OAG or FlightAware commercial agreement was supplied for audit.
OAG's public [evaluation agreement](https://www.oag.com/flight-info-api-evaluation-license-agreement)
limits the trial to internal evaluation and restricts third-party transmission
and derivative use. FlightAware's publicly posted [standard terms](https://uk.flightaware.com/commercial/aeroapi/AeroAPI_Standard_License_Jan2025.pdf)
restrict combining AeroAPI data with another real-time or near-real-time
provider without prior written permission. Before public validator
access or on-chain persistence, obtain written terms covering the normalized
output, multi-source consensus, caching/retention, permanent storage, and the
intended insurance, refund, or passenger-rights use. A code pass is not provider
authorization.

### High operational risk: Public adapters can exhaust paid-provider quota

Both reference Workers intentionally expose a public route backed by a secret,
usage-priced provider key. Final evidence uses `Cache-Control: no-store`.
Canonical paths prevent cheap alias multiplication, but an attacker
can still submit many distinct valid-looking flight paths. The repository
documents deployment-specific Cloudflare rate limiting rather than shipping an
account-specific active limiter. Production operators must enforce per-client
and global provider-budget limits, monitor spend/quota, and fail closed before
the upstream request when a limit is exceeded.

### Medium: Final resolution has no appeal or correction round

After the grace period and successful consensus, the first stored resolution is
immutable. Providers can correct records after initially marking them final.
A consumer handling material value must explicitly accept that finality or add
a separate challenge, appeal, or replacement-oracle process before payout.

### Medium: Consumer contracts must bind eligibility before departure

FlightProof records and resolves a supplied schedule; it does not determine
whether that schedule was the claimant's original insured itinerary. A payout
contract must commit the reviewed FlightProof address, source-policy version,
flight ID, schedule, threshold, beneficiary, and payout rule before departure.
It must not let a claimant choose those values only after the outcome is known.

### Medium: Exact web consensus favors safety over availability

Exact result equality prevents boundary-changing settlements, but provider
corrections or source changes between validator fetches can make the transaction
fail to reach consensus. Consumers must treat unresolved flights as pending,
retry safely, and never reinterpret an unavailable source as cancellation.

### Low: Limited on-chain forensic evidence

The stored result contains the aggregate, source URLs, policy version, and
resolution time, but not each normalized observation or a committed digest of
each response. Source endpoints may later change. For higher-value deployments,
consider committing stable normalized per-source observations or digests that
validators compare without introducing nondeterministic response fields.

### Low: Public transaction metadata

Removing `registered_by` reduces redundant linkage but does not hide the sender,
method arguments, route, or schedule from transaction observers. Clients must
not present registration as private.

### Informational: Newer runner available

The audited runner is pinned and passes validation. A newer runner exists, but
upgrading without reviewing release notes and rerunning all checks would change
the audited execution environment.

## Production deployment checklist

### Source and adapter governance

- [ ] Deploy at least two adapters with independently controlled operators.
- [ ] Confirm those adapters use different authoritative upstream providers;
      two domains backed by one provider are not independent.
- [ ] Document adapter ownership, hosting, upstream provenance, schema version,
      caching policy, and incident contacts.
- [ ] Exclude demo fixtures and writable/public-content endpoints from the
      production source policy.
- [ ] Verify each adapter returns only explicit final cancellation, diversion,
      or actual gate-in data; absence and HTTP 404 must never mean cancellation.
- [ ] Keep provider credentials in adapter secret storage. Never include API
      keys in contract prefixes, URLs, source code, logs, or evidence output.
- [ ] Obtain written provider terms permitting public normalized evidence,
      validator access, multi-provider consensus, retention/caching, permanent
      on-chain storage, and the intended claim or payout use case.
- [ ] Configure per-client rate limits, a global provider-quota/cost circuit
      breaker, budget alerts, and a controlled `429` path before upstream fetch.
- [ ] Verify live responses preserve `Cache-Control: no-store`, redirect
      rejection, canonical paths, bounded JSON bodies, and secret-free errors.
- [ ] Monitor adapters for schema drift, redirects, stale data, outages, and
      unexpected ownership or DNS changes.

### Contract and network deployment

- [ ] Review the latest GenVM runner release notes and deliberately retain or
      upgrade the pinned runner; rerun the full suite if it changes.
- [ ] Reproduce the audited contract SHA-256 before deployment.
- [ ] Review quorum, maximum spread, drift, finalization grace, and all source
      prefixes as economic security parameters.
- [ ] Deploy with the repository helper and require `FINALIZED` plus successful
      execution, not transaction acceptance alone.
- [ ] Verify the deployed source, constructor arguments, address, transaction,
      and `get_policy()` output in GenLayer Explorer.
- [ ] Publish and allowlist the deployed contract address together with its
      `source_policy_version`; schema compatibility alone is not endorsement.
- [ ] Secure the deployment wallet and never commit or share its private key,
      seed phrase, or keystore password.

### Consumer and payout safety

- [ ] Bind the flight ID, original schedule, threshold, beneficiary, payout
      amount, reviewed contract address, and source-policy version before
      departure.
- [ ] Handle `PENDING`, `INCONCLUSIVE`, and `NOT_APPLICABLE` explicitly. Never
      convert them to a successful delay or cancellation claim by default.
- [ ] Define retry, source-outage, dispute, provider-correction, and replacement
      oracle procedures before funds are at risk.
- [ ] Decide whether immutable first resolution is acceptable; otherwise add an
      appeal or cooling-off layer in the consumer workflow.
- [ ] Explain public transaction metadata and use shared registration or a
      relayer for privacy-sensitive workflows.

### Verification and operations

- [ ] Run GenVM lint, schema extraction, strict typecheck, all direct tests, all
      GLSim integrations, adapter tests, and deployment-script type checking
      against the exact deployment candidate.
- [ ] Test arrival, cancellation, diversion, threshold boundaries, disagreement,
      malformed data, oversized data, 4xx/5xx responses, timeouts, and source
      recovery.
- [ ] Exercise each live production adapter with known historical flights before
      enabling material payouts.
- [ ] Add monitoring for unresolved-rate changes, consensus failures, adapter
      errors, response latency, and provider schema changes.
- [ ] Publish an incident process that can pause consumer payouts even though
      the immutable FlightProof registry itself has no administrative pause.

## Reporting security issues

Report vulnerabilities privately to the repository maintainer or their
designated security contact. For the private GitHub repository, use a private
GitHub Security Advisory when that channel is enabled. Do not include provider
credentials, wallet secrets, or exploitable live-flight details in a public
issue.
