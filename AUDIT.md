# Consolidation audit

Inspected on 2026-10-14 before consolidation: all source imports, package scripts,
configuration, migrations 0001 through 0006, tests and project documentation.
The paper's README and repository humanizing guidance were also reviewed.
No production database query was needed; migration fixtures reproduce the supplied
Neon account and observation counts.

## Findings

The source had a tier runner, an arm scheduler and a later tier state machine.
Simulation used its own loop, while session startup and repository logic existed
in separate subsystems. Latency aggregates and checkpoint paths also had multiple
implementations. Assignment was unnecessary for three unassigned accounts that
share one methodology. Old reporting and operational documentation exposed paths
that were no longer the intended study.

The most consequential reliability defect was publishing successful operations
before confirming local durability. A failed write could leave reported counts
inconsistent with restart behaviour. Asynchronous synchronisation also lacked a
reliable local receipt and could overwrite a newer checkpoint with a status write.

## Consolidation decisions

One configuration, state machine, runner and repository now govern execution.
The original workload quantities, recovery gates, candidate-generation rules and
response-then-sleep timing remain. T4 stays disabled by default. Gap thresholds
retain the supplied 10,000/60,000 ms values and move from environment overrides
into the fingerprinted configuration. Lease timing remains infrastructure metadata.

Per-operation intent checkpoints make uncertain exposure explicit. A successful
operation is published only after an atomic durable write. Restart requires
review; a recovery command closes and synchronizes observations without replay.
Reports distinguish database receipts from verified local synchronisation.

Migration 0007 removes active assignment dependencies while preserving every
existing source row. Archive tables retain provenance and have no execution
paths. Migration 0001 through 0006 are unchanged. The supplied enrollment
hostname remains enrollment metadata, and old network-host association remains
missing instead of being invented from intended host labels.

## Test retirement

Arm-allocation tests and tests of the absolute-time arm scheduler are obsolete
because those methods were removed at the researcher's request. Reusable metrics
and network tests were retained. The replacement tests exercise the single
runner, lifecycle, privacy, leases, synchronisation, preservation and reporting.

## Limits

No production migration or live validation ran. Automatic resumption is absent
because its timing and exposure implications need scientific review. This
consolidation creates no new measurement result or causal claim.
