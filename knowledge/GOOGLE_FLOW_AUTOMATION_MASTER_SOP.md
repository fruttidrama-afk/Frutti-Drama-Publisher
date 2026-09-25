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

```text
GENERATE ONE
→ WAIT FOR THAT ONE
→ RECOVER THAT ONE
→ VALIDATE THAT ONE
→ CREATE FINAL METADATA
→ REVIEW_READY
→ ONLY THEN NEXT GENERATION
```

Why:

If video A and video B are submitted before video A is recovered, the project grid can reorder by recency. A naive “open latest video” recovery can then open B while the application thinks it is recovering A. A later recovery can open B again. The result is a lost association, duplicated download and potentially wrong video publication.

The serial gate therefore remains closed through:

```text
SUBMIT_BOUNDARY_ENTERED
GENERATION_START_PENDING
GENERATION_RUNNING
GENERATION_COMPLETE
VIDEO_RETRIEVING
VIDEO_READY
VALIDATION_PENDING
```

It opens only after:

```text
REVIEW_READY
```

or another explicit terminal/manual-hold state.

No “catch up” logic is allowed to parallelize Flow jobs merely because the daily target is behind schedule.

---

# 20. Render waiting

A new project tile can appear before the final media is ready.

Distinguish:

```text
GENERATION_RUNNING
```

from:

```text
GENERATION_COMPLETE
```

`GENERATION_RUNNING` means the current job has project-correlated evidence but the media may still be rendering.

`GENERATION_COMPLETE` means the same current asset can be opened and recovered as final media.

Polling rules:

- keep the serial lock;
- periodically refresh progress timestamps;
- detect explicit Flow generation failure text;
- do not submit another generation;
- keep exact project identity verified;
- retain baseline and current asset evidence.

A render timeout produces:

```text
GENERATION_TIMEOUT
```

or retrieval-pending state.

It does not grant permission to send again.

---

# 21. Project-grid recovery

The project grid is the canonical recovery surface because it is more durable than the chat.

Operator-proven path:

```text
Flow
→ exact project
→ project content grid
→ newest unique post-baseline video tile
→ hover/open tile
→ media editor
→ Descargar contenido multimedia
→ choose quality
→ download
```

Observed component structure:

```text
flow-grid-tile-container
  → flow-video-tile
  → flow-tile-hover-footer
```

## 21.1 Correlation rule

Before submit, store the grid baseline.

After submit, no other job is allowed.

Therefore the unique new post-baseline video tile can be bound to the current job.

## 21.2 If multiple new tiles appear

This is not a normal success.

Possible causes:

- another human generated in the same project;
- another worker violated serial locking;
- a stale baseline was used;
- Flow created multiple outputs unexpectedly.

Response:

1. freeze new submits;
2. preserve all candidate tile signatures;
3. inspect prompt fingerprints/chat accessible names/timestamps;
4. require stronger correlation or manual decision;
5. do not assign an arbitrary latest tile.

## 21.3 Chat as secondary recovery

Chat can expose:

```text
flow-chat-bubble
  → flow-a2ui-message-renderer
    → flow-a2ui-video-option
      → img
```

The result image may expose prompt text as its accessible name.

This is useful supporting evidence but chat history can be stale or absent. Project-grid recovery remains primary.

---

# 22. Download

Once the exact asset is open:

Primary semantic action:

```text
Descargar contenido multimedia
Download
```

Then:

1. look for configured download quality by visible label;
2. click it once;
3. wait for the browser download event;
4. save to deterministic job path;
5. never overwrite another job's file.

The operator recording also demonstrated a third-menu-item path in that specific Flow UI. It is a bounded fallback, not a universal selector.

A download timeout does not imply generation failure.

---

# 23. MP4 validation

A file on disk is not enough.

Required checks:

```yaml
exists: true
size_bytes: reasonable_and_nonzero
container_signature: MP4 / ftyp
video_stream: present
decodable: true
duration: within target tolerance
width: positive
height: positive
orientation: matches 9:16
```

Recommended:

```text
ffprobe
```

Optional additional validation:

- decode first frame;
- verify audio stream only if the show requires audio;
- detect obvious duplicate local content hash;
- store codec;
- store file size;
- store duration/resolution.

Verified Earth output examples:

```text
Patagonia: 10s, 1080x1920
Namib:     10s, 1080x1920
E3 auto:   10s, 1080x1920
```

The exact file sizes differ. File-size equality is not required.

If validation fails:

```text
reopen same asset
→ redownload
→ revalidate
```

Do not generate again.

---

# 24. Review-ready contract

A job reaches `REVIEW_READY` only when all of these are true:

1. correct project asset identified;
2. MP4 downloaded;
3. MP4 validated;
4. file linked to the correct factory item;
5. final YouTube title exists;
6. final YouTube description exists;
7. hashtags exist according to project config/defaults;
8. Review card can play the video;
9. Review card displays final public copy;
10. REDO and APPROVE controls are available.

The operator should not need to rewrite metadata merely to approve a technically correct video.

---

# 25. Review metadata failure and fix

The screenshot `IMG_2614.jpeg` provided direct evidence of two separate facts:

### VERIFIED success

The recovered video was available in Review with a playable video player.

### VERIFIED failure

The public-copy areas displayed internal planner content:

```text
NEXT CHAPTER: Continue the configured Creative Bible...
```

and:

```text
Continue the configured Creative Bible and canon...
```

This is unacceptable because those phrases are production instructions, not viewer-facing metadata.

## 25.1 Metadata source priority

Use the richest reliable context in this order:

1. concrete episode story/intent;
2. actual stored generation prompt;
3. recovery terms/context;
4. project-specific non-misleading fallback.

Never prefer a generic planner placeholder over a concrete prompt.

## 25.2 Earth known-context examples

If recovery/generation context proves Patagonia/glacial lake:

```text
PATAGONIA SUNRISE: Turquoise glacial lake beneath the Andes. #Shorts #ViralShorts
```

Description:

```text
A crystal-clear turquoise glacial lake, snow-covered peaks and soft sunrise mist turn Patagonia into a cinematic ten-second escape.

EARTH IN 10

#EarthIn10 #Nature #Travel #Shorts #ViralShorts
```

If context proves Namib/desert/solitary tree:

```text
NAMIB DESERT: A solitary tree beneath glowing red dunes. #Shorts #ViralShorts
```

