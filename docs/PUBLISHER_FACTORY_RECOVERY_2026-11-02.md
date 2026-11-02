# Publisher Factory — Recovery & Unified Panel Execution Ledger
**Snapshot:** 2026-11-02 (America/Argentina/Buenos_Aires)
**Status:** RECOVERY IN PROGRESS — production automation **NOT** verified.
**Scope:** FruttiDrama / EARTH IN 10 / Dinnie The Dinosaur.
**Authority:** `docs/SOP_MASTER_PUBLISHER_FACTORY.md`, `GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md`, `docs/AUTONOMY_RESCUE_SOP_2026-10-10.md`, `docs/PUBLISHER_FACTORY_UNIFIED_CONTROL_PLANE_2026-10-12.md`, operator-supplied show canon. Existing working functions must not be reset or modified unnecessarily.

## Confirmed architecture and current condition
- Single Publisher Factory application, one common backend and internal `/publishers/:publisherId` views, with distinct per-show theming and canon. **Current in-factory publisher views are read-only; approvals/REDO/Stock/publication API parity and in-app full routing are NOT finished.** Do not represent read-only panels as complete migration.
- Shared GitHub Actions ephemeral runner with `publisher-free-runtime` Supabase Edge orchestrator; state and portable browser auth under isolated publisher-specific Storage paths. Free Browser Provider; no TinyFish; Railway is historical forensics only.
- Targets per show: three *free-credit-authorized* video generations per day; one publication of a previously approved video per day. Frutti/Earth -> YouTube Shorts, Dinnie -> Facebook Reels. Review (approve or interpret REDO feedback) is the human gate. No YouTube early private staging, no paid credit spending.
- 2026-11-02 DB: publisher records enabled=true, generation_target=3, publication_target=1, approved_stock=0; migrated `last_generation_at` and `last_publication_at` null for all. Those *new-runtime counters* cannot establish historic upload loss.
- Frutti: `auth_reconnect_pending`, `FLOW_AUTH_CAPTURED_PROFILE_UPLOAD_TOO_LARGE:PROFILE_SIZE_INVALID`; 6 reconstructed review videos and 9 drafts (from read-only inventory). Historical publication canon must be manually verified: do not infer episode mappings from speculative prompt archive.
- Earth: `ready` in DB **is not verified Flow auth**; `EPHEMERAL_RUNNER_TIMEOUT_RECONCILE_ONLY` / `RUNNER_LEASE_EXPIRED`; 9 drafts, no migrated Review/Stock.
- Dinnie: `ready` in DB **is not verified Flow auth**; 81 blocked generation obligations Oct 7–Nov 2 tagged `WAITING_DAILY_FLOW_CREDIT_REFRESH`, but prior exact-project/sign-in checks suggest possible misclassification. 9 drafts, no migrated Review/Stock.
- Six open DB incidents: `HISTORICAL_STOCK_UNRECONCILED` and `FORENSIC_BACKUP_UNAVAILABLE` for each show. Historic Railway volumes must remain untouched until proven mapping/backups are available.
- 2026-11-02 live GitHub logs show Dinnie cron run claiming a job and closing free-credit batch without generation, and Earth running ~22 minutes without completing; both previously marked workflow success. Recurring inventory reads work independently.

## Applied non-destructive changes (2026-11-02)
1. `scripts/publisher-productivity-watchdog.mjs`: read-only, per-show freshness check on confirmed generation and migration state; requires all three shows and fails after 36 hours of missing confirmations. It does not touch credentials, browser, storage, generation, or platform posting.
2. `.github/workflows/publisher-productivity-watchdog.yml`: independent six-hour scheduled GitHub Actions failure signal. First run `41524906868` expectedly failed, explicitly identifying all three non-producing publishers, so the test verified the detector.
3. `scripts/free-runtime-runner-v2.mjs`: after preserving state and leaving the obligation in reconcile-only mode, a 22min timeout now exits non-zero; claim and preflight errors likewise exit non-zero. No automatic re-submit added. Workflows can no longer paint these failures green.
4. The runner now explicitly checks the status reason on `AUTOMATIC_BATCH_WAITING_FOR_DAILY_CREDITS`: `credit-balance-unavailable` and `credit-refresh-read-failed` trigger `FLOW_CREDIT_PROBE_UNAVAILABLE`, a failing workflow and safe pre-submit retry after lease expiry, **NOT** a false confirmed free-credit wait. It does not authorize a video submit or paid credits.
5. Both shared Factory HTML views now show last confirmed generation and a warning when the 36-hour production freshness gate fails or when migration is incomplete. The read-only UI smoke workflow succeeded (run `41525923594`).
6. Existing Review/Stock and publication logic remain untouched. No video was intentionally generated/uploaded as a test. No channels declared online.

## Priority repair plan and gates
**P0: Preserve evidence before production writes**
- Snapshot exact Supabase state and Storage objects, historic identifiers, and DB obligations. Confirm ownership, media hashes, exact Flow assets, last human-approved episode, release times, and platform video IDs. Do NOT regenerate Frutti T3 E1–E6 or erase any historic content. Keep historical Railway volumes unchanged.
- Reconcile old/new Review, approved stock, and scheduled publication before treating zeros as absence.

