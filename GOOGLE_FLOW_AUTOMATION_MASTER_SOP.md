# GOOGLE FLOW AUTOMATION MASTER SOP

**SOP ID:** `FLOW-SOP-v1.0`  
**Created:** `2026-09-21T19:35:00-03:00`  
**Last verified end-to-end success:** `2026-09-21T19:28:39-03:00`  
**Verification status:** `VERIFIED_ON_EARTH_IN_10`  
**Verified repository:** `fruttidrama-afk/Frutti-Drama-Publisher`  
**Reference-only working implementation:** `fruttidrama-afk/FruttiDrama-Publisher`  
**Verified commit:** `2134347db740ec9156c76ab7ffb19d123e3ce263`  
**Verified Railway deployment:** `d16f9e0f-8e82-4e6b-a878-51fb39039ed7`  
**Verified Flow project:** `EARTH IN 10`  
**Verified Flow project ID:** `800af820-b951-4035-ab20-f64df8883fb0`  

> **Canonical success definition:** A Google Flow automation job is successful only when the exact target project creates a new job-correlated video asset after the current submit boundary, the corresponding MP4 is recovered and validated, the final YouTube title/description/hashtags are prepared, and the application places the item in `REVIEW_READY`.

---

## 0. Purpose

This document preserves the operational knowledge that finally made the Google Flow automation work after a long sequence of false positives, wrong assumptions, selector mistakes, project-identity mistakes, consent ambiguity, recovery mistakes, race-condition risks and misleading internal states.

It is intentionally forensic and redundant. A future AI agent should be able to receive this file with no prior chat history and understand:

- what actually worked;
- what merely appeared to work;
- the exact UI interaction that produced a real automated generation;
- how to distinguish a real Flow render from a false positive;
- how to recover the correct video;
- how to avoid duplicate generations and duplicate credit spending;
- how to survive browser, worker and Railway restarts;
- how to put the correct video in Review;
- how to make Review show publication-ready YouTube copy before approval;
- how to continue production indefinitely without losing job↔asset correlation;
- how to run a temporary higher-volume day without changing the permanent daily target.

### Evidence labels

`VERIFIED` means directly observed in an operator recording, successful runtime log, validated recovered MP4, exact code path or visible Review result.

`STRONGLY_SUPPORTED` means multiple independent observations agree, although every branch has not necessarily been exercised end-to-end.

`INFERRED` means a reasonable engineering conclusion from the available evidence. It must not silently become VERIFIED.

`UNKNOWN` means evidence is insufficient. Future agents must preserve the uncertainty instead of filling it with how Flow “normally should work.”

`OBSOLETE` means historical logic that is no longer canonical.

`FAILED_APPROACH` means a path was tried and shown to be unreliable or wrong in this project.

### Security rule

Never write actual passwords, cookies, OAuth secrets, bearer tokens, browser session tokens, API secrets, passkey secrets or Railway secrets into this SOP or into user-shareable diagnostic evidence. Refer to protected stores symbolically, for example `GOOGLE_SESSION_PROFILE`, `FLOW_AUTH_STORAGE`, `YOUTUBE_OAUTH`, `PUBLISHER_SESSION_SECRET`.

---

# 1. Executive finding

The decisive breakthrough was not discovering an undocumented Google API. It was reducing ambiguity and reproducing the human UI behavior exactly.

The successful chain was:

```text
episode/job selected
→ persistent authenticated Chromium profile
→ exact Flow project verified
→ video settings verified
→ real prompt composer verified
→ prompt inserted and read back
→ project title verified unchanged
→ project-grid baseline captured
→ exactly-once submit boundary persisted
→ prompt top row refocused
→ RIGHT-ARROW generation icon clicked exactly once
→ optional current consent handled
→ new project video tile appears relative to baseline
→ serial lock remains closed
→ wait for same asset
→ open same asset from project grid
→ Descargar contenido multimedia
→ save MP4
→ validate MP4
→ generate final YouTube title/description/hashtags
→ REVIEW_READY
→ only then unlock next generation
```