Description:

```text
A solitary dark tree stands against Namibia’s immense red-orange dunes as warm sunrise light stretches across the desert.

EARTH IN 10

#EarthIn10 #Nature #Travel #Shorts #ViralShorts
```

## 25.3 Earth title rules

- location or natural phenomenon first when known;
- factual;
- short enough for YouTube title limits;
- no internal Creative Bible language;
- no ellipsis truncation;
- title ends as a complete phrase/sentence;
- include `#Shorts #ViralShorts` for the Earth YouTube-ready title when space permits.

## 25.4 Earth description rules

- summarize what the prompt asks the viewer to see;
- do not expose production instructions;
- do not claim a location not supported by the prompt/context;
- include show name;
- include:
  - `#EarthIn10`
  - `#Nature`
  - `#Travel`
  - `#Shorts`
  - `#ViralShorts`
- merge configured channel hashtags rather than silently replacing them.

## 25.5 Publication consistency

The title/description approved in Review must be the same metadata passed into the publication queue.

Approval should not later replace it with generic copy.

---

# 26. Autonomous Earth episode planning

A separate planning defect created generic future rows:

```text
NEXT CHAPTER
Continue the configured Creative Bible...
```

For an independent landscape show, this serialization language is not useful.

Future Earth episodes should use concrete visual premises before prompt construction.

Canonical Earth seed examples:

1. Iceland black volcanic coast;
2. Zhangjiajie sandstone pillars in mist;
3. Salar de Uyuni mirror sunrise;
4. Faroe sea cliffs and waterfall;
5. Dolomites dawn;
6. Lençóis Maranhenses blue lagoons;
7. Milford Sound waterfalls;
8. Atacama blue hour;
9. Plitvice turquoise cascades;
10. Lofoten Arctic sunrise;
11. Socotra dragon’s-blood trees;
12. Torres del Paine dawn.

Each story should specify:

- exact location;
- key visual subject;
- natural lighting;
- atmosphere/weather;
- cinematic camera intent;
- no people/animals/buildings unless episode explicitly needs them;
- vertical 9:16;
- exact 10 seconds;
- no text/subtitles/logos.

This gives both Flow and the metadata generator concrete information.

---

# 27. Temporary six-video test

Normal Earth production remains:

```text
3 videos/day
```

The operator requested a single six-video day on:

```text
2026-09-21
```

The correct mechanism is a date-scoped override, not a permanent config mutation.

Conceptual variables:

```yaml
PUBLISHER_DAILY_LIMIT_OVERRIDE_DAY: "2026-09-21"
PUBLISHER_DAILY_LIMIT_OVERRIDE_COUNT: 6
```

The runtime compares the override date with the publisher's local timezone/day.

When the date changes:

```text
effective daily target → normal configured target (3)
```

No manual reset should be required.

## 27.1 Six-video test sequence

Already completed/recovered items count toward the six.

Then:

```text
video 4 generate
→ recover
→ validate
→ metadata
→ Review

video 5 generate
→ recover
→ validate
→ metadata
→ Review

video 6 generate
→ recover
→ validate
→ metadata
→ Review

STOP at 6/6
```

Never generate videos 4, 5 and 6 concurrently.

## 27.2 Why date-scoped override matters

Without a date scope, a temporary stress test can silently become a permanent doubled production budget.

The system must surface:

```text
daily_target
completed_today
remaining_today
daily_override_active
```

in health/status.

---

# 28. Daily accounting

Count production once per confirmed generation/recovery.

Do not count:

- preflight;
- prompt insertion;
- click attempt;
- false positive;
- no-generation infrastructure failure;
- review retry as a new normal daily episode unless policy explicitly says so.

Do count a manually generated/recovered test video when:

- it is intentionally assigned to an episode;
- its MP4 validates;
- it enters Review;
- a single accounting row records it.

This is why recovered Patagonia and Namib could legitimately be part of the daily total.

---

# 29. Restart and Railway redeploy recovery

The pipeline must survive:

- Railway restart;
- code deploy;
- browser crash;
- worker crash;
- network interruption;
- process termination during render.

Durable state must include at minimum:

```text
episode_id
job_id
generation_intent_id
flow_project_id
flow_project_name
prompt
prompt_hash
submit_boundary_at
consent_mode
baseline
generation_asset_evidence
generation_started_at
video_path
validation
title
description
review_status
```

## 29.1 Restart before submit

Safe to repeat preflight.

## 29.2 Restart after submit boundary

Do not submit.

Procedure:

```text
read lifecycle
→ exact project
→ baseline comparison
→ find current asset
→ if rendering: wait
→ if complete: recover
→ if uncertain: reconcile
```

## 29.3 Restart during download

Reopen the same correlated asset and retry download.

## 29.4 Restart after local MP4 but before Review update

Validate the existing local file and finish DB linkage. Do not regenerate.

---

# 30. Error catalog

## FLOW-ERR-001 — CLICK_SUCCESS_FALSE_POSITIVE

**Symptom:** browser reports click, project has no new render.

**Root cause:** an input event was confused with application acceptance.

**Solution:** baseline + exact project output evidence.

**Recovery:** post-boundary reconciliation; no resend.

## FLOW-ERR-002 — STALE_CONSENT_CARD

**Symptom:** Always approve appears clicked but remains visible/no render.

**Root cause:** historical permission cards remain mounted.

**Solution:** compare permission containers before/after current submit.

**Recovery:** keep boundary locked and reconcile.

## FLOW-ERR-003 — WRONG_FLOW_PROJECT

**Symptom:** runtime logs activity but operator's target project is unchanged.

**Root cause:** browser is controlling another valid Flow project.

**Solution:** resolve exact project by visible name and verify URL/id/title.

**Recovery:** return to Flow home and resolve uniquely.

## FLOW-ERR-004 — RECOVERY_GATE_BLOCKED_PRODUCTION

**Symptom:** no new prompt reaches Flow.

**Root cause:** debugging recovery branch returned before production.

**Solution:** explicit lifecycle branch.

**Recovery:** repair ordering without discarding post-boundary state.

## FLOW-ERR-005 — GENERIC_BUSY_FALSE_POSITIVE

**Symptom:** runtime logs generation based on busy/disabled UI; no render exists.

**Root cause:** weak UI state used as hard evidence.

**Solution:** project-correlated asset requirement.

