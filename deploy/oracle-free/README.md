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

## Read-only dashboard preview (optional, never publishers)

The real OCI VM **passed** the one-command host acceptance on November 18, 2026:
local ARM64 Docker build, internal-browser Playwright+sharp, full paused runtime,
three-channel Compose policy, zero network during probes, zero new generations or
publications. The final user-supplied log ended with:

```
[OCI ACCEPTANCE] PASS: safe ARM64 build, Chrome, paused runtime, multi-show Compose; factory still OFF
```

A separate, explicit operator-only command can start **only the dashboard** on
the already-validated host: `bash scripts/oci-hub-preview-only.sh`. This is
not part of acceptance, does not start publisher services, and only binds
127.0.0.1:8081. It refuses an activation file and refuses to overwrite an
existing operational `.env`. A fresh dashboard preview generates a private
64-character random password kept in `deploy/oracle-free/.env`; do not send
that file or password to chat or GitHub. The preview does not generate, recover,
schedule or publish content. The activation button is hard-disarmed. Because
none of the three publisher children is deployed, individual service status
cards may show `SIN RESPUESTA` until they are independently staged. This is
not evidence of a failed dashboard.

Access only through SSH local forwarding, e.g. `ssh -L 8081:127.0.0.1:8081`
with the preexisting user, host and private key; then browse
`http://127.0.0.1:8081/`. Never open a public OCI ingress rule for 8081.
The password can be read privately from the host .env, but must not be
included in shared logs. This preview is explicitly non-production and is not
an invitation to reconcile history or activate scheduling.


## Independent HTTPS gateway and three paused children — preactivation staging

The opt-in Caddy gateway is a fifth Compose service, separate from the three publishers.
The root Hub retains local-only port 8081, while HTTPS gateway exclusively exposes TCP
80/443 and proxies the password-protected Hub. Child ports 8080, 8082, 8083 stay
bound to localhost. Neither HTTPS setup nor paused-child staging creates an
operator activation file, starts a production Flow action or publishes content.

Candidate no-cost DNS name for the recorded Oracle public IPv4:
https://129-146-3-38.sslip.io/. The sslip.io domain is third-party-owned; it
derives the public IP from its hostname, so durability depends on that DNS
service and preservation of the Oracle IP. Caddy provisions and renews ACME
certificates only when TCP 80 and TCP 443 are publicly reachable. No HTTPS
certificate or Internet reachability has yet been verified on the real host.
This is not a guarantee of indefinite uptime or ongoing zero cost.

Manual staging commands (in the existing SSH session, after updating branch):

- bash scripts/oci-https-gateway.sh check
- bash scripts/oci-https-gateway.sh enable
- bash scripts/oci-https-gateway.sh status
- bash scripts/oci-stage-paused-children.sh

The operator must first verify Oracle VCN security list/NSG permits inbound
TCP 80/443, and host firewall agrees. Never open ports 8080–8083 to public ingress.
Do not bypass TLS certificate checks. The gateway command refuses a missing
password, foreign preview .env, activation file, public 8081, unexpected
publisher container or DNS resolving to the wrong IPv4. Running the HTTPS
command does not activate the factory.

The child staging script creates independent, high-entropy session/setup
credentials per channel, without sharing the Hub's password with any
publisher. It refuses unmanaged child configs or pre-existing historical
state and does not migrate or overwrite any real historical episodes.
A successful result requires all three health responses to prove
operator_activated=false and publisher_enabled=false, even after the
background worker tick. Children then appear as PAUSADA rather than the
explicit staging label NO DESPLEGADO.

A running paused child is NOT ready for production: real saved Flow projects,
persistent authenticated profiles, YouTube/Facebook OAuth identities, backups,
verified historical dispositions and a one-off LIVE Golden Test are separate
acceptance criteria. The Golden Test must show exactly one real Flow video
recovered into Review, approved by the operator and uploaded privately to
the expected YouTube channel. The operator must independently verify
the private video ID on YouTube. No CI mock or invented project/title/token
can fulfill that criterion. Auto activation remains forbidden.

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


## Alternative if OCI MFA prevents network changes: protected temporary HTTPS preview

If Oracle Console access is blocked by a broken MFA device, **do not modify the
OCI firewall by guesswork**. The local Hub can still be viewed remotely by an
**outbound-only Cloudflare Quick Tunnel**, requiring two independent checks:
Cloudflare one-time email PIN restricted to one explicit email address, then
Hub HTTP Basic authentication. This is temporary test access, not a stable
hostname or a substitute for production security. Nothing publishes or generates.

Cloudflare documentation (as of September/October 2026):
https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
https://developers.cloudflare.com/tunnel/downloads/

On the already accessible Oracle ARM64 VM, after updating the safety branch and
refreshing the paused Hub, install the official Cloudflare ARM64 package
only if `cloudflared` is missing:

```bash
curl -fL --retry 3 -o /tmp/cloudflared-linux-arm64.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i /tmp/cloudflared-linux-arm64.deb
```

Then use the fail-closed scripts:

```bash
bash scripts/oci-quick-tunnel-preview.sh check
bash scripts/oci-quick-tunnel-preview.sh start 'YOUR_ACTUAL_EMAIL@example.com'
bash scripts/oci-quick-tunnel-preview.sh status
# To disconnect remotely accessible dashboard:
bash scripts/oci-quick-tunnel-preview.sh stop
```

The script refuses an absent managed Hub credential, password weaker than the
preview policy, an already-created activation file, a public listener on port
8081, an unauthenticated Hub health result other than HTTP 401, an unverified
activation-armed Compose configuration, a missing email allowlist or a missing
cloudflared installation. It starts no other application/container and opens
no OCI inbound port. It never prints Hub credentials.

**Important**: Cloudflare says Quick Tunnels have no uptime guarantee, random
hostname each restart, up to 200 in-flight requests and no SSE. The cloudflared
connector must remain running, and Cloudflare's email OTP must remain accessible.
A permanent hostname will later require an authenticated, locally or remotely
managed named tunnel and routing for a domain owned/controlled by the operator,
or restoration of OCI MFA + TCP 80/443 + Caddy certificate issuance. Never
pretend the random trycloudflare.com URL is a permanent production endpoint.

Test without external traffic or account data:
`bash scripts/oci-quick-tunnel-offline-probe.sh`.
