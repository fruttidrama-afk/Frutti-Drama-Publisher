# FLOW FAILURE CATALOG

See the canonical master SOP, sections 5 and 30–31. Core catalog:
- FLOW-ERR-001 CLICK_SUCCESS_FALSE_POSITIVE
- FLOW-ERR-002 STALE_CONSENT_CARD
- FLOW-ERR-003 WRONG_FLOW_PROJECT
- FLOW-ERR-004 RECOVERY_GATE_BLOCKED_PRODUCTION
- FLOW-ERR-005 GENERIC_BUSY_FALSE_POSITIVE
- FLOW-ERR-006 CHAT_VIDEO_OPTION_FALSE_POSITIVE
- FLOW-ERR-007 BRITTLE_MATERIAL_IDS
- FLOW-ERR-008 PROJECT_TITLE_CONTAMINATED
- FLOW-ERR-009 PARALLEL_GENERATION_CORRELATION_RACE
- FLOW-ERR-010 TIMEOUT_CAUSED_REGENERATION
- FLOW-ERR-011 CHAT_ONLY_RECOVERY
- FLOW-ERR-012 NETWORK_FILTER_ASSUMPTION
- FLOW-ERR-013 GENERIC_REVIEW_METADATA
- FLOW-ERR-014 GENERIC_EPISODE_INTENT_LEAK — a persisted generic fallback such as NEXT CHAPTER reaches Flow instead of a show-specific episode concept. Recovery: repair the episode intent before prompt checkpointing, clear stale generic prompts, and hard-block submit until the show-specific content gate passes.
- FLOW-ERR-015 WEB_STYLE_CONTAMINATES_VIDEO_PROMPT — Publisher/web reference styling leaks into the video-generation prompt. Recovery: isolate video visual style from branding/UI style and reject web-layout language from the video style channel.

- FLOW-ERR-016 CREATIVE_PACKAGE_DRIFT — prompt, title and description are created or recomputed at different lifecycle stages, producing incoherent publication metadata. Recovery: create them atomically from the same episode intent and Show Bible, bind them with a package hash, invalidate the whole package when the prompt changes, and preserve that package unchanged through review and publication.
- FLOW-ERR-017 COMPOSER_REQUERY_RACE — Flow reports ready, then remounts the prompt contenteditable after generation settings change; immediately querying the editor again can return no node and block the serial head-of-line. Recovery: carry forward the editor locator returned by the readiness gate, reacquire only through that same gate if fill fails, and regression-test this invariant in every Publisher Factory runtime.

- FLOW-ERR-018 NO_CHARGE_RETRY_STORM — repeated automatic submissions continue after Google Flow explicitly reports unusual activity and confirms no charge, risking provider throttling and permanently blocking the serial head-of-line. Recovery: preserve the same episode, do not click Flow's failed-tile Retry inside the same attempt, record a per-episode no-charge streak, and enforce the global provider-wide sequence 30m → 1h → 2h → 4h → 8h. Because the next doubling would exceed the 10-hour ceiling, every further consecutive unusual-activity rejection waits 24h before retrying. A confirmed retained render resets the provider streak and releases stale cooldown rows. Successful REDO renders count toward the same daily generation total. The streak is provider/account-wide rather than per episode. No other draft/REDO may bypass the cooldown, and stale rows may never shorten an active cooldown; reset the provider streak only after hard generation-start evidence.

Canonical recovery rule: UNCERTAINTY → RECONCILE; NEVER BLINDLY RESUBMIT.

## WRONG_FLOW_ASSET_RECOVERY_IDENTITY

**Symptom:** Flow generated the intended episode, but Review displayed an older video from the same project under the new episode metadata.

**Root cause:** DOM position and grid-count deltas are not media identity. Flow can reorder and virtualize a fixed-size grid, so selecting the first visible tile (or trusting a visible Download button) can open a stale asset.

**Permanent rule:** recovery is identity-first. Capture stable tile/media identifiers before selection, diff the post-submit grid against the baseline as a multiset, reject any `assetId` already present in `flow_recovered_assets`, re-read the same tile identity immediately before click, and persist the selected `flow_asset_id` with the Review item. After download, reject any SHA-256 already bound to another episode or listed in `flow_rejected_media_hashes`. A targeted recovery token is retrieval-only and must never fall through to Generate.

**Recovery of an already-generated correct render:** keep generation locked; select the unique unused Flow asset that matches the episode terms and the submit baseline, download that existing asset, validate it, and replace the wrong Review media. Never regenerate merely because recovery was wrong.

## APPROVAL_ENOSPC_SAME_VOLUME_COPY

