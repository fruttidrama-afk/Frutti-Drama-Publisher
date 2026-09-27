## 2026-09-25 — Daily Flow credit-cycle gate

- Ordinary autonomous generation no longer opens a new 3-video batch at local midnight.
- Every Publisher now waits for evidence that Google Flow refreshed the account's 50 daily credits.
- The credit-cycle state is durable across browser/process/Railway restarts.
- A paid/monthly credit balance is not itself renewal evidence; monthly credits are protected from midnight-triggered automatic spending.
- The detector is non-rollover-aware: after 3 × 15-credit generations, the next daily refill can appear as a net balance increase of roughly 45 rather than exactly 50.
- While waiting for refresh, the runtime polls the live Flow balance on the configured cadence and exposes cycle state in health.
- Recovery/reconciliation remains higher priority than the batch gate, and active Unusual Activity cooldown still blocks new submits.
- Publisher Factory makes this protocol mandatory for future Publishers and existing Earth/Dinnie configs were upgraded.

## 2026-09-25 — Semantic REDO + post-submit uncertainty lock

- Human `REHACER` feedback is interpreted semantically by AI before any replacement generation is authorized.
- The interpreter chooses one of three actions: `render_retry`, `prompt_revision`, or `creative_rewrite`.
- Keyword/regex classification is not authoritative for REDO intent.
- After `SUBMIT_BOUNDARY_ENTERED`, a timeout or unchanged Flow grid is never proof that no generation occurred.
- Post-submit uncertainty remains recovery/reconciliation-only with Generate locked; only explicit hard no-charge/no-generation evidence may reopen a submit.
- Publisher Factory makes both behaviors mandatory for every newly generated Publisher.

## 2026-09-23 — Hard human-approval publication gate

- A Flow render in `REVIEW_READY` remains only on the Publisher's private persistent volume.
- Before explicit human `APPROVE`, the MP4 must not be uploaded to YouTube, Supabase review storage, or any other external destination.
- `APPROVE` is the only transition allowed to create a publication/stock item.
- `REJECT / REDO` deletes the rejected local media, purges any accidental non-public remote artifact, preserves only the minimum retry/feedback state, and generates a replacement.
- Prompt/story feedback defaults to a revised creative package; purely stochastic rendering defects may reuse the creative intent.
- Publisher Factory must enforce this invariant in every generated Publisher.

# FLOW CHANGELOG

## FLOW-SOP-v1.0 — 2026-09-21
- Verified automated Earth generation/recovery path frozen.
- Exact right-arrow submit and exact-project resolver canonicalized.
- Project-grid evidence and strict serial recovery made mandatory.
- False-positive click/busy/chat-option evidence invalidated.
- Review metadata must be publication-ready before approval.
- Date-scoped daily overrides, vanished-render reconciliation and insufficient-credit backoff incorporated.
- Publisher Factory inheritance contract added.
- Master SOP SHA-256: a2c1e60458c19e5e806e3246e98c5d31e2a6783a9a0cb436d721722d02f09166
## Runtime hardening — 2026-09-23
- Fixed FLOW-ERR-017 COMPOSER_REQUERY_RACE by reusing the editor resolved by the Flow readiness gate and reacquiring only through that gate after a transient remount.
- Publisher Factory runtime contract and self-test now reject the defective readiness-then-immediate-requery pattern.
- A short-lived native Retry experiment was superseded by the FruttiDrama-compatible single-submit rule below; current canonical behavior does not click the failed-tile Retry.
- Added FLOW-ERR-018 NO_CHARGE_RETRY_STORM protection: adaptive 15/30/60-minute provider-wide cooldown, strict head-of-line preservation, and successful-start reset.
- Isolated all Earth in Ten forensic repair routines behind the exact EARTH IN 10 project identity so generated Publishers cannot inherit Earth-specific state mutations.
- Removed immediate native failed-tile Retry from the reusable Flow submit path and restored the exact FruttiDrama single-submit boundary: one Send, observe, then back off on explicit no-charge.
- Removed all one-off Earth E10/E11 forensic repair functions from the canonical Publisher Factory runtime after their persistent-state repairs were completed.
- Aligned the canonical browser launch cadence with the proven FruttiDrama runtime: fresh X display/CDP port per session, 3-second Chrome settle before CDP attach, and no custom cache fingerprint flags.

## 2026-09-25 — identity-safe E6 recovery + zero-copy approval

- Confirmed a wrong-recovery failure can occur even after the correct Flow render exists: DOM position and grid-count delta were insufficient identifiers.
- Recovered Earth E6 from the existing Flow render without another generation by using stable Flow asset identity, baseline multiset diffing, adjacent-submit temporal bracketing, unused-asset rejection, post-click identity revalidation, MP4 validation and content-hash quarantine.
- Added durable `flow_recovered_assets` and `flow_rejected_media_hashes` guards.
- Targeted recovery is now generation-read-only: a recovery token can never fall through to Generate.
- Fixed APPROVE `ENOSPC`: local Review media is transferred to Publication by path ownership rather than copied on the same persistent volume.
- Publisher Factory must require these recovery and approval-storage invariants for future publishers.

## 2026-09-27 — 24-hour unattended-generation / recovery hardening

- A publisher may not depend on an operator opening its panel to advance generation, retrieval, credit-cycle rollover or recovery.
- Fixed the zero-use non-rollover credit deadlock: when the previous automatic cycle used 0 generations, the publisher-local day changed, the normal guard elapsed, and the live Flow balance can fund the full canonical batch, a new daily cycle may open even when the combined visible balance did not increase.
- The automatic fallback for masked daily-credit renewal is capped at 24 hours; 30–50 hour waits are obsolete.
- Recoverable `manual_hold` rows with real submit evidence and `automatic_recovery_forbidden=false` are automatically returned to retrieval-only reconciliation. Generate remains locked.
- Long-lived browser workers now run under `tini` so orphaned Chrome/Xvfb descendants are reaped instead of accumulating until `Cannot fork`.
- A Flow download menu that appears late is re-scanned before the job backs off; download failure always retries the same verified asset and never regenerates.
- The canonical runtime image is rebuilt/published from central Publisher Factory changes so image-based child publishers can inherit the same recovery code.
- Health/runtime checks must prove these capabilities without requiring a panel visit.
