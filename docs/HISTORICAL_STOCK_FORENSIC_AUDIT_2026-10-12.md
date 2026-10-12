# Historical stock forensics — 2026-10-12
Status: OPEN INCIDENT, reconciliation incomplete. READ-ONLY EVIDENCE. No media generation, deletion, publishing, state overwrite, browser reconnect, service restart or Railway redeployment authorized by this document.

## Operator-reported pre-migration expectation
- FruttiDrama: at least ~30 approved videos held INTERNALLY, with one-per-day release schedule, NOT early-uploaded as private YouTube videos.
- EARTH IN 10: multiple approved internal media stock items.
- Dinnie The Dinosaur: fewer than ten approved internal items.
These are operator-reported historical baselines and require source-of-truth verification. Never replace them with zero from a newly initialized runtime.

## What the new Factory's "0" actually means
`publisher_runtime_inventory` is a read-only projection of the `publication_items` table in current Supabase Storage `publisher-runtime-state/<publisher_id>/state.tgz`. On 2026-10-12 its snapshots reported zero publication_items stock for all three. This index does NOT query the preexisting Railway persistent volumes, historical runtime databases, all archival assets or historical scheduling metadata; therefore it cannot prove that historical stock was absent or lost.
- FruttiDrama current state.tgz ~20,083,947 bytes; current SQLite 6 review / 9 draft / 0 indexed stock.
- EARTH current state.tgz ~65,695 bytes; current SQLite 0 review / 9 draft / 0 indexed stock.
- Dinnie current state.tgz ~69,254 bytes; current SQLite 0 review / 9 draft / 0 indexed stock.
These figures are MIGRATED-INDEX figures, not historical inventory.

## Verified Supabase archival objects, 2026-10-12
Private bucket `publisher-review-videos` still contains 47 MP4 files (~244,360,984 bytes), created between 2026-09-22 and 2026-10-02:
- `fruttidrama/review/`: 31 existing MP4 files, 151,240,910 bytes; 31 distinct filename keys. Eight filenames begin `stock-` and seven `manual-legacy-rescue-`, but names alone do not prove current approved/queued status.
- `earth-in-10/review/`: 16 MP4 objects, 93,120,074 bytes, corresponding to 13 distinct filename keys. Four objects share one publication key; dedupe by remote IDs, file content hashes and schedule state before counting.
- No Dinnie objects in this bucket. This does NOT prove absence of Dinnie's historical local media.
Storage objects are REAL. Review-media archive != scheduled-stock ledger; review/staging assets may include duplicates and rejected versions. Do not auto-approve/upload any asset from filenames.

## Preserved Railway source candidates (read-only environment inspection)
- FruttiDrama: Railway project `virtuous-joy`, historical volume `fruttidrama-publisher-volume`, 500 MB mounted at `/data` on old `FruttiDrama-Publisher` service. Latest deployment FAILED/REMOVED. Volume remains registered LIVE; directory contents not directly inspected, so no claim that particular MP4s survive inside.
- Earth: project `kind-illumination`, volume `earth-in-10-volume`, 500 MB mounted at `/data`. Historical service's latest deployment failed/skipped, volume remains registered LIVE. Media contents not yet inspected.
- User has prohibited Railway as production runtime; do not restart, redeploy, mount elsewhere or write to these volumes while auditing. Read-only offline copy/export where legitimately available is the preferred next step.
- Dinnie historical storage location still unresolved. Do not infer empty stock from the absence of files in the shared review bucket.

## Additional Frutti historical evidence
Old repository `fruttidrama-afk/FruttiDrama-Publisher`, `ops-diagnostics/frutti-runtime-health.json` captured 2026-10-05 22:38:49 UTC:
- Historical persistent storage total 454,299,648 bytes, free 0, used 454,299,648 bytes.
- Queue counts: 27 `queued`, 36 `draft`, 99 `future_hold`, 12 `historical`, 1 `regen_wait`. THESE ARE GENERAL WORK QUEUE STATES, NOT necessarily 27 approved stock videos.
- Legacy `season2_stock_plan` shows dated episode release entries and a publication `T2E13` in auth_wait. This proves historical scheduling records did exist, but not today's complete 30-video approved-stock roster.
- The current migration may have omitted a historical publisher SQLite file or prior accepted-stock objects. Not confirmed lost.

## Incident protections already installed
1. Integrated Publisher Factory UI now labels the zero as partial migrated index and clearly warns that historic stock is not reconciled.
2. Open `HISTORICAL_STOCK_UNRECONCILED` incidents recorded for FruttiDrama, EARTH IN 10 and Dinnie. Do not auto-close them because new runtime shows zero.
3. No video, playlist, scheduled release, cloud object or volume has been deleted, moved, regenerated or published during this audit.

## Required safe recovery protocol (not yet executed)
1. Acquire READ-ONLY copy of historical publisher runtime SQLite DB and `publication_items` + `factory_items` metadata from old Railway volumes or verified dated backup; do not restart old production or modify the source volume.
2. Identify and inventory historical stock items with media object pointers, file hashes, video IDs, approvals and local scheduledAt dates, per publisher. Distinguish stock from Review, rejected revisions and publication history. Verify actual MP4 bytes exist and play/duration is plausible without generating videos.
3. Cross-reference Supabase review-media object keys and the current `state.tgz` SQLite rows. Deduplicate by immutable media identity and content hash, preserving ordering and show/season/episode.
4. Build a VERIFIED migration map and a read-only reconciliation report (historical vs new vs missing pointers), noting confidence and risks. Preserve a rollback archive.
5. Only after operator agrees to reconciliation and all invariants pass, merge historical stock records under isolated publisher_id and restore dates with no early YouTube private staging, no duplicate media and no schedule drift. Do not write stock to current runtime if source records are uncertain.
6. After validation, surface verified `legacy stock` separately from the migrated index and close incidents individually only on real evidence.