**Symptom:** pressing APPROVE fails with `ENOSPC: no space left on device, copyfile '<review.mp4>' -> '<publication.mp4>'`.

**Root cause:** the old approval path duplicated the entire validated Review MP4 on the same persistent `/data` volume before deleting the Review copy. This required temporary free space equal to another full video and could fail even though the original approved media was already durable.

**Permanent rule:** approval uses a zero-copy ownership handoff. The publication row points to the exact existing Review MP4 path and records its current size; after that row is durable, the factory row clears its own `videoPath`. There is only one local copy. Publication owns and deletes that file later when the remote platform has durably accepted/published it or the publication is explicitly purged.

**Recovery:** keep the Review item and original MP4 intact; do not regenerate and do not redownload. Deploy the zero-copy approval path, reclaim only recreatable cache data if needed, and retry the explicit approval.

## FLOW-ERR-030 ZERO_USE_NON_ROLLOVER_CREDIT_DEADLOCK

**Symptom:** a Publisher remains at 0/3 after a new day even though enough Flow credits are visible.

**Root cause:** the prior daily cycle spent zero automatic credits. A non-rollover daily grant can replace the still-unused daily allocation without increasing the combined visible balance, so a detector that requires `current > previous` can wait forever.

**Permanent recovery:** after the normal guard window and a publisher-local day change, permit the next canonical batch when prior-cycle use is exactly zero and the live balance funds the complete batch. Keep positive-delta evidence mandatory for partially/fully consumed cycles so paid/monthly credits remain protected. Fallback must not exceed 24 hours.

## FLOW-ERR-031 QUARANTINED_SUBMIT_NEVER_RESUMES

**Symptom:** one `manual_hold` row permanently blocks every later serial episode although its lifecycle explicitly allows automatic recovery.

**Root cause:** quarantine removed the row from production selection but no transition returned it to read-only reconciliation.

**Permanent recovery:** if the row has real submit evidence, `automatic_recovery_forbidden=false`, and a recognized recoverable quarantine state, move the SAME row back to post-submit retrieval with `automatic_submit_forbidden=true`. Never authorize another Generate click.

## FLOW-ERR-032 LONG_LIVED_BROWSER_CHILD_LEAK

**Symptom:** after many unattended browser sessions, Xvfb/Chrome fails with process-fork errors even though the web service itself is alive.

**Permanent recovery:** run the container under a subreaper such as `tini`; close browser contexts normally and let the init process reap orphaned descendants. A worker restart must resume durable lifecycle state instead of resubmitting.

## FLOW-ERR-033 FLOW_DOWNLOAD_MENU_LATE_RENDER

**Symptom:** the verified fresh Flow asset is open and the download control is visible, but the first menu scan returns no quality options.

**Permanent recovery:** wait and re-scan the SAME download menu, including semantic menu-item roles. If still unavailable, close/reopen the SAME verified asset by identity and retry later. Never regenerate the episode.

## FLOW-ERR-034 VANISHED_TRANSIENT_TILE_RECOVERY_LOOP

**Symptom:** Flow briefly creates a post-submit tile (often at a very low progress percentage), then the tile disappears; the exact project returns to the pre-submit baseline and the Publisher remains in retrieval forever.

**Root cause:** the runtime preserved the exactly-once submit lock but failed to implement SOP 33.9's terminal branch for a temporary render slot that vanishes without leaving a retained asset. A timeout was incorrectly treated as permanent ambiguity even after the worker had durable proof that a fresh post-baseline tile existed and later disappeared.

**Permanent recovery:** persist the first post-baseline transient-tile observation in the generation lifecycle. If the same submit is old enough for the safety threshold, the exact project is verified, no busy state or playable media remains, the grid is back at/below baseline, and that empty state is stable for the secondary safety window, mark the prior generation `no_generation`, remove it from logical daily accounting, clear the old run identity, and authorize one clean serial retry of the same episode. A plain timeout without prior transient-tile proof is still ambiguous and must never authorize a duplicate submit.

## FLOW-ERR-035 PINNED_CHILD_RUNTIME_NEVER_UPDATES

**Symptom:** Publisher Factory/runtime fixes are deployed centrally, but one child Publisher remains on old behavior for days and never receives the fixes.

**Root cause:** the child service is sourced from a mutable GHCR tag whose build workflow was hard-pinned to an old repository commit, and/or the image was pushed without a deterministic Railway redeploy. Updating the shared runtime repository alone therefore did not update the running child.

**Permanent recovery:** child-image workflows must build current `main`, never a historical hard-coded SHA unless explicitly performing a rollback. After pushing the child tag, CI must trigger a Railway redeploy and then verify the live `/factory/health` capability flags. Image publication without live-runtime verification is not considered a completed deployment.