The successful submit control is **not** best documented as a generic “Generate button.” Chrome Recorder Muestra 3 showed the actual target:

```text
flow-project-page
  → flow-prompt-box
    → flow-generate-icon-button
      → button
        → mat-icon
          → arrow_forward
```

Accessibility fallback:

```text
Iniciar generación
Start generation
```

Recorder also showed a focus click on `div.prompt-top-row` immediately before the arrow.

The first verified automated Earth run then proved that the exact `EARTH IN 10` project grid changed after that click from **2 to 3 video tiles** and from **7 to 8 total tiles**. The worker later recovered the new asset, validated a 10-second 1080×1920 MP4 and moved the episode to Review. That combination—not the click alone—is the canonical proof.

---

# 2. Verified success snapshot

The verified successful automated Earth configuration was:

```yaml
flow_project_name: EARTH IN 10
flow_project_id: 800af820-b951-4035-ab20-f64df8883fb0
mode: Video
model: Omni 1.1 Flash
aspect_ratio: 9:16
duration_seconds: 10
output_count: 1
settings_summary_observed: "Video · 720p · 10s ... x1"
downloaded_output_observed: 1080x1920
submit_control: flow-generate-icon-button mat-icon
submit_icon_text: arrow_forward
submit_accessible_name: "Iniciar generación / Start generation"
execution_model: strictly_serial
recovery_surface: exact project grid
review_gate: validated MP4 required
```

Successful E3 runtime chain:

```text
PRODUCTION_PICKED E3
FLOW_PROJECT_VERIFIED
PREFLIGHT
FLOW_SETTINGS_APPLIED
SUBMIT_ARROW_CLICKED
POST_ARROW_NO_CONSENT
project video tiles: 2 → 3
project all tiles:   7 → 8
recover current post-baseline asset
download
validate
REVIEW_READY
daily count: 3 / 3
E4 preflight only; no submit
```

The persistent profile had already used **Always approve / Aprobar siempre**, so no new permission dialog appeared during the successful E3 automated run. This is a valid branch.

The operator later supplied a Review screenshot showing that recovered videos played correctly. That screenshot also revealed a separate defect: the Review title and description still contained generic planner copy such as `NEXT CHAPTER` and “Continue the configured Creative Bible...”. That metadata problem is independent of video recovery and is now treated as a hard Review-quality defect.

---

# 3. Universal engine versus project adapter

## 3.1 Universal Flow Automation Engine

Every Publisher created from Publisher Factory should inherit the same reusable core:

1. durable authenticated browser profile;
2. exact Flow project resolver;
3. project-title guard;
4. prompt-composer guard;
5. video-settings verifier;
6. saved-character/reference-asset attachment;
7. prompt injection with read-back;
8. project-grid baseline capture;
9. exactly-once submit boundary;
10. recorder-compatible right-arrow click;
11. dynamic consent resolver;
12. strict serial execution;
13. current-job project asset correlation;
14. project-grid recovery;
15. media download;
16. MP4 validation;
17. prompt/context-derived publication metadata;
18. Review transition;
19. restart/redeploy recovery;
20. structured logs and evidence;
21. daily production accounting;
22. date-scoped volume override;
23. post-approval YouTube queue.

The engine must not contain the creative canon of a particular show.

## 3.2 Earth in 10 adapter

Verified/current adapter facts:

```yaml
show_name: EARTH IN 10
flow_project_name: EARTH IN 10
flow_project_id: 800af820-b951-4035-ab20-f64df8883fb0
model: Omni 1.1 Flash
mode: Video
duration_seconds: 10
aspect_ratio: 9:16
output_count: 1
normal_videos_per_day: 3
review_mode: human
serial_generation: true
```

Earth YouTube metadata defaults:

