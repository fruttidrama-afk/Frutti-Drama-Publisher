# Publisher Factory — Unified Multi-Publisher Control Plane
Date: 2026-10-12
Status: operator-approved target architecture; migration not yet complete.
Precedence: preserves standing SOP, show canon, active production data and the rule WHAT WORKS DOES NOT GET TOUCHED.

## Product decision
Publisher Factory is the ONLY application/control plane. Do not create a separate application, domain or code fork for each newly created show. The current Factory hosts:
- Dashboard / Home
- Active Publishers (one card per instance)
- Create Publisher
- Platform-wide scheduler, health, incident and per-publisher status

Opening an Active Publisher routes WITHIN the same Factory origin, e.g. /publishers/:publisherId. It displays the same recognizable branded show dashboard with the familiar Home, Generation, Review, Stock, Publications and Configuration experience. The shared UI is one codebase and one component library, with per-publisher theme tokens and visual assets. Never make users go to a separate app, or render an external iframe as a substitute.

## One engine, multiple tenant-isolated instances
- Shared runtime implementation: GitHub Actions ephemeral workers + Supabase PostgreSQL orchestrator and Storage + Free Browser Provider. Independent per-publisher jobs; single shared scheduler service, per-publisher idempotent obligations and leases. Fully unattended, runner-independent.
- One set of durable APIs/endpoints and browser automation code for Flow, credit refresh detection, generation, matching/recovery, AI-interpreted redo, review, stock, publishing and external remote reconciliation. A bugfix is shipped in the common engine once and tested against all publisher types; do not clone code to fix each.
- Every call and storage path MUST be scoped by immutable publisher_id and authenticated owner. Enforce tenant boundary at both API/RLS and storage; never use another publisher's media, pending obligations, cookies, remote video id or credentials.
- Separate Google Flow profile/auth and project id per publisher; separate YouTube OAuth refresh token or Facebook Page credentials as appropriate. Credentials never shared by runtime sessions; no single browser profile for all shows.
- Per-publisher differences are CONFIGURATION and DATA, not different applications: show Bible, canon/season/continuity, asset and character identity, prompts/story content, branding/themes/layout assets, Google/Flow project, platform (YouTube or Facebook), posting schedule, media stock, review feedback, tokens, credits and quotas.
- Global changes require a shared contract and regression tests for FruttiDrama, EARTH IN 10, Dinnie The Dinosaur. A broken shared change must be rolled back globally.

## Existing architecture, confirmed from code at adoption
- Repository fruttidrama-afk/Frutti-Drama-Publisher contains a common runtime and Supabase Free Runtime scheduler, plus an existing `factory-web/public/index.html` Publisher Factory interface.
- That interface currently lists `publishers` from Supabase but its 'OPEN PUBLISHER' and DEPLOY paths still carry legacy Railway/configure-connection implementation. Do not mistake these paths for a working unified in-app dashboard.
- Current states and profiles are persisted under `publisher_runtime_publishers`, `publisher_runtime_obligations`, `publisher_runtime_incidents`, and per-publisher Supabase Storage `<publisher_id>/state.tgz`, `<publisher_id>/profile.tgz`. Review assets use separate persistent storage.
- Old `FruttiDrama-Publisher` repo and show-specific UI assets must be inventoried and migrated safely, NOT discarded or set up again from scratch.

