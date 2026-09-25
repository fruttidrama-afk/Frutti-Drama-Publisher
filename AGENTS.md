# AGENTS.md — Publisher Factory operating contract

This repository is operated as a production system, not as a scratchpad.

## Mandatory SOP-first rule

Before changing any subsystem that has been solved before, read the relevant section in `docs/SOP_MASTER_PUBLISHER_FACTORY.md` and reproduce the proven path before inventing a new one.

If a task succeeds only after debugging, the task is not complete until the SOP is updated with:
- symptom and failure signature;
- actual root cause;
- exact verified fix;
- invariants that must never regress;
- production verification procedure;
- rollback/recovery path;
- commit/date or other evidence that identifies the known-good implementation.

Never make the operator rediscover a solved procedure.

## Promotion rule

A code change is not "fixed" until all applicable stages are verified:
1. source updated;
2. build/workflow successful;
3. production deployment uses the new build;
4. production endpoint/UI exposes the new behavior;
5. real runtime state is checked;
6. no unrelated working behavior regressed.

## Known-good-over-novel rule

When Fruttidrama, Earth in 10, Dinnie, or another existing publisher already implements a behavior correctly, inspect/copy that proven implementation. Do not re-derive it from scratch.

## Safety / cost rule

Generation credits are a production resource. Never submit an additional Google Flow generation merely to test a UI or recovery change. Use existing outputs, dry checks, or explicit operator-authorized Generate Extra / REDO.

## Primary SOP

Read: `docs/SOP_MASTER_PUBLISHER_FACTORY.md`.
