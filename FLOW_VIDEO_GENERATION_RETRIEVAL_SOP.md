# Google Flow Video Generation & Retrieval SOP

**SOP ID:** FLOW-GEN-RETRIEVE-001  
**Version:** 1.0  
**Source of truth:** successful Chrome Recorder Golden Run `FLOW_GOLDEN_RUN_001` recorded on 2026-09-21.  
**Purpose:** let an AI/browser worker generate exactly one Google Flow video, survive consent variations/timeouts, recover the correct rendered asset, download it, validate it, and hand it to the Publisher runtime without duplicate generations.

## 1. Non-negotiable invariants

1. **Exactly one generation intent per job.** Create a unique `generation_id` before clicking the send/generate control.
2. **Never edit the project title by mistake.** The project title control and the prompt composer are different controls.
3. **Never treat “Send clicked” as proof that no generation happened.** Send is a possible commit boundary.
4. **Never regenerate because of uncertainty.** Uncertainty means reconcile read-only.
5. **After generation is proven, enter RETRIEVE_ONLY.** From this state the worker may wait, inspect, open assets and download, but must not click Generate again.
6. **Only the exact job asset may be accepted.** Do not blindly download “the latest video” if multiple jobs may exist.
7. **Success means validated local MP4, not merely a visible Flow result.**
8. **Do not store passwords, cookies, OAuth tokens, session secrets or other credentials in logs/SOP artifacts.**

## 2. Golden Run evidence

The recorded successful UI path was:

```
Flow home
  -> open target project
  -> configure generation settings
  -> click the real creative-agent prompt composer
  -> paste prompt
  -> click semantic control "Iniciar generación"
  -> consent message appears
  -> click "Aprobar siempre"
  -> wait for rendered result
  -> click the generated result from the chat
  -> click "Descargar contenido multimedia"
  -> choose the desired media download option
  -> MP4 download
```

Important implementation lesson: generated Material/Angular IDs such as `mat-button-toggle-40` and `mat-menu-panel-61` are not stable contracts. The runtime must prefer semantic labels, component context and runtime state.

## 3. Required per-job persisted state

```yaml
generation_id: uuid
job_id: string
prompt_hash: sha256
prompt_length_bytes: integer
project_id: string
project_name: string

state: one_of:
  - PREFLIGHT
  - PREFLIGHT_PASSED
  - SUBMIT_BOUNDARY_ENTERED
  - SUBMIT_AMBIGUOUS
  - GENERATION_STARTED
  - RETRIEVING
  - RETRIEVAL_PENDING
  - RETRIEVED
  - REVIEW_READY

consent_mode: one_of:
  - UNKNOWN
  - ALWAYS_APPROVED
  - PER_GENERATION
  - NO_DIALOG_OBSERVED

automatic_submit_forbidden: boolean
submit_boundary_at: iso_datetime|null
generation_started_at: iso_datetime|null

baseline:
  video_sources: []
  tile_count: integer
  tile_signatures: []

result:
  local_path: string|null
  duration_seconds: number|null
  width: integer|null
  height: integer|null
  bytes: integer|null
  codec: string|null
  validated: boolean
```

### Consent semantics

- `ALWAYS_APPROVED`: the worker explicitly clicked “Aprobar siempre” / “Always approve” or a prior persisted profile state proves this.
- `PER_GENERATION`: the worker explicitly approved only the current generation.
- `NO_DIALOG_OBSERVED`: no dialog appeared in this run and no prior durable consent mode proves why. This can mean Flow did not require consent or the profile was already approved. Do not over-interpret it.
- `UNKNOWN`: no relevant observation yet.

## 4. Preflight

Before any submit:

1. Open exactly the configured Flow project URL/project ID.
2. Confirm authentication. If Google login, CAPTCHA, “verify it’s you”, security check or similar appears, stop with `AUTH_REQUIRED`; do not create a new browser identity.
3. Verify project identity:
   - URL contains configured project ID.
   - project title equals configured project name.
   - if the title contains prompt text or production instructions, treat it as contamination and repair only if the canonical title is known.
