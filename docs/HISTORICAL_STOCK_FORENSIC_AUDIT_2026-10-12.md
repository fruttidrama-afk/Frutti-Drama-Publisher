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

## New forensic results, 2026-10-12 after initial incident record
- Previous GHA workflow `Inspect Railway Volumes For Migration` run `37706730975` (2026-10-08) attempted a CLI read-only directory listing. Frutti, Earth and Dinnie ALL returned `VOLUME_FILE_ACCESS_BLOCKED`, with Railway specifying: *service has no active deployment in environment production; deploy or restart before file commands.* The status of live metadata volumes does **not** imply file contents are absent. The operator has explicitly prohibited Railway operational execution, so no restart/redeploy has been attempted.
- The same previous run identified Dinnie historic Railway project `dee1ef06-da39-4b5c-ae87-b6d61b78e572`, volume `dinnie-the dinosaur-volume` (ID `49084bd0-520e-4590-88f5-97a46639ef27`) and mount through its old service. Present Railway project access check returned `You don't have the required role (viewer) on this resource`. Do not claim that this volume is currently retrievable.
- Old repository `ops-diagnostics/runtime-health.json` captured 2026-10-05 22:46Z confirms Dinnie `publication_copy` contained FOUR dated Facebook records with remote IDs: E1 `published` and E2–E4 `processing` at that time. These were historical REMOTE Facebook lifecycle records, not four unposted stock assets; do not reupload them automatically.
- The new Supabase bucket contains Frutti 31 MP4 files corresponding to 31 distinct filename keys, and Earth 16 MP4 files corresponding to 13 distinct filename keys (three additional revisions of an existing key). This is filename deduplication only, not byte-hash or canonical media deduplication. Supabase contains no Dinnie objects in that bucket at present.
- Shared owner-scoped Edge `publisher-unified-read` v3 and Factory HTML now have **separate read-only historical MP4 archive evidence** alongside the partial migrated stock index. Archive counts are not approvals/scheduled stock. Two UI modules passed GitHub Actions smoke run `38290616744`. No live real-user browser verification yet.
- Next: find a safe verified historical volume backup/archive or provider-supported offline read access WITHOUT activating an old publisher service, reconcile original `publication_items` and `factory_items` against these object keys and published remote IDs. Preserve a separate `source_system` and confidence for every event; do not merge/apply any stock until confirmed.

## Railway native backup API — VERIFIED 2026-10-12 18:54 UTC
GitHub Actions read-only run `38293980450` successfully called Railway GraphQL through scoped Supabase Edge `publisher-railway-volume-migration` version 5 with no Railway mutations or deployments. Query order: project volumes -> volume instance scoped to production environment -> volumeInstanceBackupList.

Results:
- FruttiDrama volume `089f6382-78ca-49ff-9898-68b13b1f0dca`, instance `ec05b836-8708-4dfa-9b6c-b86f634fd2f7`: `status=OK`, `backup_count=0`.
- Earth volume `89fe08a3-5fad-40a1-b8cb-c4dad3b5e924`, instance `855c98dc-46a1-41e5-bdff-80a15f8adde6`: `status=OK`, `backup_count=0`.
- Dinnie volume `49084bd0-520e-4590-88f5-97a46639ef27`, instance `8c4166e2-f459-4016-b149-0bfada1e8a70`: `status=OK`, `backup_count=0`.

Inference limited to *zero Railway-native snapshots available for the three verified volume instances at query time*. Does not imply the live volume files are absent, and does not rule out separately exported archives elsewhere.

CRITICAL NEXT GATE: No original Railway service restart/redeploy/reattachment or billable recovery container without operator's explicit approval of a scoped, read-only forensic extraction plan. No backup snapshot exists to roll back accidental damage; in particular Frutti's historical volume was at 100% capacity in the October 5 health snapshot. Prefer vendor-assisted storage-level export if available; otherwise a one-off isolated extractor would require its own approved change/rollback plan and verified source volume immutability. Railway CLI had previously blocked file reads when no service deployment is active; do not represent unsupported CLI reading as completed.

All work to date has preserved MP4 objects and historical records, without regenerating, approving or publishing media.