```yaml
title_discovery_hashtags:
  - "#Shorts"
  - "#ViralShorts"

description_hashtags:
  - "#EarthIn10"
  - "#Nature"
  - "#Travel"
  - "#Shorts"
  - "#ViralShorts"
```

A one-day stress test may raise the effective target without changing the normal configuration:

```yaml
override_day: "2026-09-21"
override_count: 6
auto_expire_next_local_day: true
```

## 3.3 FruttiDrama reference rule

FruttiDrama Publisher is a known working implementation and an existing program that should carry this knowledge file. When repairing another Publisher, FruttiDrama generation logic is read-only unless the operator explicitly asks for a FruttiDrama change.

---

# 4. Runtime architecture

Current Earth runtime components:

- Railway service `earth-in-10`;
- repository `fruttidrama-afk/Frutti-Drama-Publisher`;
- browser worker `free-browser-provider.js`;
- Playwright + local Chromium;
- Xvfb virtual display;
- persistent data root `/data`;
- runtime data `/data/publisher-runtime`;
- SQLite `/data/publisher-runtime/factory.sqlite`;
- persistent Flow profile `/data/publisher-runtime/flow-profile`;
- recovered media `/data/publisher-runtime/generated`;
- Flow verification record `/data/publisher-runtime/flow-auth-verified.json`;
- runtime publication pipeline for YouTube;
- durable lifecycle metadata in SQLite.

Why persistence matters: an application restart must not look like a new job. The DB and profile must tell the restarted process whether the job crossed the submit boundary, what baseline was captured, what project was used, whether an asset already exists, and whether the worker should generate, reconcile or retrieve.

---

# 5. Forensic chronology

## ATTEMPT-001 — Manual Patagonia Golden Run

The operator manually generated a real 10-second vertical Patagonia video inside Google Flow. The run established human ground truth for the prompt composer, the credit-consent behavior, the visible result, and media download.

**Result:** `SUCCESS / REFERENCE`

**What it proved:** the browser can generate in the account; Flow is not fundamentally blocking the workflow; the result can be recovered from the project; and the consent path can include Always approve.

## ATTEMPT-002 — Generic semantic submit

Automation found a control conceptually associated with generation and logged a successful click. Internal logs then inferred generation from UI changes.

The user inspected the real Flow project and found no new generation.

**Result:** `FALSE POSITIVE`

**PREVIOUS ASSUMPTION INVALIDATED:** Playwright click success is not generation success.

## ATTEMPT-003 — Generic consent text matching

Automation found visible `Always approve` / `Aprobar siempre` text. Flow, however, can keep old permission cards mounted. The worker could interact with stale historical UI and report approval.

**Result:** `FALSE POSITIVE`

**Lesson:** current consent must be scoped to a permission container created after the current submit boundary.

## ATTEMPT-004 — Recovery gate before production

A safety recovery routine was put ahead of normal production to avoid wasting credits. When recovery could not find the target asset it returned early, so the worker no longer even reached prompt insertion.

**Result:** `PARTIAL SAFETY SUCCESS / OPERATIONAL BLOCKER`

**Lesson:** recovery must be an explicit state-machine branch, not an opaque early return.

## ATTEMPT-005 — Wrong or stale Flow project

Runtime logs and operator-visible reality diverged. The browser could operate a valid Flow project that was not the project being inspected by the operator.

**Result:** `FAILURE`

**Definitive fix:** enumerate Flow project cards and verify the exact project name and URL/project id before any non-idempotent action.

## ATTEMPT-006 — Muestra 3 Recorder

Chrome Recorder captured the exact human action:

- Flow home opened;
- target project opened;
- prompt composer focused;
- prompt pasted;
- settings applied;
- `div.prompt-top-row` focused;
- `flow-generate-icon-button mat-icon` clicked;
- icon text `arrow_forward`;
- accessibility label `Iniciar generación`.

The user also confirmed that filtering Network for “Generate” did not reveal a useful request. The video still generated.

