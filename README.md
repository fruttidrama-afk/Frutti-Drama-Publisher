# Frutti-Drama-Publisher

## Publisher Factory canonical runtime

This repository is the source runtime used by Publisher Factory for every generated Publisher.

### Canonical Google Flow knowledge contract

Every runtime image bundles and ingests the canonical `FLOW-SOP-v1.0` knowledge pack into its durable SQLite `runtime_knowledge` table:

- `GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md`
- `GOOGLE_FLOW_AUTOMATION_SOP.json`
- `FLOW_AI_IMPLEMENTATION_BRIEF.md`
- `FLOW_RECOVERY_RUNBOOK.md`
- `FLOW_GOLDEN_TEST.md`
- `FLOW_FAILURE_CATALOG.md`
- `FLOW_CHANGELOG.md`
- `FLOW_SOP_KNOWLEDGE_MANIFEST.json`

Canonical master SHA-256:

`8172f4b415e516fb1ec211a338ef7872740d7931adfbc5ab31572344a5bc9162`

Builds fail if the SOP hash, runtime safety contract, sequential Flow generation, project-grid recovery, exactly-once submit boundary, Review metadata gate, or config schema drift from the canonical contract.

### New Publisher lifecycle

1. Publisher Factory creates the Railway service from this repository.
2. Factory injects the canonical SOP version/hash and strict-serial config.
3. Runtime starts with its durable automation DB gate closed.
4. User completes the official one-time setup that cannot be bypassed: YouTube OAuth, Google Flow authentication/project binding, and Creative Bible/configuration.
5. The runtime independently detects readiness every 30 seconds.
6. Once YouTube + exact Flow project + Creative Bible + SOP knowledge are all verified, the runtime opens the automation gate and starts production automatically.
7. Flow runs strictly serially: one generation → recovery → validation → Review → next generation.
8. Scheduler remains indefinite; no page/browser needs to stay open after setup.

### Acceptance gate

Publisher Factory does not mark a Railway deployment ready unless `/factory/health` reports:

- canonical SOP loaded and matching hash;
- exactly-once submit enabled;
- strict serial generation enabled;
- project-grid recovery enabled;
- Review metadata required;
- Golden Test required;
- strict serial gate enabled.

FruttiDrama's production generation logic is treated as reference-only unless a separate explicit task authorizes changes.
