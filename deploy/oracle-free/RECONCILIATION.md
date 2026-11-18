# Historical Reconciliation Studio (PREACTIVATION ONLY)

This component exists to reconcile actual historical video assets and exact Google Flow generation prompts **without** merging old guesses into the publisher stock or invoking any generation, recovery, scheduling or publication worker.

## Provenance and isolation

- The video pane enumerates only actual `.mp4` files in `deploy/oracle-free/reconciliation-media/<channel-id>/`. It computes SHA-256 over each real file and serves authenticated, range-supported read-only playback.
- The historical-post pane reads `deploy/oracle-free/reconciliation/posts/<channel-id>.json`: an array of actual imported records, or an object with a `posts` array. Accepted fields: `id`, `title`, `prompt` or `flow_prompt`, `description` or `caption`, `created_at` or `published_at`.
- The panes are **independent**. Importing a source post does not link it to any video. The operator must visually compare the video to the source, enter the correct season/episode, supply the exact prompt, confirm, and save.
- Mappings are stored only in `deploy/oracle-free/reconciliation/assignments/<channel-id>.json`, not the production SQLite tables. Revisions retain a hash-linked local audit trail. A matching season/episode cannot silently be assigned to a second video.
- Metadata is marked `pending-canonical-copy-review`. The initial reconstruction studio **does not generate titles or descriptions** from guessed content. Canonical YouTube text will be generated and separately verified only after the source prompt and video mapping are confirmed.
- If an assignment JSON is malformed, the API errors rather than replacing the historical mappings with an empty file.
- All API endpoints use the Hub's existing HTTP authentication. The write endpoint additionally requires an explicit `X-Reconciliation-Operator: manual-verified` header and an origin check.

## No historical action required during technical recovery

No real videos, prompts, episodes or old login profiles have been imported to Oracle by the safety tests. Do not populate this directory or perform historical reconciliation until the factory infrastructure and backup plan are formally ready for preactivation. The authoritative published FruttiDrama checkpoint is Season 2 Episode 8; any later mapping is **unverified** until the operator manually confirms it.

The production databases remain untouched. No live Flow login, API call, YouTube upload, Facebook action, or playlist creation occurs in this studio.

## Import/readiness acceptance criteria

1. Verify independent checksummed copies of source files and the origin of each historical post before import. No original should be deleted or rewritten.
2. Copy source MP4s only into the read-only media mount and imported posts only into the standalone reconciliation data directory.
3. Inspect the Hub over a secured connection; its host ports are bound to localhost and must never be opened directly in OCI ingress rules.
4. For each actual video, inspect playback, select the actual season and episode, paste/choose the actual generation prompt, and confirm manually.
5. Export and independently back up the resulting assignment ledger before any eventual transfer to live stock. Reconcile conflicts separately. Never infer mappings by filenames, timestamps or neighboring shots.
6. Do not enable automation as a result of an imported file, a matching hash or a completed assignment. The central activation button remains separately disarmed and requires complete operational readiness plus operator authorization.

## Offline test

`node scripts/reconciliation-offline-probe.mjs` uses invented media bytes and one synthetic historical post. It checks HTTP authentication, independent source panes, exact SHA-256 content identity, authenticated playback ranges, lack of inferred links, manual assignment, preservation of exact prompt bytes, duplicate episode rejection, and no production database creation. It does not need any external services or credentials.
