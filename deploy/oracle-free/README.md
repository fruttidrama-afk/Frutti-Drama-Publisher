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

## YouTube publication policy — canonical two-stage contract

For **FruttiDrama and EARTH IN 10 only** (Dinnie continues on Facebook), the
publication scheduler retains approved MP4 in private Stock until the assigned
local day. At **12:30 America/Argentina/Buenos_Aires**, exactly one approved
video is uploaded to YouTube with `status.privacyStatus=private`. The videoId
and resumable upload mode are persisted and cannot be initialized a second time.
At **19:00 the same day**, YouTube's authenticated API must confirm that exact
video belongs to the operator-verified destination channel; then exactly one
explicit `videos.update` sets it to `public`. The same videoId is retained.
Never use YouTube `publishAt`, never call a second videos.insert at 19:00,
never publish an old unknown PRIVATE video automatically, and never catch up
missed days without human reconciliation. The approved source file survives
until publication is authoritatively confirmed. Both external mutations have
durable one-time fences. The explicit expected YouTube channel ID is required
in the later private channel config; the safety draft does not invent it.

Regression tests run on synthetic SQLite, synthetic videos and intercepted
network calls. They also verify paused mode, wrong OAuth destination, old
PRIVATE records, old direct-PUBLIC fences and a foreign PUBLIC videoId. No
real YouTube or Facebook access is performed by these tests.

## Single-command host acceptance — still no production deployment

After updating the safety branch on the existing ARM64 host, run:

```bash
bash scripts/oci-image-acceptance-offline.sh
```

This fail-closed script checks that the factory has no running publisher
containers and no activation file, validates a disposable Compose fixture,
builds the ARM64 image (public package downloads may occur), and runs Chromium
and complete paused-runtime probes in containers with **`--network none`**,
no production volumes, no tokens, and no forwarded ports. It does **not**
start any production publisher, run Flow, create episodes, queue uploads,
publish, reconcile history, or activate the Hub. Preserve the command's
PASS/FAIL output for engineering acceptance. The old ARM image passed earlier
smoke checks, but any new code revision needs fresh host validation.

## Hardware / browser caveat

The old Dockerfile installed Google's amd64 Chrome build. This branch switches to Debian Chromium on ARM64, preserving Google Chrome Stable on amd64. The Flow composer, asset picker, authentication and download flows are still UNTESTED on ARM; this is a compatibility hypothesis, not confirmation.

## Deployment separation and safety

In this branch, the DB key automation:operatorActivated must be strictly true for Flow and publication workers to act. The supervisor cannot set the key. On a fresh persistent state database the key is absent and thus false. The legacy enable and live test routes are disabled. A draft central dashboard has channel cards, an `Activar automatización` control and an emergency stop endpoint, but activation is **hard-disarmed** in the deployment draft (`PUBLISHER_HUB_ACTIVATION_ARMED=false`) and further historical reconciliation/readiness gates are required. Append-only, tamper-evident operator audit and full cross-channel migration are still pending, so **do not deploy or enable activation yet**.

The OCI Docker Compose draft now has **three isolated existing-show children**: FruttiDrama (SSH tunnel localhost 8080), Earth in 10 (8082), and Dinnie the Dinosaur (8083), plus the central dashboard (8081). Each child has its own `/data` volume and private `factory.sqlite`, Flow profile, selected publication provider, and per-channel config file. They share only the read-only central activation file and a global Flow lock to prevent cross-show concurrent browser activity. Every service requires an explicit Compose profile; bare `docker compose up` starts none of them. All child services still force `PUBLISHER_ENABLED=false` and the Hub is `PUBLISHER_HUB_ACTIVATION_ARMED=false` in this reconstruction draft.

The private common `deploy/oracle-free/.env` and individual `deploy/oracle-free/channels/<id>.env` files **do not exist yet**. Only example identity configs are committed. The examples contain no invented canonical prompts, Flow character assets, project IDs, historical data, or OAuth connections. Creating real configs belongs to later preactivation, after the system has been independently validated. The `operator-preflight.mjs` guard rejects a missing secret or a channel loading the wrong show's config before any Node runtime initializes SQLite.

