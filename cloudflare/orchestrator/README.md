# Publisher Factory Free Runtime

Target architecture: **Cloudflare Workers + D1 + R2 + public GitHub Actions**.

This replaces Railway. Railway is no longer an allowed deployment target because an expiring trial violates the Publisher Factory infrastructure policy.

## Runtime contract

- Cloudflare Cron materializes durable daily obligations.
- Every enabled publisher receives 3 generation obligations/day and 1 publication obligation/day by default.
- D1 is the control-plane source of truth.
- Only one obligation may mutate a publisher state bundle at a time.
- GitHub Actions runs the existing FreeBrowserProvider/runtime ephemerally.
- R2 stores encrypted runtime state and the portable Flow browser profile.
- A post-submit timeout never authorizes a duplicate submit. Updated state is saved and the same obligation is reconciled on retry.
- Review approval remains human-only.
- Publication requires approved stock.
- YouTube media stays outside YouTube until release time and is uploaded directly PUBLIC at 19:00 ART.
- Railway must never be used as a fallback.

## Required Cloudflare secrets

- `GITHUB_TOKEN`: fine-grained token permitted to dispatch `free-runtime-runner.yml`.
- `RUNNER_SHARED_SECRET`: random high-entropy secret shared with GitHub Actions.

## Required GitHub Actions secrets

- `FREE_RUNTIME_ORCHESTRATOR_URL`
- `FREE_RUNTIME_RUNNER_SECRET`
- `FREE_RUNTIME_STATE_KEY`: high-entropy encryption passphrase used for R2 state/profile archives.

## Provisioning

1. Create one D1 database and apply `schema.sql`.
2. Create one R2 bucket.
3. Copy `wrangler.toml.example` to `wrangler.toml` and insert the D1 ID.
4. Add Worker and GitHub secrets.
5. Deploy the Worker.
6. Import publisher rows/configs.
7. Upload an encrypted state snapshot and an encrypted Flow browser-profile snapshot for each existing publisher.
8. Run the Golden Test before enabling Cron.

The final unattended acceptance test is not a heartbeat test. Over 10 unattended days, each publisher must produce 30 new Review-ready videos and confirm 10 scheduled publications when approved stock is available.