## FLOW-ERR-006 — CHAT_VIDEO_OPTION_FALSE_POSITIVE

**Symptom:** chat video option changed but no new project render.

**Root cause:** chat/history DOM is not durable asset truth.

**Solution:** project grid wins.

## FLOW-ERR-007 — BRITTLE_MATERIAL_IDS

**Symptom:** selector breaks after reload.

**Root cause:** generated Angular/Material numeric ids.

**Solution:** semantic/component selectors.

## FLOW-ERR-008 — PROJECT_TITLE_CONTAMINATED

**Symptom:** project name replaced by long prompt.

**Root cause:** wrong editable field.

**Solution:** component-scoped prompt locator + title guard.

## FLOW-ERR-009 — PARALLEL_GENERATION_CORRELATION_RACE

**Symptom:** wrong/latest video recovered twice.

**Root cause:** two in-flight generations.

**Solution:** strict serial execution.

## FLOW-ERR-010 — TIMEOUT_CAUSED_REGENERATION

**Symptom:** same episode could be sent again after slow render.

**Root cause:** timeout treated as no-generation proof.

**Solution:** reconciliation-only post-boundary timeout.

## FLOW-ERR-011 — CHAT_ONLY_RECOVERY

**Symptom:** project contains video but chat path is unavailable.

**Root cause:** chat treated as durable registry.

**Solution:** project-grid recovery.

## FLOW-ERR-012 — NETWORK_FILTER_ASSUMPTION

**Symptom:** no `generate` Network row found during a real generation.

**Root cause:** undocumented request naming assumption.

**Solution:** network is optional diagnostics only.

## FLOW-ERR-013 — GENERIC_REVIEW_METADATA

**Symptom:** recovered video plays but title/description are internal planner text.

**Root cause:** metadata builder used hook/story placeholders rather than prompt/context.

**Solution:** build and persist final publication copy before Review.

---

# 31. Dead ends: do not repeat

### “Click successful” means Flow generated

False.

### “Button disabled” means Flow generated

False as sole evidence.

### “Busy text” means Flow generated

False as sole evidence.

### `flow-a2ui-video-option` means current project generated

False as sole evidence.

### Click any visible Always approve

False. It can be historical.

### First visible text field is prompt

False. It can be project title.

### Numeric Material ID is stable

False.

### Network must contain a request whose name includes generate

False in the observed Muestra 3 workflow.

### Generate several videos, then recover newest

Unsafe.

### Render timeout allows retry submit

Unsafe.

### Chat is the only recovery route

False.

### Placeholder planner copy is acceptable in Review

False.


# 32. Machine-operable happy path

Every step below has a deliberately narrow success signal. Future agents must not silently replace it with a weaker signal.

## GF-001 — Select head-of-line job

**ACTION**  
Choose the earliest unresolved episode allowed by the serial gate and the effective daily quota.

**SUCCESS SIGNAL**  
Exactly one candidate exists.

**FAILURE SIGNAL**  
More than one active generation/retrieval job exists, or no eligible job exists.

**RECOVERY**  
Do not skip an unresolved earlier episode merely to make progress on a later one.

**NEXT STATE**  
`SESSION_REQUIRED`

## GF-002 — Acquire browser lease

**ACTION**  
Acquire the durable project/browser lease before controlling the persistent Flow profile. Refresh a heartbeat while the worker owns the profile.

**SUCCESS SIGNAL**  
The current worker is the only live owner.

**FAILURE SIGNAL**  
Another live worker/bootstrap process owns the profile.

**RECOVERY**  
Wait; do not steal a live profile.

## GF-003 — Launch persistent browser

**ACTION**  
Launch Chromium/Playwright using the durable Flow profile stored on persistent volume.

**SUCCESS SIGNAL**  
Flow opens without a Google sign-in/security challenge.

**FAILURE SIGNAL**  
Login, CAPTCHA, verify-it's-you, account recovery or security checkpoint.

**RECOVERY**  
Stop all non-idempotent actions and use the approved authentication/bootstrap workflow.

## GF-004 — Resolve exact Flow project

**ACTION**  
Open Flow home, enumerate visible `flow-project-card` elements, match the exact expected project name, open its `/project/<id>` link and persist the resolved identity.

**SUCCESS SIGNAL**  
Visible project title and current URL/project id match the adapter configuration.

**FAILURE SIGNAL**  
Zero matches, multiple matches, title mismatch or unexpected project id.

**RECOVERY**  
Stop with `WRONG_PROJECT`, capture visible project cards and do not submit.

## GF-005 — Verify prompt destination

**ACTION**  
Locate the rich text/contenteditable inside the current Flow prompt component and independently identify the project-title input.

**SUCCESS SIGNAL**  
Target is classified `VIDEO_PROMPT_COMPOSER`.

**FAILURE SIGNAL**  
Only the project title or another unrelated editable control is found.

**RECOVERY**  
Stop before typing.

## GF-006 — Clear prompt state

**ACTION**  
Clear previous prompt text and remove stale reference/ingredient chips when applicable.

**SUCCESS SIGNAL**  
Composer is empty and the current ingredient count matches the expected clean baseline.

## GF-007 — Configure video generation

**ACTION**  
Select Video, aspect ratio, model, duration, output count and configured resolution intent.

**SUCCESS SIGNAL**  
Visible settings reflect the requested adapter configuration.

**FAILURE SIGNAL**  
Any critical setting is wrong or unverifiable.

**RECOVERY**  
Reopen/reselect once. If still unverifiable, stop before submit.

## GF-008 — Attach exact saved reference assets

**ACTION**  
For shows that use saved Flow characters/reference images, attach only the configured assets and verify names/count.

**SUCCESS SIGNAL**  
Exact expected asset set/count.

**FAILURE SIGNAL**  
Missing, approximate or wrong asset.

**RECOVERY**  
Clear and rebuild the attachment state once; otherwise stop.

## GF-009 — Insert prompt

**ACTION**  
Insert the full stored prompt into the verified prompt composer.

**SUCCESS SIGNAL**  
Read-back contains expected beginning/end fragments and byte length is within tolerance. Project title remains unchanged.

**FAILURE SIGNAL**  
Truncation, wrong field or title contamination.

**RECOVERY**  
One controlled clear-and-reinsert attempt before submit.

## GF-010 — Prepare review metadata seed

