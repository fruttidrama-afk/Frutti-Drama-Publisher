# Publisher Factory — Autonomy Rescue SOP Addendum (2026-10-10)

Status: AUDIT FINDINGS AND NON-DESTRUCTIVE REMEDIATION; **not a green light to declare production autonomous**.

## Invariant contract
- Publishers: FruttiDrama (YouTube Shorts), EARTH IN 10 (YouTube Shorts), Dinnie The Dinosaur (Facebook Reels). Per account: generate 3/day only against confirmed refreshed **free** Google Flow credits; publish at most 1 human-approved video/day.
- One human operation only: REVIEW approve or redo with AI-interpreted feedback. Never mistake redo for a next episode.
- No TinyFish, no Railway as operational runtime, no paid Flow credits, no YouTube PRIVATE staging/publishAt. Keep videos in persistent private stock, upload directly PUBLIC at the release slot.
- What works does not get touched. In particular never regenerate Frutti T3 E1–E6 without media/job reconciliation; T2 ends at E35, real T3 E1–E6 exist as recovered review media.
- Exactly-once *logical* processing: identify Flow asset and media hash before item binding; never associate an already recovered asset with a second episode; timeouts and expired leases require external reality reconciliation first.
- Preserve independent Flow Google sessions and canonical project IDs (Frutti 705d7ac2-30fe-4481-aa4c-076c31a64214; Earth 800af820-b951-4035-ab20-f64df8883fb0; Dinnie 67620e0a-7fcf-43c6-9770-eb235ce92a65).
- A green GitHub Action or enabled/ready Supabase flag is not proof of a generation or publication. Require real media and platform-specific remote confirmation.

## Verified failure modes (2026-10-10)
- Active scheduling is in `Frutti-Drama-Publisher/.github/workflows/free-runtime-runner.yml`, with `publisher-free-runtime` Supabase edge orchestrator, 5min cron, external `state.tgz` and `profile.tgz`; actual workers may occupy >20min.
- Retired scheduled Railway watchdog from legacy `FruttiDrama-Publisher`; do not re-enable it.
- Frutti migrated state has T3 E1–E6 in REVIEW with media, T3 E7–E15 drafts, `automation:factoryEnabled=false` deliberately established during canonical rebuild. Do not blindly re-enable it until review and continuity are reconciled.
- Earth and Dinnie state report `credit-balance-unavailable` and exact `FLOW_EXPECTED_PROJECT_NOT_FOUND:...:matches=0`. **NOT proven credit exhaustion**; never map inability to read credits/project to `WAITING_DAILY_FLOW_CREDIT_REFRESH`.
- Independent *read-only* Playwright probe of all three persisted Flow profiles loaded each canonical project URL and was redirected to sign-in for all three (2026-10-10). Cookie counts alone are not proof of auth; human account-specific reauthorization is necessary unless a separate valid credential is found.
- Current `state.tgz` files for all three have neither `secrets.json`, `youtube-token.json` nor alternate auth/secret files. Do not assert YouTube/Facebook accounts are disconnected globally without examining historical credentials; do not assume publishing works until remote API identity validation succeeds.
- All three `last_generation_at` and `last_publication_at` were null in the new runtime on first audit. Publication auth and actual POST not yet golden-tested.
- Real stock/review video media live in external persistent storage; protect exact asset-to-episode mapping and never upload unrelated files.

## Required non-credit golden test sequence
1. Read Supabase obligations, incident tables, Storage media metadata, job leases, GH Actions logs. Confirm exact account and project mapping; never infer success from ready/green.
2. Download state/profile only via scoped GitHub-OIDC-protected endpoints. Audit state and account-session credentials without displaying secret values. Open exact Flow project URL read-only; distinguish: login redirect, project missing, UI selector failure, expired cookie, and insufficient free credits.
3. Only after Flow auth proves usable, observe real FREE credit grant/refresh and verify batch status. Never force video generation as a diagnostic.
4. Reconcile remote Flow project renders, job/run IDs, hashes and review entries before requeue after timeout.
5. Verify each publication provider auth and target channel/Page by read-only API; then verify approved stock, privacy policy, title/metadata and scheduler. Real publication requires operator's explicit authorization for *any test upload*.
6. Test logical multi-day catch-up/recovery and lease reclaims with synthetic/dry-run obligations, without touching real uploads or generation.
7. A re-login bridge must be one-time, isolated per publisher, and password-protected with an unpredictable secret. Never put active login cookies, OAuth tokens, passwords or tunnel codes in GitHub log output.
8. Mark the system fully autonomous only when actual generation, recovery, REVIEW, stock, posting auth, scheduler, external post and next-day continuity are confirmed individually for all 3.

## Outstanding engineering
- Fix false `WAITING_DAILY_FLOW_CREDIT_REFRESH` classification on `FLOW_EXPECTED_PROJECT_NOT_FOUND` and credit-probe failure; recoverable auth challenge must surface its own state.
- Validate or repair publication due-slot priority (no early uploads), 45min lease recovery, durable scheduler starvation under >20min browser jobs.
- Recover historical publication credentials safely if accessible, otherwise request one reconnection at a time after proving missing; verify remote YouTube channel/Facebook Page identity before posting.
- Investigate why Frutti's reconstructed `factoryEnabled=false` and 6 pending review cards coexist with remote generation obligations; don't fabricate continuity.
- Validate portable storage survival, OAuth refreshability, multi-day unattended exercise and future Publisher Factory inheritability before completion claim.