4. Locate the **real prompt composer**. Preferred strategy:
   - search inside `flow-creative-agent-prompt-box` / `flow-base-prompt-box`;
   - prefer visible `contenteditable=true` nearest the semantic generation button;
   - fallback to the known Flow placeholder when present;
   - reject visible top-of-page “Editable text” title inputs.
5. Verify desired generation settings semantically, not by numeric element IDs. Read visible labels for video/image mode, aspect ratio, duration, output count, model and resolution.
6. Apply characters/ingredients only from the publisher’s configured registry. Verify each required visual character chip is present before continuing.
7. Fill the prompt, then read it back and verify:
   - prefix matches;
   - suffix matches;
   - byte length approximately matches;
   - SHA-256 matches the persisted prompt hash.
8. Capture a pre-submit baseline:
   - visible video sources;
   - Flow asset/grid tile count;
   - ordered tile signatures/accessible names;
   - current busy/generating indicators.

If any preflight item cannot be verified, fail closed. Do not guess.

## 5. Selector policy

Selector priority:

```
1. Accessible role + accessible name
2. Stable visible text
3. Flow custom-element/component context
4. Stable attributes
5. CSS structural fallback
6. XPath/nth-of-type only as last-resort compatibility fallback
```

Recorded semantic anchors that are approved for recognition:

```text
Iniciar generación
Start generation
Aprobar siempre
Always approve
Approve always
Aprobar
Approve
Descargar contenido multimedia
Download
Export
Descargar
```

Do **not** hard-code recorder-only generated IDs such as `#mat-button-toggle-40-button`.

## 6. Submit and consent resolver

### 6.1 Enter the boundary first

Immediately before clicking the generation control:

```yaml
state: SUBMIT_BOUNDARY_ENTERED
automatic_submit_forbidden: true
submit_boundary_at: now
baseline: <captured baseline>
```

Persist this **before** the click.

### 6.2 Click Generate/Send exactly once

Find the enabled visible control whose semantic intent is generation. In the Golden Run, Chrome Recorder identified the control as `aria/Iniciar generación`.

Execute one trusted click.

Do not click it again in the same job.

### 6.3 Resolve consent dynamically

After the send click, scan for consent for up to the configured consent window.

Priority is deliberately:

```
Aprobar siempre / Always approve / Approve always
THEN
Aprobar / Approve
THEN
explicit Generate confirmation
THEN
no dialog
```

#### Case A — “Aprobar siempre” is available

Click it once.

Persist:

```yaml
consent_mode: ALWAYS_APPROVED
automatic_submit_forbidden: true
```

This is the preferred choice because future generations using the same persistent Flow profile should normally stop asking.

#### Case B — only per-generation approval is available

Click the one-time approval exactly once.

Persist:

```yaml
consent_mode: PER_GENERATION
automatic_submit_forbidden: true
```

#### Case C — no consent dialog appears

Do not treat this as failure.

If durable state already says `ALWAYS_APPROVED`, retain that value. Otherwise record `NO_DIALOG_OBSERVED`.

Then wait for hard generation evidence.

## 7. Hard generation evidence

A submit is considered proven only when at least one hard signal appears:

- a new Flow asset/grid tile not present in the baseline;
- a previously absent video source appears;
- another durable Flow UI artifact uniquely associated with this job appears.

Busy text such as “generating” can support the decision but should not be the sole long-lived correlation key.

When proven:

```yaml
state: GENERATION_STARTED
generation_started_at: now
automatic_submit_forbidden: true
```

From now on the worker is **RETRIEVE_ONLY**.

## 8. Ambiguity rule — the most important recovery rule

If the worker clicked Send/Generate or consent but cannot prove generation:

```yaml
state: SUBMIT_AMBIGUOUS
automatic_submit_forbidden: true
```