**ACTION**  
Derive title/description/hashtags from concrete story, stored prompt and recovery context.

**SUCCESS SIGNAL**  
No internal planner placeholder leaks into public copy.

**RECOVERY**  
Use a safe non-misleading project fallback if the concrete prompt is temporarily unavailable.

## GF-011 — Capture pre-submit project baseline

**ACTION**  
Persist tile count/signatures, video-tile count/signatures, visible media sources, project id, timestamp and job id.

**SUCCESS SIGNAL**  
Baseline is durable.

**FAILURE SIGNAL**  
Baseline could not be captured or persisted.

**RECOVERY**  
Do not submit.

## GF-012 — Enter exactly-once submit boundary

**ACTION**  
Create a generation intent UUID and persist:

```yaml
state: SUBMIT_BOUNDARY_ENTERED
automatic_submit_forbidden: true
generation_id: <uuid>
submit_boundary_at: <timestamp>
baseline: <project baseline>
```

**SUCCESS SIGNAL**  
The durable lifecycle write succeeds.

**FAILURE SIGNAL**  
DB persistence fails.

**RECOVERY**  
Abort before click.

## GF-013 — Focus current prompt top row

**ACTION**  
Mirror Muestra 3 and focus/click the current `div.prompt-top-row`.

**SUCCESS SIGNAL**  
Current prompt component remains active and no navigation occurs.

## GF-014 — Click the exact right-arrow control

**ACTION**  
Click the `mat-icon` inside `flow-generate-icon-button`; icon text `arrow_forward`; accessibility fallback `Iniciar generación` / `Start generation`.

**SUCCESS SIGNAL**  
Exactly one input event is issued and logged as `SUBMIT_ARROW_CLICKED`.

**IMPORTANT**  
This is input evidence only. It is not proof that Google Flow accepted the generation.

**RETRY POLICY**  
Never automatically click the same generation arrow again for this generation intent.

## GF-015 — Resolve current consent

**ACTION**  
Compare permission containers with the pre-submit snapshot. If a new current permission message appears, prefer `Aprobar siempre` / `Always approve`; otherwise one-time approval. If no new permission appears, continue.

**SUCCESS SIGNAL**  
Current consent is accepted, or no current consent exists.

**FAILURE SIGNAL**  
Only stale historical consent controls are present or the current consent remains actionable with no downstream evidence.

**RECOVERY**  
Post-boundary reconciliation only. No resend.

## GF-016 — Observe exact-project generation evidence

**ACTION**  
Watch the exact target project grid against the stored baseline.

**SUCCESS SIGNAL**  
A unique post-baseline project video tile appears.

**FAILURE SIGNAL**  
Only weak UI changes such as busy text, disabled controls or chat changes.

**RECOVERY**  
Remain `SUBMIT_AMBIGUOUS` and reconcile read-only.

## GF-017 — Hold the serial lock

**ACTION**  
Block all later episodes until the current job is fully recovered and Review-ready.

**SUCCESS SIGNAL**  
No second in-flight generation/retrieval job.

## GF-018 — Wait for the current asset

**ACTION**  
Poll the unique current tile until it becomes openable/downloadable. Do not infer failure merely from elapsed time.

**SUCCESS SIGNAL**  
The exact current asset can be opened and exposes media download.

**FAILURE SIGNAL**  
Flow explicitly reports generation failure or the temporary render slot disappears and the exact project returns to the pre-submit asset baseline for the configured safety window.

## GF-019 — Open current asset from project grid

**ACTION**  
Open the unique post-baseline video tile, preferring the recorded `flow-tile-hover-footer` interaction when present.

**SUCCESS SIGNAL**  
Media editor opens and download control is visible.

## GF-020 — Download media

**ACTION**  
Click `Descargar contenido multimedia` / `Download`, choose configured quality by visible label and wait for browser download event.

**SUCCESS SIGNAL**  
Bytes are saved to the deterministic job path.

**RETRY POLICY**  
Retry the same asset only.

## GF-021 — Validate MP4

**ACTION**  
Verify file existence, MP4/container signature, stream, decodability, duration, dimensions and vertical orientation.

**SUCCESS SIGNAL**  
All required checks pass.

**FAILURE SIGNAL**  
Truncated, zero-byte, non-MP4, undecodable, wrong-duration or wrong-orientation output.

**RECOVERY**  
Redownload the same asset. Never regenerate solely because the download is invalid.

## GF-022 — Persist media + publication metadata

**ACTION**  
Write title, description, hashtags, local path, Flow result, dimensions, size, duration, generation id and timestamps.

**SUCCESS SIGNAL**  
Atomic DB update succeeds.

## GF-023 — Enter Review

**ACTION**  
Set factory item to `review` / lifecycle `REVIEW_READY`.

**SUCCESS SIGNAL**  
Review panel plays the video and displays final title and description.

## GF-024 — Release serial gate

**ACTION**  
Allow the scheduler to inspect the next head-of-line job only after current Review-ready state is durable.

## GF-025 — Apply effective daily quota

**ACTION**  
Count confirmed productions exactly once and stop at the effective target.

**SUCCESS SIGNAL**  
Normal Earth day stops at 3. The temporary 2026-09-21 test stops at 6, then automatically returns to 3 on the next local date.

---

# 33. Self-healing recovery runbook

## 33.1 Flow UI changed

1. Stop before submit when possible.
2. Capture current URL, screenshot and visible text.
3. Capture DOM around:
   - project card;
   - project title;
   - prompt box;
   - settings;
   - generation arrow;
   - permission message;
   - project grid.
4. Record selector counts.
5. Preserve lifecycle.
6. Update selector registry in a branch.
7. Run no-credit preflight.
8. Run exactly one Golden Test.
9. Promote new SOP version only after pass.

## 33.2 Google session expired

1. Detect accounts.google.com, sign-in, password, captcha, verify-it's-you or security-check.
2. Mark `AUTH_FAILED`.
3. Preserve post-boundary state.
4. Reauthenticate durable profile.
5. Reverify exact project.
6. Resume according to lifecycle.

## 33.3 Wrong project opened

1. Never submit.
2. Return to Flow home.
3. Enumerate project cards.
4. Match unique exact expected name.
5. Open exact card.
6. Verify visible title and URL/project id.
7. Resume preflight.

## 33.4 Wrong model/settings