## Current Review-to-Archive identity comparison
Read-only SQL on 2026-10-12: six FruttiDrama `review_items` records in the migrated runtime inventory have **zero exact item-ID filename matches** with the 31 MP4 objects in `fruttidrama/review/`. That means the archived 31 files are not simply the six newly indexed review-item IDs. It does **not** prove no video bytes are duplicates, nor establish approved status. Any future inventory must keep both sets and deduplicate by verified content hash / original event identity, not by assumptions.

## 2026-10-12 19:00 UTC: Preservation gate
Operator authorized a forensic extraction. Railway native backup creation via GraphQL was denied for all three volumes because manual snapshots require a Pro workspace (GitHub run 38294733385). No snapshot or runtime deployment was created. FruttiDrama and Earth original volumes were confirmed unchanged with no pending staged changes. Extraction paused before any volume mount, service start or file modification. The user must choose Pro-backed snapshot first or separately accept the elevated risk of working with no snapshot. Supabase incidents FORENSIC_BACKUP_UNAVAILABLE remain open for all three.

## PRIORITY CORRECTION — SUPABASE-FIRST ZERO-BUDGET (2026-10-12 19:50 UTC)
The operator recalled that the reason for migrating historical approved stock out of Railway was its full volume. The contemporaneous 2026-09-22 project record confirms that **12 original FruttiDrama MP4s (~95 MB) had already been migrated to private Supabase**, with 19 total stock counted then (12 Supabase and seven legacy YouTube remote-only items, T2E16 and T2E18–T2E23). This is **a dated observation, not the October 12 final stock count**. Do not claim the 31 current Frutti archive objects represent 31 approved publications without ledger evidence.
- Current accessible Supabase project list contains only `publisher-factory` (`wrflttnmlrsuzuukdhtf`); private bucket `publisher-review-videos` contains 31 Frutti files (151,240,910 bytes) with **31 distinct storage eTags**, 16 Earth files (93,120,074 bytes) with **13 distinct eTags**. Four Earth objects named `publication-07f693b5-...` share one eTag and length; three are content repeats, NOT four distinct videos. No Dinnie objects are present IN THIS BUCKET.
- Frutti file-name labels: 8 `stock-`, 7 `manual-legacy-rescue-`, 16 UUID-only. Earth: 14 `publication-`, 1 `stock-recovery-`, 1 UUID-only. These are category clues, NOT proof of approved status. All 47 object metadata rows have no business-level season/episode/scheduledAt fields; `user_metadata` on sampled stock files is empty.
- Source code `publication.js` and older `publisher-runtime/publication.js` explicitly implement `migratePendingPublicationMedia()`: for rows in historical SQLite `publication_items`, `uploadReviewFile(local,{itemId:'publication-'+item.id})` uploads MP4 to Supabase and **only the SQLite row** continues to hold episode, approval, schedule, final metadata and URI `review-storage://...`. This explains why the new Oct 7 `state.tgz` stock index is zero despite preserved remote MP4 bytes: NOT a deletion proof, but no schedule rows migrated.
- The old Oct 5 `ops-diagnostics/frutti-runtime-health.json` retains a historic Season 2 release plan with 12 dated rows E2–E13 (Sep 20 through Oct 1 at 19:00 ART). Those rows do not prove media approval nor later status; E13 was `auth_wait` with no remote video ID then. Old queue `queued:27` is a general creative queue count, not a verified stock count.
- Free reconciliation priorities: (1) preserve Supabase bytes, (2) catalog storage eTags, object IDs, sizes, timestamps; (3) match publication IDs embedded in cloud names to any historic GitHub diagnostics/remote publishing IDs and existing SQLite/YouTube/Facebook state; (4) obtain verified episode/schedule ledger for gaps without guessing; (5) publish NOTHING until ledger reconstructed and operator-approved.
- **ZERO SPEND:** The operator cannot pay for Railway. No Hobby or Pro subscription should be recommended as a dependency. Both historical Railway services are OFFLINE with inert forensic start commands; do not restart or deploy them. Railway is NOT a prerequisite for preserving or auditing the Supabase MP4s. Investigate no-cost support/export only if genuinely necessary.