**Result:** `SUCCESS / PRIMARY UI EVIDENCE`

**Lesson:** do not make an undocumented Network request name a required dependency.

## ATTEMPT-007 — Exact project resolver

The runtime enumerated Flow projects and found:

```text
EARTH IN 10
/project/800af820-b951-4035-ab20-f64df8883fb0
```

The runtime then began logging `FLOW_PROJECT_VERIFIED` for this exact project.

**Result:** `SUCCESS`

## ATTEMPT-008 — Project-grid recovery of Patagonia

The worker recovered the existing Patagonia asset through the project grid, downloaded it, validated it and placed it in Review.

**Result:** `SUCCESS`

## ATTEMPT-009 — Namib test recovery

The operator's Muestra 3 Namib test video was recovered without spending another generation.

**Result:** `SUCCESS`

## ATTEMPT-010 — First verified automated Earth end-to-end generation

At the verified commit/deployment the worker:

- selected E3;
- verified `EARTH IN 10`;
- verified `Video · 720p · 10s`, 9:16, x1 and Omni 1.1 Flash;
- clicked the exact recorded arrow;
- saw the project video tile count change 2→3;
- kept the serial gate closed;
- recovered the resulting asset;
- downloaded and validated a 10-second 1080×1920 file;
- moved E3 to `REVIEW_READY`.

**Result:** `SUCCESS — CANONICAL GOLDEN PATH`

## ATTEMPT-011 — Review metadata audit

A screenshot showed a playable recovered video but generic `NEXT CHAPTER` copy in the title/description area.

**Result:** `VIDEO RECOVERY SUCCESS + METADATA FAILURE`

**Fix:** generate approval-ready title/description/hashtags from concrete story, stored generation prompt and recovery context before Review. The Review UI must display `description`, not internal planner `story`.

---

# 6. Fundamental principle: actions are not results

These inequalities are permanent:

```text
prompt pasted            ≠ generation started
browser click succeeded  ≠ generation started
button disabled          ≠ generation started
busy text visible        ≠ generation started
chat changed             ≠ generation started
video-option mounted     ≠ generation started
worker says "sent"       ≠ generation started
request name looks right ≠ generation started
```

A generation becomes trustworthy only when evidence is tied to the exact project and current job.

For Earth, the first verified project-correlated signal was the appearance of a new project video tile relative to the stored baseline. The final success signal was a validated recovered MP4 linked to the job and visible in Review.

---

# 7. Canonical state machine

```text
JOB_PENDING
  ↓
SESSION_REQUIRED
  ↓
FLOW_LOADING
  ↓
FLOW_PROJECT_RESOLVING
  ↓
FLOW_READY
  ↓
CONFIG_VALIDATED
  ↓
PROMPT_READY
  ↓
BASELINE_CAPTURED
  ↓
SUBMIT_BOUNDARY_ENTERED
  ↓
GENERATION_START_PENDING
  ├─→ CONFIRMATION_PENDING → CONFIRMATION_ACCEPTED ─┐
  └─────────────────────────────────────────────────┘
                         ↓
                 GENERATION_RUNNING
                         ↓
                 GENERATION_COMPLETE
                         ↓
                  VIDEO_RETRIEVING
                         ↓
                     VIDEO_READY
                         ↓
                  VALIDATION_PENDING
                         ↓
                    REVIEW_READY
                         ↓
                  RELEASE SERIAL GATE
```

Error states include:

```text
AUTH_FAILED
WRONG_PROJECT
UI_CHANGED
PROMPT_FAILED
CONFIRMATION_FAILED
SUBMIT_AMBIGUOUS
GENERATION_TIMEOUT
VIDEO_NOT_FOUND
VIDEO_MISMATCH
DOWNLOAD_FAILED
VIDEO_INVALID
```

The most important transition rule is:

```text
UNCERTAINTY → RECONCILE
NOT
UNCERTAINTY → RESUBMIT
```

---

# 8. Invariants

