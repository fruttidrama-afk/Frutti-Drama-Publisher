# FLOW SERIAL GENERATION & RECOVERY SOP

**SOP ID:** FLOW-SERIAL-GEN-RECOVER-001  
**Status:** Canonical  
**Applies to:** Publisher Factory, Earth in 10, FruttiDrama-compatible runtimes  
**Core invariant:** exactly one Flow generation may be in-flight at a time.

## 1. Golden rule

```text
GENERATE ONE
→ WAIT UNTIL THAT SAME GENERATION FINISHES
→ RECOVER THAT SAME VIDEO
→ VALIDATE THE MP4
→ MOVE IT TO REVIEW
→ ONLY THEN MAY THE NEXT GENERATION START
```

Never submit N videos and then recover N videos afterward.

## 2. Why serial execution is mandatory

The project grid is a reliable recovery source only when the runtime guarantees that no newer generation can overtake the job being recovered.

Therefore:

- while one job is in `SUBMIT_BOUNDARY_ENTERED`, `SUBMIT_AMBIGUOUS`, `GENERATION_STARTED`, `RETRIEVING`, or `RETRIEVAL_PENDING`, every later job is blocked;
- a later prompt must not be inserted/submitted until the current job reaches `REVIEW_READY`, `queued`, `published`, or another explicit terminal/manual state;
- download failure retries recovery of the same asset; it never authorizes a new generation.

## 3. State machine

```text
DRAFT
  ↓
PREFLIGHT
  ↓
PROMPT_VERIFIED
  ↓
BASELINE_CAPTURED
  ↓
SUBMIT_BOUNDARY_ENTERED
  ↓
GENERATE_CLICKED_ONCE
  ↓
[optional current consent message]
  ↓
GENERATION_STARTED
  ↓
WAIT_RENDER
  ↓
PROJECT_GRID_ASSET_APPEARS
  ↓
OPEN_EXACT_ASSET
  ↓
DOWNLOAD
  ↓
MP4_VALIDATE
  ↓
REVIEW_READY
  ↓
UNLOCK_NEXT_JOB
```

## 4. Exactly-once submit rule

Immediately before clicking Flow's generation control, persist:

```yaml
state: SUBMIT_BOUNDARY_ENTERED
automatic_submit_forbidden: true
generation_id: <uuid>
baseline: <project inventory before submit>
```

Then click the real prompt-box generation button exactly once.

After that point:

```text
UNCERTAINTY != PERMISSION TO RESEND
UNCERTAINTY = READ-ONLY RECONCILIATION
```

## 5. Consent handling

Only interact with a **new permission message created after the current Send**.

Preferred order inside that current permission message:

```text
Aprobar siempre / Always approve
Aprobar / Approve
explicit Generate confirmation
no dialog → continue observing generation
```

A click is not considered accepted merely because the browser executed it.

Success requires either:

- the current permission control disappears; or
- Flow visibly transitions into generation state.

If the consent control remains actionable and there is no generation transition, record:

```text
FLOW_CONSENT_CLICK_NOT_ACCEPTED
```

and do not resubmit.

## 6. Generation-start evidence

Accept one or more of:

- new `flow-a2ui-video-option`;
- new project-grid video tile;
- fresh video media source;
- current generation control disabled/hidden plus real busy/generating state.

Persist `GENERATION_STARTED` and stay recovery-only.

## 7. Project-grid recovery — preferred canonical path

The operator-recorded path is:

```text
Flow
→ target project
→ project grid
→ newest video tile produced by the current job
→ flow-tile-hover-footer / open tile
→ media editor
→ Descargar contenido multimedia
→ configured quality
→ browser download
```

When serial mode is obeyed, the newest video tile after the stored baseline is the current job's output.

Do not start the next job until that MP4 is validated and stored.

## 8. Chat recovery — secondary path

The Flow chat may expose the rendered result through:

```text
flow-chat-bubble
→ flow-a2ui-message-renderer
→ flow-a2ui-video-option
→ img
```

The image may expose the generation prompt as its accessible name.

This is a valid fallback, but project-grid recovery is preferred because it does not depend on the current chat session remaining visible.

## 9. Download

Preferred trigger:

```text
aria/Descargar contenido multimedia
```

Prefer matching the configured quality by visible label.

A recorder-proven third-menu-item fallback is allowed only when the semantic quality label cannot be found and the current Flow UI is known to match the recorded menu.

## 10. MP4 validation

Required:

```yaml
file_exists: true
size_bytes: > 100000
ftyp_present: true
video_stream_present: true
decodable: true
duration_within_configured_tolerance: true
orientation_matches_config: true
```

Recommended via `ffprobe`.

Only then:

```yaml
state: REVIEW_READY
status: review
```

## 11. Serial scheduler gate

Before starting a new draft/regen job, query the runtime DB.

If any job exists in an active generation/retrieval state:

```text
generating
SUBMIT_BOUNDARY_ENTERED
SUBMIT_AMBIGUOUS
GENERATION_STARTED
RETRIEVING
RETRIEVAL_PENDING
```

then:

```text
BLOCK ALL LATER GENERATIONS
```

The scheduler may only select the earliest unresolved head-of-line job.

## 12. Daily quota semantics

For a target of 3/day:

```text
video 1: generate → recover → validate → review
video 2: generate → recover → validate → review
video 3: generate → recover → validate → review
STOP FOR THE DAY
```

A manually generated/recovered Golden Run can count as one daily production if its validated MP4 is attached to the correct job and accounted once.

## 13. Crash recovery

If the process crashes after Generate:

```text
restart
→ detect SUBMIT_BOUNDARY_ENTERED / SUBMIT_AMBIGUOUS
→ DO NOT GENERATE
→ inspect Flow/project grid
→ if output exists: recover it
→ if still rendering: wait
→ if uncertain: keep reconciling
```

If download fails:

```text
reopen same correlated project-grid asset
→ retry download
→ never regenerate
```

## 14. Terminal rule

The next video may start only when the current video has:

```text
1. a real Flow render,
2. a recovered local MP4,
3. successful validation,
4. a persisted Review-ready record.
```

**Operational one-line rule:**  
> One submit, one render, one recovery, one validation, one review — then and only then the next submit.
