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

- FLOW-ERR-018 NATIVE_NO_CHARGE_RETRY_LOST — Flow explicitly rejects an attempt as unusual activity and says it was not charged, but the runtime discards Flow's native Retry action and later performs a fresh composer submit. Recovery: click the visible native Retry/Reintentar control exactly once for the failed tile, require hard generation-start evidence, and only fall back to a protective cooldown if Retry is rejected again.

Canonical recovery rule: UNCERTAINTY → RECONCILE; NEVER BLINDLY RESUBMIT.