1. A browser click never proves generation by itself.
2. The exact Flow project must be verified immediately before any non-idempotent submit.
3. The project title and the prompt composer are distinct controls.
4. Persist `SUBMIT_BOUNDARY_ENTERED` before the arrow click.
5. Persist `automatic_submit_forbidden=true` before the arrow click.
6. Once the boundary is crossed, uncertainty means read-only reconciliation.
7. Only one generation/retrieval job may be active when recovery relies on newest post-baseline tile correlation.
8. The next generation cannot begin until the current MP4 is downloaded, validated, linked and `REVIEW_READY`.
9. A render timeout is not proof that no generation exists.
10. Historical permission cards cannot satisfy current consent.
11. No consent dialog is a valid path.
12. Generated Angular/Material numeric IDs are not canonical selectors.
13. A tile that existed before the current baseline cannot belong to the current job.
14. A downloaded file is not success until validated.
15. Download failure retries the same asset; it never authorizes new generation.
16. Secrets never appear in shared diagnostics.
17. Daily accounting counts confirmed production once.
18. The automation is healthy only after the Golden Test reaches Review.
19. Flow chat is secondary evidence; project assets and validated media outrank it.
20. Changes to project selection, submit, consent, correlation or download require a Golden Test.
21. Review must show publication-ready title and description before approval.
22. A temporary daily-volume test must be date-scoped and auto-expire.
23. YouTube failures never cause Flow regeneration.
24. FruttiDrama remains read-only during repairs to another Publisher unless separately authorized.

# 9. Preconditions

Before `ALLOW_GENERATION=true`, verify:

- persistent runtime DB is writable;
- persistent Flow browser profile exists;
- no live bootstrap process owns the same profile;
- Flow opens without login/security challenge;
- expected project name is configured;
- expected project resolves uniquely;
- current URL/project id matches the verified project;
- visible project title matches the configured name;
- prompt composer is distinguishable from the title;
- generation settings can be verified;
- required character/reference assets exist if used;
- no other job is generating/retrieving;
- effective daily target allows one more production;
- recovered-media storage is writable;
- baseline can be captured;
- submit lifecycle can be persisted;
- evidence capture is available;
- Review metadata can be created from concrete context.

If any critical precondition fails, the correct result is **no submit**.

---

# 10. Selector registry

## 10.1 Project

Home:

```text
https://flow.google.com/
```

Cards:

```text
flow-project-card
```

Project link:

```text
a[href*="/project/"]
```

Earth canonical project:

```text
EARTH IN 10
800af820-b951-4035-ab20-f64df8883fb0
```

Project-title guard:

```text
visible top input[aria-label="Editable text"]
```

Do not assume the current open project is correct because the Google account is correct.

## 10.2 Prompt composer

Recorder structure:

```text
flow-project-page
  → flow-prompt-box
    → flow-prompt-box-instruction-card-wrapper
      → flow-base-prompt-box
        → flow-rich-text-editor
          → ... → p / contenteditable
```

Preferred strategy:

1. locate visible contenteditable under the current Flow prompt component;
2. confirm proximity/component relationship to the generation arrow;
3. reject top title input;
4. insert;
5. read back;
6. verify title unchanged.

## 10.3 Submit control

Primary:

```text
flow-project-page flow-prompt-box flow-generate-icon-button mat-icon
```

Accessibility:

```text
Iniciar generación
Start generation
```

Icon:

```text
arrow_forward
```

Muestra 3 also recorded a focus click on:

```text
flow-project-page flow-prompt-box div.prompt-top-row
```

immediately before submit.

This selector is more authoritative than generic conceptual labels.

## 10.4 Consent

Container:

```text
flow-permission-message
```

Current action labels:

```text
Aprobar siempre
Always approve
Approve always
Aprobar
Approve
```

Only a permission container created after the current submit snapshot is eligible.

## 10.5 Project result

Primary durable surface:

```text
flow-grid-tile-container
```

