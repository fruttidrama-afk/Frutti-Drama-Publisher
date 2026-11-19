# YouTube Shorts publication policy — November 18, 2026

**Operator-selected policy:** do not upload a Short as PRIVATE hours before public release. Keep the approved MP4 in private local/review storage until its actual publication time, then initialize one YouTube `videos.insert` request with `status.privacyStatus="public"` and `status.containsSyntheticMedia=true`. No `status.publishAt`, no 12:30 PRIVATE staging, and no later automated PRIVATE-to-PUBLIC privacy update.

This is a product/workflow decision requested by the operator. **Do not present an algorithmic penalty for private pre-uploads as a proven YouTube fact.** The technical change ensures the desired direct-PUBLIC process regardless of uncertain distribution effects.

## Source verification

- YouTube Data API `videos.insert` explicitly permits `status.privacyStatus` equal to `public` and `status.containsSyntheticMedia`. Documentation: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- **November 2, 2026** YouTube Data API revision reversed the former unverified-project private-only upload restriction. Projects without prior audit are no longer automatically restricted to PRIVATE viewing due to unverified API status; individual creator account settings or other policy restrictions can still cause PRIVATE results. Revision history: https://developers.google.com/youtube/data/revision_history
- `status.containsSyntheticMedia` is supported in `videos.insert` and `videos.update`. Status reference: https://developers.google.com/youtube/data/reference/rest/v3/videos

## Runtime invariants

1. A new approved item is queued in **private stock** with `uploadAt === scheduledAt`; no third-party upload happens before release time.
2. The direct upload may initialize only on the same configured local calendar day, from the release slot to at most 30 minutes afterward. No backlog catch-up on another day.
3. Before the first HTTP request, the runtime records an immutable `publication_safety_fences` entry with kind `youtube-direct-public-upload`. A unique index on `itemId` prevents a second insert for the same approved episode on any later day, even if the first result was ambiguous.
4. Every new resumable session is durably marked `uploadMode='direct-public'`. Sessions created by the old private-staging policy are not resumed automatically; they require human reconciliation.
5. Before reserving an irreversible upload, the runtime calls YouTube `channels.list(mine=true)` and compares the authenticated channel against the operator-verified exact `UC...` ID in `PUBLISHER_EXPECTED_YOUTUBE_CHANNEL_ID` or the private show config's `publication.expected_youtube_channel_id`. If absent or different, the upload is blocked **before** a fence or network insert.
6. The initial insert includes title, description, approved upload file, `selfDeclaredMadeForKids:false` and `containsSyntheticMedia:true`. A private setting resulting from a particular channel configuration must be treated as operator attention, not silently made public through a second API mutation.
7. The local MP4 is **not deleted** until an authenticated YouTube API response establishes `privacyStatus='public'` for the exact video ID. A public page or oEmbed result is not conclusive proof of authenticated privacy state.
8. Historical PRIVATE video IDs and ambiguous private uploads remain readable but **no automatic privacy or metadata changes** are allowed. The operator must reconcile them later.
9. All activation gates remain default CLOSED. No tests run against Google credentials, the Internet or real videos. `youtube-direct-public-selftest.mjs` intercepts each HTTP call and exercises success, forced-private results, ambiguous sessions and no duplicate uploads.

This applies to **YouTube** channel publishers only. Facebook Reels retains its own independently tested three-phase upload and native AI disclosure rules.

## Preproduction restrictions

During factory reconstruction, do not upload any real videos, update privacy settings or attempt Flow recovery. Before enabling live activity, validate the actual OAuth identity, YouTube channel ID, quota policy, exact title/description metadata provenance, backup and final operator approval. The new scheduler is not evidence of having completed those checks.
