# FLOW RECOVERY RUNBOOK

- AUTH_FAILED → preserve lifecycle, reauthenticate persistent profile, reverify exact project.
- WRONG_PROJECT → no submit; resolve exact project from Flow home.
- PROMPT_FAILED → clear/reinsert once; verify title unchanged; otherwise stop.
- CONFIRMATION_FAILED → preserve submit boundary; reconcile exact project; no resend.
- SUBMIT_AMBIGUOUS → read-only reconciliation; automatic_submit_forbidden=true.
- GENERATION_TIMEOUT → keep serial lock; wait/reconcile; no next episode.
- TEMPORARY RENDER DISAPPEARED → after safety window and exact baseline restoration, mark no_generation and permit one clean serial retry.
- INSUFFICIENT_CREDITS → no_generation accounting, long backoff, state ESPERANDO CRÉDITOS.
- DOWNLOAD_FAILED → retry same asset only.
- VIDEO_INVALID → redownload same asset; no regeneration.
- YOUTUBE_AUTH/UPLOAD_FAILURE → publication-specific retry; never return to Flow generation.

- WRONG_RECOVERED_ASSET → recovery-only mode; NEVER regenerate if the correct render already exists. Verify exact project; load target submit baseline; capture stable Flow asset IDs; diff grid as a multiset; use the next later submit baseline as the temporal upper bound; reject asset IDs already recovered; re-verify the same asset ID immediately before click; download that exact existing asset; validate MP4; reject reused/quarantined SHA-256; persist flow_asset_id + recovery proof + content hash; replace only the Review media; preserve original generation accounting.
- FIXED_SIZE_FLOW_GRID → tile count is not identity. A new render may replace/reorder a tile while video_tile_count stays constant. Never use "first tile" or DOM index alone.
- TARGETED_RECOVERY → a recovery token is read-only with respect to generation. It may inspect/open/download existing Flow media but must return before any Generate path, whether recovery succeeds or remains pending.
- APPROVAL_ENOSPC → do not copy the Review MP4 to another directory on the same /data volume. Transfer ownership of the exact existing local path to the publication row, then clear factory_items.videoPath only after the publication row is durable. Never regenerate/redownload because approval ran out of disk space.
