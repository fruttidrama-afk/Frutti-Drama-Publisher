# Flow Unusual Activity — Active Supabase edge contract (2026-11-09)
Authority: September 23–25 Publisher Factory operator discussions and postmortem SOP, reconciled with Google Flow Help Center Nov 9 2026.

## Scope and proof
Only Google Flow's **generation rejection explicitly containing "Unusual Activity" AND "not charged"** qualifies for automatic backoff. A Google Account login challenge, CAPTCHA, passkey or 2FA is a different event and requires manual account review. If a submitted render might exist (unknown charge, timeout, ambiguous tile), preserve the asset and block new Generate pending read-only remote reconciliation; never retry blindly.

## Global schedule
The progression per Google Flow account / publisher is exactly:
- Alert #1 — 30 min
- Alert #2 — 60 min
- Alert #3 — 120 min
- Alert #4 — 240 min
- Alert #5 — 480 min
- Alert #6 and every later alert until confirmed success — 1440 min (24h).

This is the operator's conservative policy; **Google does not publish these intervals as its own** and does not guarantee a retry will be accepted. The monotonic provider-wide deadline cannot be shortened by a second script, REDO or new day. Only a confirmed new generation start resets the warning sequence. When 24h is reached, display a conspicuous notification in Factory; after expiry, retries remain limited to at most one eligible, correlated original episode and original prompt/intent, not a new video or duplicate submission.

## Execution
1. In `free-browser-provider.js`, after a single reserved Submit, check the Flow response against both the "Unusual Activity" and explicit "not charged" text; this is not an unknown render. Invoke `scheduleNoChargeRetry({confirmed:true})`. Set the SAME row back to draft/regen_wait, persist `flow:transientCooldownUntil` and global streak, and **do not click again** on this run.
2. In `scripts/free-runtime-runner-v2.mjs`, detect the saved SQLite confirmation with `confirmedFlowNoChargeCooldown()`, upload the state to `publisher-runtime-state/<publisher>/state.tgz` before calling callback with exact OIDC claim and `flow_no_charge_confirmed:true`. Fail closed if upload fails.
3. Supabase Edge `publisher-free-runtime` v10 validates OIDC scope and claim, records `streak`, `not_before` and `status` in RLS-protected `publisher_runtime_flow_cooldowns`. The callback rejects unproven automatic backoff. `claim()` refuses all generation obligations during the global window (but does **not** block separately approved publication obligations); on expiry it claims the **original blocked obligation** before another generation. Publication still obeys its own safety rules.
4. At render start confirmation in the provider, reset account-wide streak and local cooldown. On confirmed generation obligation completed, reset the Supabase-side streak. A network-ambiguous render or failed download is NEVER proof that it is safe to click Generate again.
5. Supabase `publisher-unified-read` v10 returns `flowCooldown` to authenticated owner only. `docs/index.html` and `factory-web/public/index.html` show progress and exact Buenos Aires next-try time, prominently alerting at 24h. No separate spam of notifications; owner may see notice by opening Factory.

## Permanent non-negotiable protections
The old September incident of **128 rapid no-charge retries** and E5/E6/E11 submitting in less than one minute resulted from episode-scoped timers and overwritten cooldown. All accounts and future publishers inherit account/provider-wide monotonic cooldown, one durable submit boundary, head-of-line ordering, no retry before confirmed no-charge, no automatic cache deletion, and no jumping queue via "Generar más" or REDO.

## Testing and limitations
`scripts/check-flow-unusual-cooldown.mjs` verifies exact timing, no reduction of deadline, account-wide gates, original obligation first and 24h panel notice (static contract tests). A real Flow 'Unusual Activity' response has not been deliberately triggered: do not induce one to test. Google account security challenges remain manual.
