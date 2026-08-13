# FlightProof release checklist

This directory is the complete **contract-only** FlightProof submission
candidate. Any release or transfer archive must contain no frontend, wallet
private key, keystore password, provider API key, dependency directory, cache,
or local `.env` file.

## Start here

1. Read `README.md`, then `SECURITY.md`.
2. Use `contracts/flight_proof.py` as the reusable Intelligent Contract source.
3. Follow `README.md` to install dependencies and rerun verification.
4. Use `SUBMISSION.md` for the Portal title, description, category, and evidence.

Wallet and provider credentials must remain outside the repository. Never send
a private key, seed phrase, keystore password, or provider API key through chat
or commit it.

## Verified results

- Contract SHA-256:
  `1B19F4045933175D6FE977D2BAE15C875A3B6B6B04DC2AC04868FDACED5266BC`
- Direct tests: 109 passed.
- Five-validator GLSim tests: 3 passed.
- Adapter tests: 50 passed (FlightAware 24, OAG 26).
- GenVM lint/schema/strict typecheck: passed.
- Dependency audit: zero known advisories.
- Documented conditional internal security review: no unresolved Critical or
  High contract-code finding.

StudioNet deployment evidence is recorded in `deployments/studionet.json`.
Finalized Bradbury deployment, exact-`75` registration, and resolution evidence
is recorded in `deployments/bradbury.json`.

- Private repository: `https://github.com/Leokings/flightproof`
- Verification wallet: `0x797d3B25fB2cCA0Ff93F60df1910267f3822D655`
- StudioNet contract: `0xD6361eEC3CF9fDE4C8633521E8125B5548088461`
- Bradbury contract: `0xC47DeEcDFB3A5CF08639d9A93B62225bD456b97d`
- Both network demonstrations resolved
  `BAW-75-EGLL-DNMM-1781268000-1781298600` as `ARRIVED` with delay bounds
  `62..68` and the expected 60/65/70-minute views.

## Standalone repository and release archive

Before creating the next release or archive, confirm that this FlightProof
directory remains the root of its own repository and that every intended
release file is tracked. Do not run `git archive` from an unrelated parent
repository: untracked `FlightProof/` content would be omitted entirely.

The standalone repository is private at
`Leokings/flightproof` and is not reviewer-accessible without explicit GitHub
access. The clean release root has an annotated `v0.1.0` tag. Use that tag for
release-source links after verifying the tagged contract hash; do not reuse an
older commit permalink.

The Bradbury constructor policy factually points to the repository's `main`
branch for two immutable fixture namespaces. The release tag does not
retroactively update those on-chain prefixes. Because the repository is
private, the configured fixture URLs are not a durable anonymous evidence feed;
production use requires a new deployment with durable, independently operated,
licensed adapter prefixes.

For each release, build an archive from tracked files rather than zipping the
working directory. This excludes `.env`, `.venv`, `.tools`, `node_modules`,
caches, wallet keystores, and other ignored local state:

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
git archive --format=zip --prefix=FlightProof/ --output artifacts\FlightProof-contract-only.zip HEAD
```

Inspect the resulting archive before release; do not substitute a whole-folder
archive.

## Data-source boundary

FlightProof itself derives and fetches every configured evidence URL during
GenLayer nondeterministic execution. A caller cannot supply a URL. The source
prefixes are immutable constructor policy, so every deployment must choose them
carefully.

The included FlightAware and OAG workers are hardened reference adapters only.
They require separately obtained provider credentials, written redistribution
rights, independent operation, and public HTTPS deployment. The static demo
records are not live or authoritative evidence.

The repository-hosted fixture policy was reachable and exercised end to end on
both StudioNet and Bradbury. The exact-`75` registrations and resolutions
finalized, stored `ARRIVED` with delay bounds `62..68`, and returned the
documented threshold views. StudioNet recorded `4 AGREE / 1 IDLE` on
registration and `3 AGREE / 2 IDLE` on resolution; Bradbury recorded `5/5
AGREE` for deployment, registration, and resolution. These are static records
controlled by one repository, not independent or authoritative aviation
evidence. Repository privatization makes them unsuitable for continued
anonymous replay. For a live deployment, deploy at least two independently
operated licensed adapters and redeploy FlightProof with those exact HTTPS
prefixes.

## Portal scope

Submit under **Builder -> Intelligent Contracts**. FlightProof is a reusable
fact contract, not an app or insurance product; it holds no funds and includes
no frontend. The Explorer links in `SUBMISSION.md` are verified evidence. The
exact tag-pinned GitHub repository, source, proof, and security links are
reviewer-inaccessible while the repository is private. Packaging and annotated
`v0.1.0` tag checks are complete. Public-visibility and unauthenticated GitHub
URL checks remain pending. Do not list the GitHub links as public evidence
unless reviewers receive access or the Portal accepts a different accessible
source bundle. Before transfer, verify the tagged contract hash and archive
contents against the clean release root.