1. No submit.
2. Reopen settings.
3. Verify Video, model, ratio, duration, count and resolution intent.
4. Capture evidence if selector changed.
5. Fail closed when unverifiable.

## 33.5 Prompt failed to insert

1. No submit.
2. Clear composer.
3. Reinsert once.
4. Read back first/last fragments and byte length.
5. Verify project title unchanged.
6. Stop `PROMPT_FAILED` if still wrong.

## 33.6 Consent did not appear

This is not inherently an error. Continue project observation. A persistent profile may already be in `ALWAYS_APPROVED`.

## 33.7 Consent appeared but did not accept

1. Do not click submit again.
2. Preserve boundary.
3. Reconcile exact project.
4. If no project asset can be established, require positive evidence of no generation before any new submit intent.

## 33.8 Click occurred but project asset never appears

1. Enter `SUBMIT_AMBIGUOUS`.
2. Keep `automatic_submit_forbidden=true`.
3. Compare project grid against baseline.
4. Do not send again because a timer expired.

## 33.9 Temporary render slot disappears

If all of the following become true:

- exact project verified;
- render is older than the safety threshold;
- no busy state;
- no playable fresh media;
- no fresh tile/signature remains relative to baseline;
- evidence remains stable for a second safety window;

then mark the previous run `no_generation`, remove it from logical daily accounting and authorize one clean serial retry.

This behavior exists to recover from transient Flow render placeholders that vanish without leaving a retained asset.

## 33.10 Insufficient Flow credits

If Flow explicitly shows insufficient points/credits:

1. do not count that attempt as a completed generation;
2. mark generation accounting `no_generation`;
3. return job to a waiting/draft state with a long backoff;
4. set Flow state `ESPERANDO CRÉDITOS`;
5. do not hammer the generation button repeatedly;
6. resume after credits are available.

## 33.11 Render appears frozen

1. Keep serial gate.
2. Poll current asset.
3. Persist progress heartbeat.
4. Capture evidence.
5. Do not advance to next episode.

## 33.12 Worker died during render

1. Read lifecycle on restart.
2. Any state at/after submit boundary forbids fresh submit.
3. Reopen exact project.
4. Compare with durable baseline.
5. Recover if asset exists.
6. Continue validation/Review.

## 33.13 Railway redeployed

1. Reconstruct from persistent `/data`.
2. Reuse SQLite DB.
3. Reuse persistent browser profile.
4. Reuse recovered media.
5. Do not assume in-memory locks/state survived.
6. Restore from durable lifecycle.

## 33.14 Asset exists but correlation is unclear

1. Freeze all new generation.
2. Inspect:
   - baseline signatures;
   - prompt fingerprint;
   - chat accessible name;
   - timestamps;
   - active job count.
3. Do not choose an arbitrary latest tile.

## 33.15 Download failed

1. Reopen exact same asset.
2. Retry download.
3. Validate.
4. Never regenerate because download failed.

## 33.16 YouTube OAuth expired

1. Keep Review/queued media safe.
2. Reauthorize YouTube independently.
3. Do not invoke Flow.

## 33.17 YouTube upload/schedule failed

1. Resume/reconcile resumable upload.
2. Preserve approved metadata.
3. Do not send episode back to Flow.

---

# 34. Observability requirements

Recommended structured events:

```text
FLOW_SESSION_READY
FLOW_PROJECT_RESOLVED
FLOW_PROJECT_VERIFIED
FLOW_PROMPT_TARGET_VERIFIED
FLOW_SETTINGS_APPLIED
FLOW_PROMPT_INSERTED
FLOW_PROMPT_VERIFIED
FLOW_BASELINE_CAPTURED
FLOW_SUBMIT_BOUNDARY_ENTERED
SUBMIT_ARROW_CLICKED
FLOW_CONFIRMATION_VISIBLE
FLOW_CONFIRMATION_ACCEPTED
FLOW_PROJECT_ASSET_DETECTED
FLOW_RENDER_COMPLETE
FLOW_VIDEO_OPENED
FLOW_VIDEO_DOWNLOADED
FLOW_VIDEO_VALIDATED
REVIEW_METADATA_READY
REVIEW_READY
SERIAL_GATE_BLOCKED
DAILY_LIMIT
FLOW_JOB_FAILED
```

Fields when applicable:

```text
timestamp
episode
job_id
generation_id
project_name
project_id
state
prompt_hash
baseline counts
post counts
consent_mode
retry_count
error_code
screenshot_ref
dom_snapshot_ref
download_size
duration
width
height
codec
title
```

Never log secrets.

Event names must preserve evidence semantics. A mere click must not be named `GENERATION_STARTED`.

---

# 35. Automatic evidence capture

Capture evidence automatically when:

- authentication challenge;
- wrong project;
- project title mismatch;
- prompt-target mismatch;
- settings mismatch;
- consent failure;
- submit ambiguity;
- render timeout;
- vanished render;
- asset correlation failure;
- download failure;
- validation failure;
- repeated selector failure.

Recommended evidence package:

```text
timestamp
current URL
visible project title
screenshot
visible body excerpt
critical selector counts
current lifecycle
baseline inventory
post inventory
console errors
network summary if available
browser trace reference
```

Strip cookies, tokens, passwords and authorization headers.

---

# 36. Data contract

Persist at least:

```yaml
episode_id: string
job_id: string
attempt_id: string
generation_intent_id: string
flow_project_id: string
flow_project_name: string
prompt: string
prompt_hash: sha256
model: string
aspect_ratio: string
duration_seconds: number
output_count: number
reference_assets: []
created_at: timestamp
submitted_at: timestamp
asset_detected_at: timestamp
generation_completed_at: timestamp
asset_signature: string
video_path: string
download_size: integer
download_duration: number
download_width: integer
download_height: integer
download_codec: string
validation_status: string
title: string
description: string
review_status: string
youtube_status: string
```

If Flow does not expose a stable generation id, the application `generation_intent_id` still protects exactly-once semantics.

---

# 37. YouTube post-Flow contract

Flow ends at a validated Review item. Publication is a separate idempotent pipeline.

```text
REVIEW_READY
→ operator APPROVE
→ publication queue
→ private staging/upload
→ approved title/description
→ synthetic-media disclosure
→ scheduling
→ verification
→ published
```

Required disclosure for AI-generated/meaningfully altered video:

```text
containsSyntheticMedia = true
```