Never reset directly to draft merely because a timer expired.

On every later worker pass:

1. Open the same project.
2. Read Flow only.
3. Compare current videos/assets/grid inventory with the persisted pre-submit baseline.
4. If a matching new result or active render is found:
   - transition to `GENERATION_STARTED`;
   - retrieve only.
5. If the inventory is unchanged for the full reconciliation safety window and there is positive evidence that no generation exists:
   - transition to `RECONCILED_NO_GENERATION`;
   - only then may a new submit intent be created.
6. If evidence remains inconclusive:
   - remain `SUBMIT_AMBIGUOUS`;
   - schedule another read-only reconciliation;
   - Generate stays locked.

Canonical rule:

```
UNCERTAINTY => RECONCILE
CONFIRMED GENERATED => RETRIEVE
CONFIRMED NOT GENERATED => NEW GENERATION MAY BE AUTHORIZED
```

## 9. Render wait

After `GENERATION_STARTED`:

```yaml
state: RETRIEVING
automatic_submit_forbidden: true
```

Poll/read Flow state at a conservative interval. Do not produce another generation.

A retrieval timeout becomes:

```yaml
state: RETRIEVAL_PENDING
automatic_submit_forbidden: true
```

A retrieval timeout is **not** permission to regenerate.

## 10. Opening the generated asset

Two valid paths exist.

### Path A — chat result (confirmed by Golden Run)

The successful recording clicked the result shown in the Flow chat. The result’s accessible name contained the generated prompt text.

Preferred correlation strategy:

1. derive a prompt fingerprint from the persisted prompt;
2. search the newest result controls/images whose accessible label contains that fingerprint;
3. ensure it was not present in the baseline;
4. click it;
5. verify the media editor opens and a download control becomes visible.

### Path B — project asset/gallery panel

The operator-confirmed alternative is to enter the project asset panel containing images/videos and open the generation associated with this job.

Correlation requirements:

- prefer exactly one asset added after the stored baseline;
- compare accessible label/signature;
- compare generation time window;
- compare prompt fingerprint when Flow exposes it;
- never choose “latest” blindly if more than one concurrent generation could exist.

If correlation is not unique, do not download an arbitrary asset. Remain in retrieval/reconciliation.

## 11. Download

Once the correct result is open:

1. Find semantic control:
   - `Descargar contenido multimedia`
   - `Download`
   - `Export`
   - `Descargar`
2. Click it once.
3. Choose the publisher-configured quality by **visible label**, e.g. `1080p Upscaled` when configured.
4. The Golden Run used the download menu after opening the result. Its recorder fallback happened to be the third menu item, but **menu position is not a stable contract**.
5. Wait for the browser download event and save to the job’s deterministic local path.

## 12. Validate the recovered MP4

Required checks:

```yaml
file_exists: true
file_size_bytes: > 0
container_has_ftyp_signature: true
decodable: true
duration_matches_configured_target: true
orientation_matches_configured_aspect: true
width: > 0
height: > 0
```

Recommended:
- use `ffprobe` when available;
- for a 10-second job accept only the runtime’s configured narrow duration tolerance;
- ensure vertical jobs have `height > width`;
- decode at least one frame;
- persist codec/resolution/duration/size.

Only after validation:

```yaml
state: REVIEW_READY
result.validated: true
```

## 13. Error classes and safe actions

| Error | Safe action |
|---|---|
| AUTH_REQUIRED | stop and request/perform reauthentication; no submit |
| WRONG_FLOW_PROJECT | stop; no submit |
| PROJECT_TITLE_CONTAMINATED | restore known canonical title, verify, then continue |
| PROMPT_COMPOSER_NOT_FOUND | stop; no submit |
| SETTINGS_UNVERIFIED | stop; no submit |
| PROMPT_VERIFICATION_FAILED | stop; no submit |
| CONSENT_VISIBLE_BUT_NOT_CLICKED | preserve submit boundary; reconcile; no resend |
| SUBMIT_AMBIGUOUS | read-only reconciliation; Generate locked |
| RENDER_TIMEOUT | retrieval pending; no resend |
| RESULT_NOT_UNIQUE | keep retrieving/reconciling |
| DOWNLOAD_CONTROL_NOT_FOUND | reopen correlated asset, retry retrieval only |
| MP4_INVALID | retry download/recovery of same asset; do not regenerate |

