# Publisher Factory: Railway-free runtime candidate (NOT ACTIVE)

Railway is a **historical forensic source only**. No future service, database, scheduler, login, backup or public link may rely on Railway.

## Provider decision — November 17, 2026

Candidate: Oracle Cloud Infrastructure Always Free, Ampere A1 ARM64, as a single persistent VM. The official 2026 Always Free allocation is **2 OCPU and 12 GB RAM TOTAL**, not the older 4/24 values quoted by third-party guides, plus 200 GB of combined boot/block volume and a monthly outbound transfer allowance. Oracle describes Always Free as an offer without a fixed expiration. However, Oracle explicitly **may reclaim an idle Always Free VM**, and there may be no A1 capacity in a given home region. This is a risk to be monitored honestly rather than disguised by fake load.

The operator has already committed to **ChatGPT Pro** and **Google AI Pro / Google Flow** as permitted subscriptions. All OTHER new hosting/storage/execution charges must be zero under ongoing, non-trial free-tier quotas.

Why not the other candidates as primary executable host:
- Google Cloud free e2-micro: approximately 1 GB RAM, insufficient confidence for parallel OS+Node+Chromium+video transfers.
- Cloudflare Workers: good for lightweight control APIs, not a persistent headed Chromium session.
- Render Free: sleeps after 15 minutes without traffic and has ephemeral filesystem.
- GitHub Actions: CI/testing and scheduled short jobs, not a reliable persistent Google Flow profile; public-repo schedules can be disabled after 60 days inactivity.
- Supabase Free: possible limited metadata/backup role, but dormant project pauses are a continuity risk.

## Hardware / browser caveat

The old Dockerfile installed Google's amd64 Chrome build. This branch switches to Debian Chromium on ARM64, preserving Google Chrome Stable on amd64. The Flow composer, asset picker, authentication and download flows are still UNTESTED on ARM; this is a compatibility hypothesis, not confirmation.

## Deployment separation and safety

In this branch, the DB key automation:operatorActivated must be strictly true for Flow and publication workers to act. The supervisor cannot set the key. On a fresh persistent state database the key is absent and thus false. The legacy enable and live test routes are disabled. A future central dashboard must provide the only authenticated activation with multi-channel readiness assertions, a reconciliation-complete acknowledgment, tamper-evident audit entry and emergency stop control. **No endpoint currently activates it.**

The OCI Docker Compose draft binds the runtime to localhost only. A separately secured TLS reverse proxy / tunnel and authentication must be added before users can access it remotely. Each show must receive a distinct persistent data path; never share browser profiles or SQLite between unrelated channels.

Build-only safety checks (DO NOT run compose up):
- node scripts/safety-gate-selftest.mjs
- node --check server.js
- node --check free-browser-provider.js
- node --check flow-bootstrap.js
- node --check unattended-supervisor.js
- node --check publication.js
- node --check publication-facebook.js
- docker build -t publisher-factory-a1-safety .

The Dockerfile now invokes the static safety contract along with existing tests. CI build success is necessary but not sufficient for an unattended-production guarantee. Never put credentials or token profiles in GitHub.

## Human account prerequisite when the software reaches that phase

The operator must personally establish an Oracle Free Tier account and satisfy its identity verification. The home region is a permanent decision: Always Free A1 resources are only available there. Do not create any paid / trial-credit-only instance. If the A1 option is unavailable, record the blocker; do not substitute a paid VM. After that, an instance can be staged with no live Flow submissions and no publication.

## Remaining software acceptance criteria

1. Cross-show factory dashboard with all channel panels, visible PAUSADA status, and an explicit Activar automatización button disabled until independent tests and historical reconciliation finish.
2. Confirm all remote-action routes are guarded, including startup, manual redo, provider retry, OAuth reconnection, publication, and schedule rewriting.
3. Migrate historical SQLite/video/auth session safely without modifying existing data; back up and verify checksums.
4. Verify on ARM without submitting: Chromium, Flow saved project, character references, anti-duplicate recovery logic and cookies. Later obtain explicit separate consent for a real test.
5. Confirm storage retention budget, snapshots, restart and outage recovery, certificate renewal and owner notifications.
6. Verify YouTube/Facebook platform OAuth, the actual publication day mode and metadata/publish actions in isolated mocks.
7. No claim of unlimited uptime or guaranteed perpetual free service is permitted.

Official documentation:
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