A YouTube problem must never cause a new Flow generation.

---

# 38. Golden Test

After any critical Flow change, run exactly one paid generation.

Pass criteria:

1. persistent session valid;
2. exact project resolved;
3. project title correct;
4. prompt composer correct;
5. Video mode correct;
6. model correct;
7. aspect ratio correct;
8. duration correct;
9. output count correct;
10. prompt inserted/read back;
11. baseline persisted;
12. exactly-once boundary persisted;
13. exact right-arrow clicked once;
14. current consent handled or absent;
15. unique post-baseline project video tile observed;
16. no second submit;
17. same tile becomes recoverable;
18. same tile opened;
19. MP4 downloaded;
20. MP4 validated;
21. title/description/hashtags generated;
22. Review shows playable video and final metadata;
23. lifecycle is `REVIEW_READY`;
24. serial gate released.

Only then:

```text
FLOW_AUTOMATION_HEALTHY = TRUE
```

If any critical checkpoint fails:

```text
FLOW_AUTOMATION_HEALTHY = FALSE
```

Do not downgrade the result to “mostly works.”

---

# 39. Confidence map

| Component | Status | Confidence | Evidence |
|---|---|---:|---|
| Persistent Flow session | VERIFIED | HIGH | successful automated run + recoveries |
| Exact Earth project | VERIFIED | HIGH | name + project id |
| Prompt/title distinction | VERIFIED in code; historical failure known | HIGH | explicit guards |
| Video settings | VERIFIED | HIGH | successful settings log |
| Prompt insertion | VERIFIED | HIGH | Recorder + runtime |
| Exact right-arrow submit | VERIFIED | HIGH | Muestra 3 + automated success |
| Simple Network `generate` filter | NOT REQUIRED / UNKNOWN | LOW | no useful row in Muestra 3 |
| Always-approve profile behavior | VERIFIED for current profile | MEDIUM-HIGH | human consent + later no-dialog |
| New project video tile evidence | VERIFIED | HIGH | successful run tile delta |
| Strict serial recovery | VERIFIED | HIGH | automated recovery |
| Project-grid recovery | VERIFIED | HIGH | Patagonia, Namib and automated result |
| MP4 validation | VERIFIED | HIGH | 10s 1080×1920 outputs |
| Review playback | VERIFIED | HIGH | operator screenshot |
| Old Review metadata | FAILED | HIGH | placeholder visible in screenshot |
| Prompt/context Review metadata | IMPLEMENTED | HIGH design | deterministic builder |
| Normal 3/day | VERIFIED | HIGH | runtime daily stop |
| Date-scoped 6/day | IMPLEMENTED TEST MECHANISM | HIGH design | auto-expiring override |
| Synthetic-media disclosure | VERIFIED in code | HIGH | YouTube publication field |

---

# 40. Dependency map

## Google Flow

Role: generation and project asset storage.  
Failure detection: auth challenge, project mismatch, selector change, explicit generation failure, no retained asset.  
Recovery: preserve lifecycle, reverify exact project, never duplicate submit.

## Google authentication

Role: Flow session.  
Failure: sign-in/security challenge.  
Recovery: approved persistent-profile bootstrap.

## Chromium / Playwright

Role: browser automation.  
Failure: crash, stale lock, selector change.  
Recovery: persistent profile + durable state + lease heartbeat.

## Railway

Role: runtime hosting, worker, volume and deployments.  
Failure: restart/deploy.  
Recovery: reconstruct from `/data`.

## SQLite/runtime data

Role: lifecycle, idempotency, accounting, Review metadata.  
Failure: unavailable/corrupt.  
Recovery: stop generation until durable state is restored.

## GitHub

Role: source and versioned SOP.  
Failure: source/deploy mismatch.  
Recovery: pin commits and deploy only tested code.

## YouTube API/OAuth

Role: post-approval upload and scheduling.  
Failure: auth/upload/schedule.  
Recovery: publication-specific retry; no Flow regeneration.

---

# 41. Security

Never export:

- Google cookies;
- login passwords;
- OAuth client secrets;
- access/refresh tokens;
- bearer tokens;
- passkey private material;
- Railway secret values;
- resumable upload URLs intended to remain private.

Use logical names for protected stores rather than values.

---

# 42. SOP versioning

Current version:

```text
FLOW-SOP-v1.0
```

When Flow changes:

1. reproduce the failure;
2. preserve evidence;
3. identify which assumption broke;
4. mark previous assumption invalid if needed;
5. update selector/state/recovery logic;
6. increment SOP version;
7. record changelog;
8. run one Golden Test;
9. only then promote the new version to runtime knowledge.

---

# 43. Publisher Factory integration

Every future Publisher should inherit this SOP automatically.

New Publisher setup should supply adapter data only:

```text
Show Bible
Google/Flow account/profile
Flow project
model/settings
saved characters/reference assets
daily volume
YouTube channel
posting schedule
metadata rules
review policy
```

A new application must not rediscover basic Flow control from scratch.

Conceptual interface:

```text
generate_video(
    prompt,
    model,
    duration,
    aspect_ratio,
    reference_assets,
    project_config,
    metadata_config
)
→ {
    generation_intent_id,
    asset_evidence,
    local_video,
    validation,
    title,
    description,
    review_item
}
```

---

# 44. AI implementation brief

If you are an AI agent receiving only this SOP:

1. Do not modify FruttiDrama while repairing another Publisher unless explicitly authorized.
2. Verify the exact Flow project before every submit.
3. Distinguish project title from prompt composer.
4. Verify generation settings.
5. Insert and read back the prompt.
6. Capture a project-grid baseline.
7. Persist exactly-once state before clicking.
8. The verified submit is the right-arrow `arrow_forward` inside `flow-generate-icon-button`.
9. Click it once.
10. Handle only consent created after the current boundary.
11. Do not trust click success, busy text, disabled controls, chat video options or guessed request names as sole proof.
12. Require project-correlated post-baseline evidence.
13. Keep exactly one in-flight generation/retrieval job.
14. Recover from the project grid.
15. Validate the MP4.
16. Generate final YouTube title/description/hashtags before Review.
17. Only after Review-ready may the next job begin.
18. On uncertainty, reconcile—never resend.
19. Date-scope temporary volume overrides.
20. Update this SOP after Flow changes.

---

# 45. Troubleshooting decision tree

