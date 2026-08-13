# GenLayer Portal submission

Use the Portal's general contribution form and select
**Builder -> Intelligent Contracts**.
The screenshots supplied for this project confirm that the form accepts URL
evidence; there is no initial binary upload. Re-check the orange required
evidence label after selecting Intelligent Contracts because it is
category-dependent.

## Form copy

**Contribution date:** `08/13/2026`

**Title:** `FlightProof — Reusable Flight Outcome Consensus IC`

**Notes / Description — 987/1000 characters:**

> FlightProof is an MIT-licensed reusable GenLayer Intelligent Contract for final flight arrival, cancellation, and diversion. Apps register a canonical flight; resolve_flight derives constructor-pinned URLs, validators independently fetch normalized records, and the contract stores one bounded result. Malformed, mismatched, ambiguous, or under-quorum evidence fails closed. Includes source, adapters, 109 direct tests, 3 five-validator GLSim tests, 50 adapter tests, deploy tooling, and a conditional internal security review. On Bradbury, the reviewed source, exact-75 registration, and fixture-backed resolution all finalized with 5/5 agreement. The stored result was ARRIVED with a 62-68 minute delay range; views returned TRUE at 60, INCONCLUSIVE at 65, FALSE at 70, and cancellation FALSE. Static fixtures are demo data controlled by one repository—not live, authoritative, independent, or production evidence. Production requires separately controlled, licensed upstream adapters.

## Evidence bundle

Add one URL per evidence item:

| Portal evidence type | URL to provide | Status |
| --- | --- | --- |
| GitHub Repository | `https://github.com/Leokings/flightproof` | Private and reviewer-inaccessible; public-visibility check **PENDING** |
| GitHub Tag — release | `https://github.com/Leokings/flightproof/tree/v0.1.0` | Annotated `v0.1.0` exists on the clean release root; inaccessible while private |
| GitHub File — exact contract source | `https://github.com/Leokings/flightproof/blob/v0.1.0/contracts/flight_proof.py` | Tag-pinned; inaccessible while private |
| GitHub File — Bradbury proof | `https://github.com/Leokings/flightproof/blob/v0.1.0/deployments/bradbury.json` | Tag-pinned; inaccessible while private |
| GitHub File — StudioNet proof | `https://github.com/Leokings/flightproof/blob/v0.1.0/deployments/studionet.json` | Tag-pinned; inaccessible while private |
| GitHub File — security review | `https://github.com/Leokings/flightproof/blob/v0.1.0/SECURITY.md` | Tag-pinned; inaccessible while private |
| GenLayer Explorer Contract | [Bradbury contract address](https://explorer-bradbury.genlayer.com/address/0xC47DeEcDFB3A5CF08639d9A93B62225bD456b97d) | Verified |
| Other | [Finalized Bradbury deployment](https://explorer-bradbury.genlayer.com/tx/0x4cfbe9ea3c31e14144f40df1d38b23500d9cff4d38a736af63800d9597a4eb07) | `5/5 AGREE` |
| Other | [Finalized Bradbury exact-75 registration](https://explorer-bradbury.genlayer.com/tx/0xe027fb9aafeff2aa00efd0697cdd4b228651266a63d40e93ac72174bb4dc2275) | `5/5 AGREE` |
| Other | [Finalized Bradbury fixture resolution](https://explorer-bradbury.genlayer.com/tx/0x20835506b9ff52f7fb898714a6f997c0d5682f9e14ab1e59ee0d8f73d66b9598) | `5/5 AGREE`; stored `ARRIVED`, bounds `62..68` |
| GenLayer Studio Contract | [Import verified StudioNet contract](https://studio.genlayer.com/?import-contract=0xD6361eEC3CF9fDE4C8633521E8125B5548088461) | Verified |
| Other | [Finalized StudioNet deployment](https://explorer-studio.genlayer.com/tx/0x72b82b1c9d4c6467216165783109dc2566b4b810dd4a7b9b28e11669ad0c4b39) | Verified |
| Other | [Finalized StudioNet exact-75 registration](https://explorer-studio.genlayer.com/tx/0x7dfaf05aff77a63c19547cdc13ce9f757af5b29993cd9eee1f5993e5be683236) | `4 AGREE / 1 IDLE` |
| Other | [Finalized StudioNet fixture resolution](https://explorer-studio.genlayer.com/tx/0x70c1badf5470e281ccb0a6be5b546def8ec753867ba01531648553daa390f245) | `3 AGREE / 2 IDLE`; stored `ARRIVED`, bounds `62..68` |
| Other | Short Studio/Explorer walkthrough video | Optional, recommended |
| X Post | Launch/contribution post | Optional |

The GitHub URLs above are the exact annotated-`v0.1.0` release links. The
repository is private, so those links are not reviewer-accessible without
explicit access. Do not submit them as public evidence unless reviewers receive
access or the Portal accepts a different accessible source bundle. The Explorer
links are verified and remain usable. FlightProof is submitted as a reusable
contract, not an app.

## Final submission gate

- The reviewed source is finalized on Bradbury and its deployed SHA-256 matches
  the reviewed local contract.
- Bradbury deployment, exact-`75` registration, and fixture resolution each
  finalized with `5/5 AGREE` and successful GenVM execution.
- The finalized Bradbury result is `ARRIVED`, with two fixture sources, gate-in
  bounds `1781302440..1781302560`, delay bounds `62..68`, and source-policy
  version `9001`.
- Final reads return `TRUE` at 60 minutes, `INCONCLUSIVE` at 65, `FALSE` at 70,
  cancellation `FALSE`, `is_resolved == true`, count `1`, and the exact flight
  ID at index `0`.
- StudioNet also exercised the same exact-`75` fixture flow, with the
  documented `AGREE`/`IDLE` vote breakdowns.
- Clean-root packaging check: **COMPLETE**.
- Annotated `v0.1.0` tag check: **COMPLETE**.
- Public GitHub visibility check: **PENDING**; the repository remains private.
- Unauthenticated access checks for every GitHub evidence URL: **PENDING**.
- Static fixtures may support a clearly labeled demonstration only. Do not
  describe this deployment as live, authoritative, independently sourced, or
  production-ready.
- A production claim requires at least two independently controlled,
  appropriately licensed adapters using different authoritative upstream
  providers.
- Connect the submitting wallet, complete reCAPTCHA manually, and submit.

Domain separation alone does not prove independent source ownership or
independent upstream data.
