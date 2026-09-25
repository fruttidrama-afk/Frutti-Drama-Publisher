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