Video child:

```text
flow-video-tile
```

Open control observed:

```text
flow-tile-hover-footer
```

## 10.6 Download

Primary semantic control:

```text
Descargar contenido multimedia
Download
```

Prefer configured quality by visible label.

A positional “third menu item” fallback is bounded to the known recorded UI and must not become a global assumption.

## 10.7 Selector priority

1. stable Flow custom-element context;
2. accessible name;
3. role;
4. stable visible text;
5. component-local structure;
6. icon identity;
7. generated framework ID as diagnostic fallback only;
8. absolute coordinate only as emergency evidence, never the normal path.

Examples such as `mat-button-toggle-20-button` and `mat-menu-panel-25` are historical Recorder evidence, not contracts.

---

# 11. Prompt field safety

This is critical because a previous automation wrote a video prompt into the project title.

Before writing:

1. identify the exact Flow project;
2. read and persist canonical project title;
3. locate the prompt editor inside the prompt component;
4. classify the editor as `VIDEO_PROMPT_COMPOSER`;
5. clear prior prompt state;
6. insert the full current prompt;
7. read the editor value/text back;
8. verify expected first fragment;
9. verify expected final fragment;
10. compare byte length within tolerance;
11. reread the project title;
12. confirm title is unchanged.

If project title suddenly contains long generation instructions, stop. Do not submit.

A repair may restore the canonical title only if the canonical project name is already known and contamination is clear.

---

# 12. Video settings

The successful Earth automated run observed:

```yaml
mode: Video
model: Omni 1.1 Flash
aspect_ratio: 9:16
duration: 10s
output_count: x1
resolution_intent: 720p
```

Visible summary:

```text
Video · 720p · 10s ... x1
```

Recovered/downloaded output:

```text
1080 x 1920
10 seconds
```

These are distinct facts. Store the generation UI intent separately from actual downloaded media dimensions.

The settings checker should fail closed when a critical setting cannot be verified. Do not silently proceed with Image mode, wrong aspect ratio or wrong model.

For character-based shows, attach only the configured saved Flow assets. Verify exact character names and count. Do not redesign or substitute characters because the picker returned an approximate result.

---

# 13. Prompt construction and verification

The application can generate a complex production prompt, but transport safety is separate from creative quality.

Persist:

```text
prompt
prompt_hash
prompt_generation_id
prompt_payload_length
character_handles
character_roles
```

Transport procedure:

```text
construct prompt
→ compute hash
→ write to job checkpoint
→ locate composer
→ insert prompt
→ read back
→ compare first fragment
→ compare last fragment
→ compare byte length
→ verify title unchanged
```

If a later worker sees an existing valid prompt checkpoint, it should reuse it rather than inventing a different prompt for the same generation intent.

A REDO that explicitly asks for prompt correction may create a new prompt checkpoint. A stochastic re-render should reuse the same prompt.

---

# 14. Baseline capture

Immediately before the submit boundary capture the external reality of the exact project.

Recommended fields:

```yaml
captured_at: timestamp
flow_project_id: string
flow_project_name: string
tile_count: integer
tile_signatures: []
video_tile_count: integer
video_tile_signatures: []
video_sources: []
prompt_hash: sha256
job_id: string
episode: integer
```

Why:

The baseline is what lets the worker later say “this tile did not exist before the current job.”

Without a durable baseline, “latest video” is weak evidence.

If baseline capture fails, do not spend credits.

---

# 15. Exactly-once submit boundary

Before the click write:

```yaml
state: SUBMIT_BOUNDARY_ENTERED
generation_id: <uuid>
submit_boundary_at: <timestamp>
automatic_submit_forbidden: true
baseline: <persisted project baseline>
```

Only after this durable write may the arrow be clicked.

The generation UUID here is the application's idempotency intent id. It does not claim Google exposes the same id.

After the boundary:

```text
UNKNOWN OUTCOME
≠
PERMISSION TO CLICK AGAIN
```