## Zero-breakage migration steps
1. Inventory actual data contracts, theme sources and working components of the three historical dashboards. Snapshot source, Supabase state and storage; map every old UI feature/action to one shared API contract. Never reset episode indices or stocks.
2. In existing Factory frontend, add Active Publishers with an in-app publisher route and **read-only** integrated branded views backed by live tenant-filtered Supabase state. Legacy show panels remain accessible during verification.
3. Implement one shared dashboard component set using publisher configuration and themes. Reproduce prior functionality/appearance without forking layouts; preserve per-show assets and responsive mobile/iPad/desktop design.
4. Implement scoped common mutation endpoints: Approve -> stock; Redo + AI feedback -> same episode; stock schedules release one item/day; extra generations only on explicit user request and real free credits. Verify platform/provider identity read-only before any publishing change.
5. Keep GitHub Actions/Supabase scheduler independent from open tabs, with isolated sessions, recoverable leases, matching Flow asset IDs/content hashes, and logical exactly-once publication. No Railway operational dependency and no TinyFish.
6. Golden test via read-only auth checks, synthetic obligations and existing media; no credit-consuming generation or real account posting for testing without explicit operator approval. Test all three publishers for UI, tenant isolation, crash/retry recovery, credits and scheduler.
7. Cut Factory Active Publishers links from legacy external panels to internal routes **only after parity and auth success**. Provide reversible rollout and redirect legacy URLs. Disable obsolete publishers' independent runtime paths only after validating no orphan obligations or overlapping schedulers.
8. Factory creation flow now provisions an instance (config + project mapping + isolated credentials + storage namespaces + obligations) within shared platform, not a new deployed application.

## Canonical acceptance criteria
- Exactly ONE Factory URL/app and ONE shared UI/automation codebase for current and future publishers.
- Each publisher has fully preserved distinctive branding, story and media with independent auth.
- A code fix to common Flow, review, stock or publishing logic benefits all publishers after tests without modifying each deployment separately.
- Factory closes and generation/publication continues by durable scheduler. Three daily automatic *free-credit gated* generations and one human-approved scheduled publication per publisher, never paid Flow credits.
- No duplicate media binding, cross-account publication, YouTube private staging or publishAt. FruttiDrama is YouTube only, Earth YouTube only, Dinnie Facebook only.
- FruttiDrama canon: Season 2 ends E35, Season 3 E1–E6 existing review media; never reconstruct this history as Season 1.
- The unified migration is NOT complete merely because this decision is documented or the publisher cards render.

## Verified implementation increment (2026-10-12 18:01 UTC)
- All three existing runtime IDs are present under the SAME confirmed Factory owner. FruttiDrama runtime ownership linked after verifying Earth and Dinnie agree on owner; FruttiDrama registered into original `publishers` table with the same immutable id. No duplicate show, no resets.
- Secure `publisher-unified-read` Supabase Edge function v2 verifies a real Supabase authenticated user, scopes all reads to `owner_id`, and exposes per-publisher health/obligation/incidents and a **read-only inventory snapshot**, not OAuth/session secrets.
- Both `docs/index.html` (GitHub Pages) and `factory-web/public/index.html` add in-origin `ABRIR EN FACTORY` and integrated health, Review and Stock readonly views. Managed Free Runtime publishers no longer show a legacy Railway deployment/delete action.
- `publisher_runtime_inventory` Postgres projection table is service-role-only with RLS enabled and no direct client policy. It is NOT the source of truth. No requests against this table may approve, redo, schedule or publish an episode.
- `publisher-runtime-state-audit` v4 accepts GH OIDC from two whitelisted source workflows: the full diagnostic audit and new lightweight `runtime-inventory-sync.yml`, and restricts profile downloads to the full diagnostic workflow only. The new sync never starts Google Flow or any video/publication operation.
- Recurring lightweight workflow `Publisher Inventory Sync` executes every two hours; script `scripts/runtime-inventory-sync.mjs` unpacks each persisted `state.tgz` to a temporary read-only SQLite DB and posts sanitized status-only Review and Stock projections. Secrets and media bytes are never included in the projection. It removes its temporary files.
- First independent sync run `38287997990` completed SUCCESS: FruttiDrama 6 review / 9 draft / 0 scheduled stock; EARTH IN 10 0 review / 9 draft / 0 stock; Dinnie 0 review / 9 draft / 0 stock. All three synced, no media rendered/published.
- Factory static UI smoke run `38287766723` SUCCESS and deployment completed. Browser-authenticated real user view and write actions are NOT yet validated.
- FruttiDrama Flow bootstrap was STILL `waiting_for_google_login` during this implementation; no claim of persistent auth or live production recovery.
- Next stages: durable Flow profile restoration and fresh runner verification; signed provider credentials; validated shared Review / Redo / Stock mutation API, with strict event idempotence; then shared public-only posting and full multi-show regression tests. No creative rebranding until canonical assets are supplied.