```text
Video not in Review
│
├─ Correct Flow project verified?
│  ├─ NO → WRONG_PROJECT → resolve exact project → no submit
│  └─ YES
│
├─ Prompt in real composer and title unchanged?
│  ├─ NO → PROMPT_FAILED / TITLE CONTAMINATION
│  └─ YES
│
├─ Settings verified?
│  ├─ NO → fix settings → no submit
│  └─ YES
│
├─ Baseline persisted?
│  ├─ NO → unsafe → no submit
│  └─ YES
│
├─ Submit boundary persisted?
│  ├─ NO → do not click
│  └─ YES
│
├─ Exact right arrow clicked once?
│  ├─ NO → selector/input failure
│  └─ YES
│
├─ New current consent?
│  ├─ YES → approve current only
│  └─ NO → valid branch
│
├─ New project video tile relative to baseline?
│  ├─ NO → SUBMIT_AMBIGUOUS → reconcile only
│  └─ YES
│
├─ More than one in-flight job?
│  ├─ YES → correlation emergency → freeze
│  └─ NO
│
├─ Current tile persists and becomes downloadable?
│  ├─ NO, then disappears after safety window → no-retained-render recovery
│  ├─ NO, still exists → continue waiting
│  └─ YES
│
├─ Download succeeds?
│  ├─ NO → retry same asset
│  └─ YES
│
├─ MP4 validates?
│  ├─ NO → redownload same asset
│  └─ YES
│
├─ Final title/description ready?
│  ├─ NO → metadata repair; never publish placeholder
│  └─ YES
│
└─ REVIEW_READY → next serial job allowed
```

---

# 46. Changelog v1.0

- Frozen the first verified automated Earth generation/recovery path.
- Recorded exact Earth project id.
- Replaced vague “Generate button” terminology with recorder-exact right-arrow selector.
- Invalidated click/busy/chat-option false positives.
- Made exact-project grid evidence canonical.
- Made strict serial generation/recovery mandatory.
- Established project-grid recovery as the primary route.
- Established MP4 validation as mandatory before Review.
- Added restart/redeploy exactly-once recovery.
- Added Review screenshot as proof that recovered videos reached the panel.
- Classified generic Review metadata as a failure.
- Added prompt/context-derived YouTube copy.
- Added Earth hashtag defaults.
- Added concrete autonomous Earth landscape planning.
- Added date-scoped one-day six-video test.
- Preserved normal 3/day target.
- Added vanished-render self-healing.
- Added insufficient-credit detection.
- Added runtime knowledge-pack requirement.
- Added Golden Test and versioning rules.

---

# 47. Final operational rule

> **VERIFY THE PROJECT. VERIFY THE PROMPT FIELD. VERIFY SETTINGS. SAVE THE BASELINE. PERSIST THE BOUNDARY. CLICK THE RIGHT ARROW ONCE. HANDLE ONLY CURRENT CONSENT. WAIT FOR A NEW PROJECT VIDEO TILE. GENERATE NOTHING ELSE. RECOVER THAT TILE. VALIDATE THE MP4. CREATE FINAL YOUTUBE COPY. MOVE IT TO REVIEW. ONLY THEN UNLOCK THE NEXT VIDEO.**

This is the shortest faithful representation of what actually worked.

---

# Appendix A — Release checklist

Before deploying a Flow automation change:

- [ ] exact project resolver unchanged or tested;
- [ ] title guard intact;
- [ ] prompt locator intact;
- [ ] settings verifier intact;
- [ ] right-arrow selector intact;
- [ ] consent scoped to current message;
- [ ] baseline persisted before submit;
- [ ] post-boundary auto-resend impossible;
- [ ] serial lock intact;
- [ ] project-grid correlation intact;
- [ ] same-asset download retries only;
- [ ] MP4 validation intact;
- [ ] metadata generated before Review;
- [ ] YouTube metadata preserved after approval;
- [ ] synthetic-media disclosure intact;
- [ ] daily accounting intact;
- [ ] date-scoped override intact;
- [ ] vanished-render recovery does not resubmit prematurely;
- [ ] credit-failure path does not hammer Flow;
- [ ] SOP version updated if behavior changed;
- [ ] Golden Test run when required.

# Appendix B — Review copy quality checklist

Before Review is shown:

- [ ] title contains no internal `NEXT CHAPTER` placeholder unless intentionally public;
- [ ] description contains no Creative Bible instruction;
- [ ] location/subject is supported by prompt/context;
- [ ] no invented fact is unsupported;
- [ ] Earth title contains `#Shorts #ViralShorts` when space permits;
- [ ] Earth description contains `#EarthIn10 #Nature #Travel #Shorts #ViralShorts`;
- [ ] title/description fit YouTube limits;
- [ ] same copy will be queued on approval.

# Appendix C — Evidence priority

When evidence conflicts, prioritize:

1. validated downloaded media linked to a post-baseline project asset;
2. exact target-project grid;
3. operator recording of the actual action;
4. durable lifecycle tied to that project/baseline;
5. component-scoped DOM observation;
6. browser input result;
7. generic chat/busy text;
8. speculative Network naming;
9. prior assistant assumption.

Later direct evidence invalidates earlier speculation.

# Appendix D — Why this SOP must travel with every Publisher

The automation required many iterations because Google Flow is a stateful web application in this workflow. If this knowledge remains only in one chat, a future Publisher can repeat expensive mistakes: wrong project, wrong editable field, false submit, stale consent, parallel recovery race, duplicate credit spend, vanished temporary tiles, lost asset correlation and generic Review metadata.

Every Publisher related to this system should therefore carry:

```text
GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md
GOOGLE_FLOW_AUTOMATION_SOP.json
FLOW_AI_IMPLEMENTATION_BRIEF.md
FLOW_FAILURE_CATALOG.md
FLOW_RECOVERY_RUNBOOK.md
FLOW_GOLDEN_TEST.md
FLOW_CHANGELOG.md
```

and should persist current SOP version/hash/content or a durable knowledge record in its runtime storage.

The purpose is reproducibility after chat loss, model changes, agent turnover, deploys and future Flow UI changes.

---

## 34. DAILY FLOW CREDIT-CYCLE GATE — renewal-driven production

**Status:** MANDATORY FOR EVERY PUBLISHER  
**Added:** 2026-09-25  
**Purpose:** prevent the automatic 3-video batch from spending subscription/monthly credits merely because the local calendar crossed midnight.