Canonical rule:

```text
UNCERTAINTY → RECONCILE
CONFIRMED CURRENT ASSET → RECOVER
POSITIVE PROOF OF NO GENERATION + NEW AUTHORIZATION → NEW INTENT
```

A timeout alone is never positive proof of no generation.

---

# 16. Exact submit procedure

## GF-016.1 Refocus current prompt row

If the current Flow UI matches the verified recording, focus/click:

```text
div.prompt-top-row
```

inside the current prompt component.

This mirrors Muestra 3.

## GF-016.2 Locate arrow

Primary:

```text
flow-project-page flow-prompt-box flow-generate-icon-button mat-icon
```

Fallback:

```text
accessible "Iniciar generación"
accessible "Start generation"
```

Confirm icon identity:

```text
arrow_forward
```

## GF-016.3 Click once

Issue one trusted pointer click.

Log:

```text
SUBMIT_ARROW_CLICKED
```

This event means only:

> The automation performed the verified input action.

It does **not** mean:

> Flow accepted a generation.

Never name this event `GENERATION_STARTED`.

---

# 17. Consent resolver

Flow has demonstrated three valid modes:

```text
NO DIALOG
PER-GENERATION APPROVAL
ALWAYS APPROVED
```

Before the arrow click snapshot visible permission containers.

After the click:

### Case A — new current `Aprobar siempre` / `Always approve`

Click exactly once.

Verify acceptance by:

- current control/container disappearing; or
- downstream current-job project evidence.

Persist:

```text
consent_mode = ALWAYS_APPROVED
```

### Case B — new current one-time approval

Click exactly once and verify acceptance.

Persist:

```text
consent_mode = PER_GENERATION
```

### Case C — no new permission message

Do not fail.

If this persistent profile was previously Always approved, retain that knowledge. Otherwise record:

```text
NO_DIALOG_OBSERVED
```

Continue observing the exact project.

### Forbidden behavior

Never scan the whole chat, find any old “Always approve,” click it, and declare the current job approved.

---

# 18. Real generation evidence hierarchy

## 18.1 Verified canonical Earth signal

For the first verified automated E3 success:

```text
videoTiles: 2 → 3
allTiles:   7 → 8
```

inside the exact verified `EARTH IN 10` project after the exact arrow click.

This is a project-correlated post-baseline asset signal.

## 18.2 Final completion evidence

The strongest completion evidence is:

```text
unique post-baseline asset
→ opened
→ downloaded
→ valid MP4
→ correct duration/orientation
→ linked to job
→ REVIEW_READY
```

## 18.3 Supporting evidence only

These are not enough alone:

- disabled arrow;
- hidden arrow;
- generic busy text;
- spinner;
- new chat bubble;
- `flow-a2ui-video-option`;
- successful Playwright click;
- worker-internal “sent” state;
- guessed Network request name;
- elapsed time.

A future Flow change may add better signals. New signals must be audited before replacing the project-grid evidence.


# 19. Strict serial execution

Serial execution is not a performance preference. It is part of asset-correlation correctness.

Required sequence:


# 19A. CANONICAL KNOWLEDGE PACK APPENDICES

The following documents are part of this SOP and are inherited together. They intentionally duplicate critical rules so a future AI can recover the operating model even if only one file is loaded.

# FLOW AI IMPLEMENTATION BRIEF

Use the exact target Flow project. Never confuse project title with the rich-text prompt composer. Verify Video/model/ratio/duration/output settings. Insert and read back the prompt. Capture a project-grid baseline. Persist SUBMIT_BOUNDARY_ENTERED and automatic_submit_forbidden=true before the non-idempotent submit.

The verified submit action is the right-arrow `arrow_forward` inside `flow-generate-icon-button`, accessible as `Iniciar generación` / `Start generation`. Click it exactly once per authorized generation intent.

Only handle a permission message created after the current boundary. No dialog is valid when the profile is already approved.