## 14. Publisher integration contract

Every generated Publisher must implement these modules/behaviors:

```yaml
flow_identity:
  project_id: required
  project_name: required
  persistent_profile: required

generation_config:
  media_type: video
  aspect_ratio: configurable
  duration: configurable
  model: configurable
  output_count: configurable
  resolution: configurable
  download_quality: configurable

safety:
  exactly_once_submit: required
  submit_boundary_persisted_before_click: required
  ambiguous_submit_reconciliation: required
  retrieval_timeout_never_regenerates: required
  semantic_selectors_first: required
  title_vs_prompt_guard: required

consent:
  supports_no_dialog: true
  supports_per_generation: true
  supports_always_approve: true
  prefer_always_approve: true

retrieval:
  chat_result_path: required
  project_asset_path: required
  unique_job_correlation: required
  validated_mp4_required: true
```

## 15. AI execution pseudocode

```text
load(job)

if job.video_validated:
    return REVIEW_READY

open configured Flow project
authenticate-or-stop
verify project
verify settings
verify prompt destination

if state in {GENERATION_STARTED, RETRIEVING, RETRIEVAL_PENDING}:
    retrieve_only()
    return

if state in {SUBMIT_BOUNDARY_ENTERED, SUBMIT_AMBIGUOUS}:
    reconcile_read_only()
    if generation_exists:
        mark GENERATION_STARTED
        retrieve_only()
    else if positively_confirmed_no_generation:
        authorize_new_submit()
    else:
        leave Generate locked
    return

prepare prompt
verify prompt
capture baseline
persist SUBMIT_BOUNDARY_ENTERED
click generation ONCE

if "approve always" exists:
    click once
    persist ALWAYS_APPROVED
else if one-time approval exists:
    click once
    persist PER_GENERATION
else:
    persist prior ALWAYS_APPROVED or NO_DIALOG_OBSERVED

if hard_generation_evidence:
    persist GENERATION_STARTED
    retrieve_only()
else:
    persist SUBMIT_AMBIGUOUS
    NEVER RESEND
```

## 16. Acceptance tests

A Publisher implementation is not complete until all of these pass:

1. No-consent run generates one video and retrieves it.
2. Per-generation-consent run approves once, generates one video and retrieves it.
3. Always-approve run selects always once, generates one video, and the next run tolerates absence of the dialog.
4. Browser closes immediately after Send: restart does not submit again; it reconciles.
5. Browser closes immediately after consent: restart does not submit again.
6. Render takes longer than timeout: worker keeps retrieval mode and never regenerates.
7. Chat result retrieval succeeds.
8. Project gallery retrieval succeeds.
9. Two assets exist: worker only accepts uniquely correlated job asset.
10. Download fails once: retry download of same asset, not generation.
11. Invalid/partial MP4 is rejected and recovery is retried without generation.
12. Prompt accidentally targets title field: preflight blocks before submit.
13. Generated numeric DOM IDs change: semantic selector path still works.

## 17. Golden Run compatibility note

The current recorded account/profile selected **“Aprobar siempre”**. Future runs on that persistent profile should normally proceed without another consent prompt. The runtime must still support a new account/profile/project that asks again, because consent is an observed runtime condition, not a permanent global assumption.

---

**Operational one-line rule for every AI agent:**

> Click Generate once, prefer “Approve always” if offered, never regenerate from uncertainty, reconcile first, then recover and validate the exact MP4.
