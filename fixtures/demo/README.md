# Public demonstration fixtures

These immutable JSON records let a reviewer exercise FlightProof web retrieval
and consensus without a commercial aviation-data subscription. They describe a
synthetic historical BAW 75 arrival and are **not live or authoritative flight
evidence**.

Both records live in this repository. Serving them through different domains
does not make them independent sources and must never be represented as a
production quorum. A demo deployment should use a distinct source-policy
version and be labeled `DEMO_FIXTURES_NOT_LIVE` in its published evidence.

Canonical registration:

| Field | Value |
| --- | --- |
| Carrier / flight | `BAW 75` |
| Route | `EGLL -> DNMM` |
| Scheduled departure | `1781268000` |
| Scheduled arrival | `1781298600` |
| Flight ID | `BAW-75-EGLL-DNMM-1781268000-1781298600` |

The provider-A record reports gate-in 64 minutes late and provider-B reports 66
minutes late. With the repository's example two-minute consensus drift, the
stored delay interval is 62-68 minutes. A 60-minute rule evaluates `TRUE`, a
65-minute rule evaluates `INCONCLUSIVE`, and a 70-minute rule evaluates
`FALSE`.

The extensionless path mirrors the suffix derived by the contract:

```text
{prefix}/BAW/75/EGLL/DNMM/1781268000/1781298600
```