Do not treat click success, disabled controls, generic busy text, chat `flow-a2ui-video-option`, or guessed Network request names as sole generation proof. Prefer a unique post-baseline video tile in the exact project.

Run strictly serially: generate one → wait → recover that one from the project grid → download → validate → generate final title/description/hashtags → REVIEW_READY → only then generate the next.

On post-boundary uncertainty, reconcile read-only and never blindly resend.

Earth in 10: normal target 3/day. Temporary 2026-09-21 test target 6/day only, auto-expiring back to 3/day. Review must show publication-ready metadata.

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

# FLOW GOLDEN TEST

Run exactly one paid generation after any critical change to project resolution, prompt targeting, settings, submit selector, consent, asset correlation, download, or serial locking.

Pass only if all succeed:
1. persistent session valid;
2. exact project verified;
3. project title unchanged;
4. real prompt composer verified;
5. Video/model/ratio/duration/count verified;
6. prompt inserted/read back;
7. pre-submit baseline persisted;
8. exactly-once boundary persisted;
9. exact right arrow clicked once;
10. current consent handled or validly absent;
11. unique post-baseline project video tile observed;
12. no second submit;
13. same asset opened from project grid;
14. MP4 downloaded;
15. MP4 validated;
16. final public title/description/hashtags generated;
17. Review shows playable video and final metadata;
18. lifecycle REVIEW_READY;
19. serial gate released.

Only then set FLOW_AUTOMATION_HEALTHY=true.

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

Canonical recovery rule: UNCERTAINTY → RECONCILE; NEVER BLINDLY RESUBMIT.

# 19B. FINAL RULES ADDED AFTER THE VERIFIED RUN

- Review must contain publication-ready title, description and hashtags before approval; internal planner text such as NEXT CHAPTER / Continue the configured Creative Bible is forbidden as public copy.
- Google Flow generation is strictly serial for every Publisher, even for non-serialized creative shows, because project-grid recovery depends on unique post-baseline asset correlation.
- A temporary volume increase must be scoped to an explicit publisher-local date and automatically expire back to the configured daily target.
- If a transient Flow render placeholder disappears and the exact project returns to the stored pre-submit baseline after a conservative safety window, mark the attempt no_generation and permit one clean serial retry; never release merely because a timer expired.
- If Flow explicitly reports insufficient credits/points, do not count the attempt as a completed generation; enter a long backoff / ESPERANDO CRÉDITOS state and resume later.
- Publisher Factory must embed this SOP version and SHA in every new Publisher configuration and deployment, and every runtime must ingest the knowledge files into its durable runtime knowledge database.
- New Publishers must auto-start only after Flow authentication + exact project binding + creative bible are ready. Setup must not require another human demonstration of the generate/recover procedure.

# 19C. PUBLISHER FACTORY INHERITANCE CONTRACT

Every generated Publisher MUST inherit:

```yaml
flow_sop_version: FLOW-SOP-v1.0
flow_sop_sha256: 8172f4b415e516fb1ec211a338ef7872740d7931adfbc5ab31572344a5bc9162
exactly_once_submit: true
strict_serial_generation: true
project_grid_recovery: true
prompt_title_guard: true
current_consent_only: true
review_metadata_required: true
golden_test_required_after_critical_change: true
indefinite_scheduler: true
```

New Publishers may vary show bible, characters, Flow project, duration, model, schedule and metadata style, but these safety/runtime invariants are universal.

# 19D. END-TO-END ACCEPTANCE GATE FOR PUBLISHER FACTORY

Publisher Factory may call a deployment READY only when the deployed runtime reports the expected SOP version/hash and its health endpoint exists. The first real content production is then gated by Flow setup readiness and the universal Golden path. A runtime that lacks the canonical SOP knowledge record, serial gate, exact-project resolver, prompt/title guard, exactly-once boundary, project-grid recovery or MP4 validation is not a valid Publisher Factory output.