**P1: Repair Flow per channel without spending credits**
- Validate an authenticated Google session by reaching the exact Flow project URL, seeing exact project title/composer and reading current account's credits, using the show-specific browser identity. Disambiguate login redirect, expired OAuth/cookies, inaccessible project, selector failure, unknown balance, and truly insufficient free credits. Treat `PROJECT_NOT_FOUND` and `CREDIT_PROBE_FAILED` as distinct from `CREDIT_REFRESH_WAITING`.
- Frutti profile upload: remove nonessential browser cache/profile lock files under a *copy*, keep required cookies/storage state, validate archive boundaries and re-verify exact project after restore. Never upload auth bytes to public GitHub artifacts.
- Dinnie/Earth portable auth state is not proof of a valid login. Where Google requires interactive authentication, use user-initiated per-show re-login; never ask the operator to paste secrets into chat.
- Observed eligible free credit balance and exact model cost must gate each *new* submit. Credits are per Google identity; don't assume account/device/channel separation supplies different budgets.

**P2: Complete only existing, safe in-flight jobs**
- Distinguish `not_sent`, `submit_boundary_entered`, `submitted`, `ambiguous`, `matched`, `recovered`, `review` for every job; audit persisted baseline and unique Flow asset IDs/hashes. On lease expiry/runner restart, inspect remote Flow reality BEFORE any fresh submit.
- Compare output against exact job identity and avoid all duplicated video bindings. Publish only from approved existing media. Global concurrency lock must not starve all other shows for 22 minutes; resource-safe round robin for individual due jobs.
- A result is only complete once the right asset has been downloaded/validated, durable media committed, and a correct Review card exists.

**P3: Publication credentials / stock / human gate**
- Read-only API identity check for exact YouTube channel or Facebook Page with refreshable per-publisher tokens; do not infer connection from DB flags. Reconnect only if necessary and only by approved platform OAuth. Never copy tokens across shows.
- Restore existing approved stock with hashes, due-slot and duplicate checks. YouTube: direct public upload at release time, no private staging or `publishAt`; remote platform video ID must be saved. Dinnie: verified Facebook Reels state and AI disclosure.
- The merged app's shared Approve / interpret REDO / Stock / Publication API requires tenant-enforced authorization and idempotency. Test synthetic events and existing media BEFORE changing historical production.

**P4: Real unified Factory**
- Preserve all prior show designs, exact canonical assets and operator's Frutti recap workstation. Unified publisher routes in SAME origin; no iframe or links to independent Railway apps; shared UI code and contracts.
- Use `publisher-unified-read` as read-only owner-scoped reporting, not to mutate primary stock. Add audited scoped write APIs separately; no cross-tenant cookies, OAuth or object paths. Keep old dashboards available until verified feature parity.
- Freeze old deploy/service paths only after migration rollback point is known and no jobs are double-owned.

**P5: Proof of autonomy**
- Per show: a successful exact-project/auth read, real free-credit 10-second generation, correct unique media in Review, manual approve/REDO cycle, stock persistence, platform identity verification and public publication confirmed by remote ID, 24–48h unattended continuity. Test retry, crash/restart, expired lease, archive restore, low credits, OAuth expiry, missing project, provider throttling, stock full and platform 403.
- Watchdog plus GitHub Action logs flag stalled systems even when worker returns success. Notifications require configuring GitHub failure alerts or an independent opted-in channel; a failing workflow alone is not a guaranteed push notification.
- This project's `enabled/ready` DB state or successful Actions do NOT count as acceptance.

## Provider cost/continuity constraints
- Google Flow currently offers free 50 daily credits per account and lists Gemini Omni Flash 10s 720p at 15 credits; three generations need 45 credits **if all three are eligible on that identity** and pricing/capabilities are unchanged. Google may restrict unsubscribed video generation at peaks and free quotas/features can change. Never auto-purchase credits.
- GitHub Actions public repo scheduled workflows can be delayed/dropped and can be auto-disabled after 60 days without repository activity; periodic keepalive exists, but independent output watchdog now measures deliveries.
- Supabase Free has resource/Storage limits and may auto-pause after 7 days of low activity; `ACTIVE_HEALTHY` as of Nov 2 is not indefinite service guarantee. Do not promise an enforceable 100% zero-cost 24/7 SLA. Quota preflight + capped usage + recovery alarms required.
- Zero-dollar operation is a **hard billing guard**, not a claim that any vendor promises perpetual capacity or availability.

## Evidence
- First watchdog verification: https://github.com/fruttidrama-afk/Frutti-Drama-Publisher/actions/runs/41524906868
- Shared runner workflow: `.github/workflows/free-runtime-runner.yml`
- Inventory source: `.github/workflows/runtime-inventory-sync.yml`
- Shared UI source: `docs/index.html` and `factory-web/public/index.html`
- Historical rescue: `docs/FORENSIC_EXPORT_EXECUTION_2026_10_12.md`
- Next operator-needed step after technical checks: reconnect individual Google Flow authorization through authenticated UI for the specific accounts where auth is invalid, never via pasted password.
