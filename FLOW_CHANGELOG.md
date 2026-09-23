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