The OCI Docker Compose draft binds all host ports to localhost only. Use a separately secured SSH tunnel (or subsequently approved TLS architecture) to inspect any panel; never expose ports 8080–8083 as public inbound rules. Three Chromium processes may consume substantial RAM even when their Flow submissions are serialized; the 3 GB per-child memory limits and CPU caps require prolonged staging verification before production. Unbounded historical media retention is impossible on the present 45 GB boot volume.

The OCI Compose draft intentionally requires a real `.env` for each service before deployment. **Do not create that file just to inspect Compose.** The offline probe `bash scripts/oci-compose-offline-probe.sh` copies the Compose YAML into a temporary directory, uses a disposable empty fixture `.env` plus three example child configs, validates safety settings, and removes that temporary directory. It never reads or creates credentials in the actual repository.

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

## Verified OCI staging host (November 18, 2026, user-supplied shell output)

- Ubuntu 24.04.5 LTS (`aarch64`), Oracle kernel `7.0.0-1013-oracle`, 2 OCPUs, approximately 11 GiB visible RAM.
- Approximately 40 GiB free of 45 GiB root filesystem at validation; about 2 GB of Docker images. **No swap** configured, so Chromium and video transfer memory spikes remain a risk.
- Docker 29.1.3, Docker Compose 2.40.3. Both 8080/8081 were not listening; global activation file absent; no publisher Docker services were running. No runtime has been deployed.
- Docker ARM image builds successfully. Isolated Chromium + Playwright selftest passed, using Debian Chromium 156.0.8078.79 with no network.
- Isolated runtime boot selftest passed with read-only health, authentication enforced, manual mutation routes locked, no generation/publication jobs, and no Flow visit. The delayed supervisor/provider timer boundary has a new test but still requires host rerun.
- These checks do **not** prove Flow login, a saved project, profile portability, OAuth integrations, real media retrieval, uninterrupted 24/7 operation or a long-term zero-cost guarantee.

## Persistent storage and cost risk

The remaining root filesystem is too limited for unbounded MP4 retention across all shows. Before migration, inventory the actual historical media sizes and make a documented retention/backup plan; **never delete historical media without verified independent copies**. The Oracle Always Free allocation permits 2 A1 OCPUs/12 GB RAM, 200 GB of combined eligible boot/block storage and limited free volume backups subject to eligibility and policy. Any new volume, public network component or backup must be checked against the actual tenancy's current Always Free quotas before creation. Oracle can reclaim idle Always Free instances. Do not generate artificial workload to evade reclamation. A zero-swap host should not receive three unconstrained Chromium publishers until resource limits and failure recovery have been tested.

Official reference: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Always Free validation against Oracle's official documentation (November 18, 2026)

Oracle's current Always Free eligibility describes **2 Ampere A1 OCPUs and 12 GB RAM total** across the tenancy (1,500 OCPU-hours and 9,000 GB-hours per month), **200 GB combined boot and block storage**, up to **five Always Free volume backups**, and **10 TB outbound traffic per month**. These are eligibility caps, not extra disk, a free backup service with unlimited retention, or proof that this specific account has those quotas available. Resources need to be Always Free eligible in the home region, and non-eligible volumes or backup counts can incur charges. No extra volumes, paid database, tunnel provider or object storage may be provisioned without actual tenancy quota and billing verification.

Oracle's idle reclamation terms can apply after seven days of very low CPU, memory and network utilization. **Never generate synthetic load to avoid reclamation.** This project has a genuine business workload, but that does not guarantee the VM will remain allocated permanently. A recovery plan with a verified backup is required before declaring production readiness.

Sources:
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm

## Secret and remote access policy

`PUBLISHER_SESSION_SECRET` must be a unique random value of at least 32 characters; the old known fallback is disabled. `PUBLISHER_SETUP_TOKEN` and `PUBLISHER_HUB_PASSWORD` must also be unique and confidential. A `.gitignore` blocks local `.env`, OAuth tokens, private keys, SQLite, Chromium profile state and media from new commits. The publisher/hub draft binds their host ports to 127.0.0.1; use an **SSH tunnel** while staging, not a public inbound 8080/8081 rule. Do not paste secrets into chat or GitHub.

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
