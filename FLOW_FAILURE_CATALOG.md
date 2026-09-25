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
