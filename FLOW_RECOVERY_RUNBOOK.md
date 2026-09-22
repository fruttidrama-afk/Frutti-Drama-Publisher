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