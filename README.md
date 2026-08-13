# FlightProof

FlightProof is a reusable GenLayer Intelligent Contract that reaches validator
consensus on a flight's final gate arrival, cancellation, or completed
diversion. Insurance, refund, escrow, and travel contracts can reuse one
versioned fact instead of trusting a claimant, a single API, or an application
server.

FlightProof is a contract, not an insurance product or app. It holds no funds,
selects no beneficiary, and makes no policy-eligibility decision.

## Verification status

- GenVM lint and SDK validation: passed.
- Strict contract type checking: passed with zero diagnostics.
- Direct contract tests: **109 passed**.
- Five-validator GLSim integrations: **3 passed**.
- Source-adapter tests and deployment-script type checking: passed.
- Documented conditional security review: no unresolved Critical or High code
  finding; see [SECURITY.md](SECURITY.md). This is an internal engineering
  review, not an independent third-party audit.

### StudioNet verification

The reviewed contract completed a gasless exact-fixture lifecycle on StudioNet
from deployment wallet `0x797d3B25fB2cCA0Ff93F60df1910267f3822D655`:

- Contract: `0xD6361eEC3CF9fDE4C8633521E8125B5548088461`
- Studio: [import the deployed contract](https://studio.genlayer.com/?import-contract=0xD6361eEC3CF9fDE4C8633521E8125B5548088461)
- Deployment: [`0x72b82b1c...0c4b39`](https://explorer-studio.genlayer.com/tx/0x72b82b1c9d4c6467216165783109dc2566b4b810dd4a7b9b28e11669ad0c4b39)
  — `FINALIZED`
- Exact-`75` registration: [`0x7dfaf05a...683236`](https://explorer-studio.genlayer.com/tx/0x7dfaf05aff77a63c19547cdc13ce9f757af5b29993cd9eee1f5993e5be683236)
  — `FINALIZED`, `4 AGREE / 1 IDLE`
- Fixture-backed resolution: [`0x70c1badf...0f245`](https://explorer-studio.genlayer.com/tx/0x70c1badf5470e281ccb0a6be5b546def8ec753867ba01531648553daa390f245)
  — `FINALIZED`, `3 AGREE / 2 IDLE`

The registration stored
`BAW-75-EGLL-DNMM-1781268000-1781298600`. The finalized resolution returned
`ARRIVED` with delay bounds `62..68`; reads returned `TRUE` at 60 minutes,
`INCONCLUSIVE` at 65, `FALSE` at 70, cancellation `FALSE`,
`is_resolved == true`, and one indexed resolution.

### Bradbury verification

The same reviewed source completed the exact-fixture lifecycle on Bradbury from
deployment wallet `0x797d3B25fB2cCA0Ff93F60df1910267f3822D655`:

- Contract: [`0xC47DeEcDFB3A5CF08639d9A93B62225bD456b97d`](https://explorer-bradbury.genlayer.com/address/0xC47DeEcDFB3A5CF08639d9A93B62225bD456b97d)
- Deployment: [`0x4cfbe9ea...a4eb07`](https://explorer-bradbury.genlayer.com/tx/0x4cfbe9ea3c31e14144f40df1d38b23500d9cff4d38a736af63800d9597a4eb07)
  — `FINALIZED`, GenVM `FINISHED_WITH_RETURN`, `5/5 AGREE`
- Deployed source SHA-256:
  `1B19F4045933175D6FE977D2BAE15C875A3B6B6B04DC2AC04868FDACED5266BC`,
  matching the reviewed local contract exactly.
- Exact-`75` registration: [`0xe027fb9a...dc2275`](https://explorer-bradbury.genlayer.com/tx/0xe027fb9aafeff2aa00efd0697cdd4b228651266a63d40e93ac72174bb4dc2275)
  — `FINALIZED`, GenVM `FINISHED_WITH_RETURN`, `5/5 AGREE`
- Fixture-backed resolution: [`0x20835506...6b9598`](https://explorer-bradbury.genlayer.com/tx/0x20835506b9ff52f7fb898714a6f997c0d5682f9e14ab1e59ee0d8f73d66b9598)
  — `FINALIZED`, GenVM `FINISHED_WITH_RETURN`, `5/5 AGREE`

The finalized result for `BAW-75-EGLL-DNMM-1781268000-1781298600` is
`ARRIVED`, with gate-in observations `1781302440..1781302560`, conservative
delay bounds `62..68`, two evidence URLs, and source-policy version `9001`.
Final-state reads returned `TRUE` at 60 minutes, `INCONCLUSIVE` at 65,
`FALSE` at 70, cancellation `FALSE`, `is_resolved == true`, resolution count
`1`, and the exact flight ID at index `0`.

This is a submission candidate, not a production multi-source deployment. A
production policy requires at least two independently controlled adapters using
different licensed authoritative upstream providers. These repository-hosted
static fixtures were reachable during the finalized demonstrations, but are
controlled by one repository and the second URL redirects to the same GitHub
raw-content service. They prove the reusable on-chain flow, not independent,
live, authoritative, or production flight data. The repository is intended to
remain private, so the deployed `main`-branch fixture URLs are not a durable
anonymous evidence feed. The annotated `v0.1.0` release tag does not change that
immutable constructor policy.

## How it works

1. `register_flight` records a canonical carrier, flight number, route,
   scheduled departure, and scheduled arrival. Both timestamps are part of the
   flight ID.
2. After scheduled arrival plus the immutable grace period, `resolve_flight`
   derives every evidence URL from constructor-pinned source prefixes. A caller
   cannot inject an evidence URL.
3. The GenLayer leader fetches the normalized records. Every validator refetches
   and independently derives the canonical result.
4. Strict schema, identity, finality, quorum, time, and spread checks reject
   missing, estimated, malformed, mismatched, or ambiguous data.
5. The first consensus result is stored immutably. Consumers can read the full
   result or evaluate cancellation and conservative delay thresholds.

Arrival means actual **gate-in/block-in**, not runway touchdown or an estimate.
Cancellation requires explicit quorum; a 404, missing flight, or unavailable
provider is never interpreted as cancellation.

## Reusable interface

| Method | Kind | Purpose |
| --- | --- | --- |
| `register_flight(...)` | write | Register the canonical schedule and return its flight ID. |
| `resolve_flight(flight_id)` | write | Fetch all configured sources through GenLayer consensus and store one result. |
| `get_registration(flight_id)` | view | Read the canonical registration. |
| `get_resolution(flight_id)` | view | Read the versioned full result and evidence URLs. |
| `evaluate_delay(flight_id, threshold_minutes)` | view | Return `PENDING`, `TRUE`, `FALSE`, `INCONCLUSIVE`, or `NOT_APPLICABLE`. |
| `evaluate_cancellation(flight_id)` | view | Return `PENDING`, `TRUE`, or `FALSE`. |
| `get_policy()` | view | Inspect source policy, quorum, spread, drift, and grace. |
| `build_flight_id(...)` | view | Derive the canonical ID without writing state. |
| `is_resolved`, `get_resolution_count`, `get_resolution_id` | view | Discover immutable results. |

Payout contracts must commit the reviewed FlightProof address, source-policy
version, flight ID, original schedule, threshold, beneficiary, and payout rule
before departure. They must handle `PENDING` and `INCONCLUSIVE` explicitly.

## Repository

The standalone repository is private at
`https://github.com/Leokings/flightproof` and is not reviewer-accessible without
explicit GitHub access. The clean release root has an annotated `v0.1.0` tag.
The exact tag-pinned GitHub links are listed in [SUBMISSION.md](SUBMISSION.md),
but remain inaccessible to unauthenticated reviewers while the repository is
private.

```text
contracts/          FlightProof Intelligent Contract
adapters/           licensed-provider normalization references
tests/direct/       fast contract, source, and validator tests
tests/integration/  five-validator GLSim transaction tests
fixtures/           deterministic test data only
deploy/             typed GenLayer deployment helper
deployments/         verified network addresses and transaction evidence
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the trust boundary and schemas,
[SECURITY.md](SECURITY.md) for the review and deployment gate, and
[SUBMISSION.md](SUBMISSION.md) for Portal-ready contract submission copy.
[HANDOFF.md](HANDOFF.md) is the local standalone-repository and release
checklist.

## Local verification

Python 3.12 and Node.js 20 or newer are required.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
pnpm install --frozen-lockfile

.\.venv\Scripts\genvm-lint.exe check contracts\flight_proof.py --json
.\.venv\Scripts\genvm-lint.exe typecheck contracts\flight_proof.py --strict --json
.\.venv\Scripts\python.exe -m pytest tests\direct -q -p no:cacheprovider
pnpm test:adapters
pnpm typecheck:deploy
```

For the integration suite, start five-validator GLSim in one terminal:

```powershell
.\.venv\Scripts\python.exe tests\run_glsim.py --port 4000 --validators 5 --no-browser
```

Then run in a second terminal:

```powershell
Set-Location tests
..\.venv\Scripts\gltest.exe integration -v -s --network localnet -p no:cacheprovider
```

The test-local Windows shims are documented in
`tests/gltest_windows_compat.py`; they work around known `genlayer-test` 0.29.2
simulator issues and are never included in contract code.

## Source adapters

The contract fetches HTTPS data itself during nondeterministic execution, but
licensed provider credentials cannot be public on-chain. Small independently
operated adapters keep credentials in server-side secret storage and expose
only the strict `flightproof/v1` normalized record.

No universal anonymous flight API reliably supplies scheduled and actual gate
times, explicit cancellations, and diversions. Review provider licensing before
exposing normalized output or permanently recording it on-chain. The included
adapter implementations are deployment references; they do not include API
credentials or confer data-distribution rights.

## Deployment

Constructor policy is immutable. Before deploying, review every source operator,
upstream provider, prefix, quorum, spread, drift, and finalization grace. Copy
`.env.example`, configure the final HTTPS prefixes, then use the typed deployment
helper. It waits for `FINALIZED` and verifies successful GenVM execution before
printing an address; the transaction hash is printed immediately after
submission so a temporary RPC disconnect cannot hide it. The default receipt
poll allows up to two hours for consensus, appeals, and finality on the selected
network and is configurable through `.env.example`.

Flight numbers are ABI strings even when they contain digits only. GenLayer CLI
0.39.2 coerces a plain token such as `75` to an integer, so use Studio or a typed
SDK call when invoking `register_flight` with a digits-only flight number.

Use StudioNet for iteration and Bradbury for final submission evidence. Keep the
wallet keystore encrypted; never place a private key, seed phrase, adapter API
key, or keystore password in this repository or chat.

## License

MIT. Aviation-provider data remains subject to its provider's separate license.