### 34.1 Provider fact and scheduling consequence

Google Flow grants **50 daily credits** to users with or without a Google AI subscription. Subscription plans can also have a separate monthly credit pool. Daily unused credits do not roll over. Therefore the Publisher's production day MUST NOT be inferred from local `00:00`.

The ordinary automatic batch is tied to a **Flow credit cycle**, not to a calendar day:

```
WAITING_FOR_DAILY_FLOW_CREDIT_REFRESH
  -> observe a trustworthy live Flow balance
  -> confirm the new daily allocation/refill
  -> DAILY_CREDIT_CYCLE_OPEN
  -> generate/recover serially up to the configured ordinary batch target (default 3)
  -> capture the post-batch Flow balance
  -> DAILY_CREDIT_BATCH_COMPLETE
  -> return to WAITING_FOR_DAILY_FLOW_CREDIT_REFRESH
```

Changing date, restarting Railway, reopening the browser, or seeing a large paid/monthly balance MUST NOT by itself open a new automatic batch.

### 34.2 Canonical numbers

Default Publisher policy:

- daily Flow grant: **50 credits**;
- ordinary daily production target: **3 videos**;
- current canonical generation cost: **15 credits per generation**;
- ordinary batch spend: **45 credits**;
- residual daily allowance after three normal generations: **5 credits**;
- renewal polling cadence while waiting: **5 minutes**;
- renewal guard window: begin active refill detection after **20 hours** from the current credit-cycle opening;
- conservative masking fallback: **30 hours**, only when a live balance sufficient for the full normal batch is visible.

Because unused daily credits do not roll over, the next daily grant may appear as a **net visible balance increase of about 45 rather than exactly 50** after a normal 3×15 batch. The detector MUST therefore reason from the prior live balance and known spend; it MUST NOT require an exact +50.

### 34.3 Paid-account protection

A paid account may display hundreds or thousands of monthly/subscription credits. A large balance is **not** evidence that the new daily 50-credit grant arrived.

For an already-running Publisher:

1. persist the current credit-cycle opening timestamp;
2. after the normal batch, capture the live Flow balance as the post-batch baseline;
3. preserve that baseline across midnight and restarts;
4. when the renewal window is reached, poll the live Flow credit display;
5. open the next ordinary batch only after a credible refill is observed.

This protects the paid monthly pool from being consumed at 00:00 before the free daily grant is renewed.

### 34.4 First-run bootstrap

A brand-new Publisher has no prior credit baseline.

- If the visible balance is consistent with the daily allocation (enough for the 45-credit ordinary batch and approximately within the 50-credit daily range), it may seed the first credit cycle.
- If the account already has a large paid balance, the system MUST treat it as ambiguous and observe until a daily refill is detected. It must not assume that the paid balance is the daily grant.
- Existing Publishers upgraded to this protocol bootstrap their current cycle from recent confirmed generation history, so the upgrade itself never creates an extra batch.

### 34.5 Refill detection

A refill is strong evidence when the current live balance increases over the persisted prior balance by an amount consistent with the daily allocation after known cycle spend. For a canonical completed 3-video batch, approximately +45 to +50 is expected.

If the provider's non-rollover accounting masks a visible balance delta, the runtime may use the conservative fallback only after the configured long guard (default 30h) and only when the live Flow balance can fund the full ordinary batch. The fallback exists to avoid permanent deadlock; it is never tied to midnight.

### 34.6 What bypasses the ordinary batch gate

This gate controls the **ordinary autonomous 3-video batch**.

It does not abandon or pause:
- recovery of a generation that has already crossed the submit boundary;
- retrieval/download/validation of an existing asset;
- read-only reconciliation;
- publication work;
- explicit human-authorized REDO according to its exactly-once token;
- explicit operator Generate Extra requests, subject to the existing credit/cooldown safeguards.

Recovery always has priority over quota/credit-cycle scheduling because a submitted intent must be resolved without generating a duplicate.

### 34.7 Interaction with Unusual Activity and insufficient credits

The credit-cycle gate does not weaken the provider-wide cooldown.

- confirmed daily refill does not cancel an active Unusual Activity cooldown;
- active cooldown still blocks new submits;
- an explicit provider insufficient-credits signal closes/holds automatic production and returns to credit observation;
- a successful retained render may reset the unusual-activity streak under the existing policy, but does not manufacture a new credit cycle.

### 34.8 Required durable state

Every Publisher must persist at minimum:

- `flow:dailyCreditCycle`;
- `flow:dailyCreditCycleId`;
- `flow:dailyCreditCycleOpenedAt`;
- `flow:dailyCreditCycleUsed`;
- `flow:dailyCreditCycleTarget`;
- `flow:dailyCreditBatchOpen`;
- `flow:dailyCreditRefreshWaiting`;
- `flow:lastCreditsVisible`;
- `flow:lastCreditsCheckedAt`;
- `flow:lastCreditsEvidence`;
- `flow:dailyCreditRenewalEvidence`.

This state survives process/browser/Railway restarts.

### 34.9 Health contract

`/factory/health` must expose the credit-cycle state and assert:

- `daily_flow_credit_refresh_gate = true`;
- `calendar_midnight_does_not_open_batch = true`;
- `paid_monthly_credits_protected_until_daily_refresh = true`.

Publisher Factory must refuse to consider a newly generated Publisher protocol-complete if these invariants are absent.

### 34.10 Acceptance tests

A protocol-complete Publisher must pass all of the following without clicking Generate unnecessarily:

1. local midnight with unchanged Flow balance does **not** open a new batch;
2. a large paid/monthly balance by itself does **not** open a new batch;
3. a credible daily refill opens exactly one new credit cycle;
4. three ordinary successful generation intents close the default cycle;
5. the next calendar midnight remains closed until the next Flow refill;
6. restart during WAITING state preserves the same cycle/baseline;
7. restart during generation preserves exactly-once/recovery semantics;
8. active Unusual Activity cooldown wins over credit renewal;
9. the UI/health endpoint reports the observed balance, check time, cycle ID, used/target and waiting/open state;
10. no fourth ordinary automatic video is created merely because date/account balance changed.

**Invariant:** `CALENDAR DAY ≠ FLOW CREDIT DAY`. The provider's actual daily-credit renewal is the scheduling authority for ordinary automatic generation.
