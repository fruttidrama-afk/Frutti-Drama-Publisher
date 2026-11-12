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
3. Supabase Edge `publisher-free-runtime` v11 validates OIDC scope and claim, records `streak`, `not_before` and `status` in RLS-protected `publisher_runtime_flow_cooldowns`. The callback rejects unproven automatic backoff with `FLOW_NO_CHARGE_PROOF_REQUIRED` whenever `flow_no_charge_confirmed` is not the boolean `true`. The Edge checks the claim ID, obligation ID and generation kind before persisting the cooldown; this is not a client-controlled timer. `claim()` refuses all generation obligations during the global window (but does **not** block separately approved publication obligations); on expiry it claims the **original blocked obligation** before another generation. Publication still obeys its own safety rules.
4. At render start confirmation in the provider, reset account-wide streak and local cooldown. On confirmed generation obligation completed, reset the Supabase-side streak. A network-ambiguous render or failed download is NEVER proof that it is safe to click Generate again.
5. Supabase `publisher-unified-read` v10 returns `flowCooldown` to authenticated owner only. `docs/index.html` and `factory-web/public/index.html` show progress and exact Buenos Aires next-try time, prominently alerting at 24h. No separate spam of notifications; owner may see notice by opening Factory.

## Permanent non-negotiable protections
The old September incident of **128 rapid no-charge retries** and E5/E6/E11 submitting in less than one minute resulted from episode-scoped timers and overwritten cooldown. All accounts and future publishers inherit account/provider-wide monotonic cooldown, one durable submit boundary, head-of-line ordering, no retry before confirmed no-charge, no automatic cache deletion, and no jumping queue via "Generar más" or REDO.

## Testing and limitations
`scripts/check-flow-unusual-cooldown.mjs` verifies exact timing, no reduction of deadline, account-wide gates, original obligation first and 24h panel notice (static contract tests). A real Flow 'Unusual Activity' response has not been deliberately triggered: do not induce one to test. Google account security challenges remain manual.

## Superseding implementation — 12 November 2026, 19:36 ART
The original per-publisher Edge lookup and SQL streak did **not** implement a
factory-global cooldown across different publishers: an alert from one show
could leave another show eligible. This is now corrected by
[`20261112_flow_factory_global_no_charge_cooldown.sql`](../supabase/migrations/20261112_flow_factory_global_no_charge_cooldown.sql)
and `publisher-free-runtime` Edge v20.

The authoritative conservative policy is factory-wide: **one explicit
no-charge Flow rejection pauses generation in FruttiDrama, EARTH IN 10,
Dinnie and any newly onboarded publisher**. The SQL RPC serializes alerts
under one transaction advisory lock, escalates one shared 30m / 1h / 2h /
4h / 8h / 24h streak, never shortens an existing deadline and mirrors the
same deadline to each publisher for the panel. The Edge reads the latest
non-clear cooldown globally, not merely the currently selected publisher.
Only a later confirmed completed generation with a claim timestamp after
the latest alert may reset the shared streak; an older in-flight callback
cannot erase a newer warning. The SQL RPCs remain executable by
`service_role` only. Publication obligations remain separately governed
by stock, OAuth and exact remote-ID safety checks.

The new offline regression exercises four distinct publishers and verifies
global lookup, the SQL serialization contract, escalation and stale-safe
reset. [CI 43321340997](https://github.com/fruttidrama-afk/Frutti-Drama-Publisher/actions/runs/43321340997)
passed. The production migration is applied and Edge v20 source matches
GitHub exactly. No live anti-abuse response was intentionally triggered,
and no generation, OAuth or social publication was attempted.
