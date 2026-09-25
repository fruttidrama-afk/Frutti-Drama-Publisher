# MASTER SOP — Publisher Factory / Shared Publisher Runtime

Status: ACTIVE
Owner: Publisher Factory
Purpose: make every solved production problem reusable across all existing and future publishers.

---

## 0. Meta-SOP: how every new learning becomes permanent

Every hard-won successful fix must leave a durable operating procedure.

### Before work
1. Identify subsystem: creative package, Flow, retrieval, review, feedback/redo, publishing, scheduling, branding/PWA, auth, deployment, UI, etc.
2. Read this SOP and any linked specialist SOP.
3. Search existing publishers and git history for a known-good implementation.
4. Prefer replication of proven behavior over a new implementation.
5. Protect working features: change only the failing layer.

### During work
1. Preserve a before-state / baseline.
2. Make the smallest change that addresses the actual root cause.
3. Do not spend generation credits for diagnostics unless explicitly authorized.
4. Keep source-of-truth IDs and timestamps where automation depends on external assets.
5. Fail closed: if correlation/verification is ambiguous, stop instead of guessing.

### After success
Record:
- symptom;
- root cause;
- exact implementation;
- failure modes discovered;
- production checks;
- recovery/rollback;
- what must be inherited by future publishers.

A task is incomplete until the learning is recorded here or in a linked SOP.

---

# 1. Creative package SOP

## Invariant
A generation is not allowed to start until its creative package is materialized and persisted.

A creative package contains at minimum:
- episode/story intent;
- production prompt;
- publication title;
- publication description/caption;
- platform metadata required by the selected publisher;
- stable package/hash/reference used by the generation record.

## Rules
- Never allow an empty prompt.
- Never use internal planner text such as `NEXT CHAPTER`, `continue canon`, `Beat 1`, or production instructions as viewer-facing title/description.
- Title and description are editorial copy derived from the narrative, not pasted prompt fragments.
- A description may use facts from the prompt but must be rewritten for the audience.
- Validate required fields before Flow submission.
- Persist the package before opening/submitting Flow.
- Review UI must render the publication copy from the persisted package, not from a fallback hook/story field.

## Verification
For every review item:
- prompt non-empty;
- title non-empty;
- description non-empty;
- no internal control phrases;
- title/description correspond to the same episode as the video.

---

# 2. Google Flow generation SOP

## Known-good sequence
1. Materialize creative package.
2. Snapshot Flow state before submission (existing video/result inventory).
3. Open the configured Flow project/session.
4. Ensure settings panel does not obstruct prompt/send controls.
5. Paste the exact persisted production prompt.
6. Submit exactly once.
7. If Flow shows the credit/consent double-check, choose **Always approve** for this autonomous publisher session.
8. Record generation ID/run ID, start time, session identity, baseline inventory, package hash.
9. Wait for a result that is provably new relative to the baseline.
10. Retrieve/import that result exactly once.
11. Mark the output consumed.
12. Only after successful retrieval may the normal autonomous queue move to the next episode. Do not wait for human approve/reject before generating the next normal daily episode.

## Correlation invariants
- Never "take the newest video" globally.
- Never reuse an asset that existed before generation start.
- One Flow output identity/content hash cannot satisfy two episode jobs.
- Ambiguity = stop/reconcile, not guess.
- A stale manual result must never be silently imported as a fresh autonomous episode.

## Daily Flow credit-cycle invariants
- Normal autonomous target is the publisher's configured batch target (current standard: 3 videos).
- **The automatic batch does not reset at local midnight.** Calendar date is not the authority for Flow production.
- Every account receives a 50-credit daily Flow allocation; paid plans can also expose a separate monthly/subscription balance.
- The Publisher must observe the live Flow credit balance and wait for evidence that the daily allocation renewed before opening the next ordinary automatic batch.
- A large paid/monthly balance by itself is never renewal evidence and must not be consumed simply because the calendar changed.
- Canonical batch economics are 3 × 15 = 45 credits. Since unused daily credits do not roll over, a completed normal batch can make the next 50-credit refresh appear as a net balance increase of roughly 45, not necessarily exactly 50.
- After the ordinary batch completes, capture and persist the post-batch Flow balance. Preserve this baseline and credit-cycle ID across process/browser/Railway restarts and across midnight.
- Default renewal watcher: 5-minute polling once the cycle is at least 20 hours old. A conservative 30-hour fallback may open a cycle only if Flow visibly has enough credits for the full batch and the non-rollover model may have masked the net refill.
- A confirmed automatic generation start consumes a slot in the current Flow credit cycle even if the item is later reset, deleted, rejected, or needs recovery.
- Recovery/reconciliation of an already-submitted generation is never blocked by the credit-cycle gate.
- REDO and Generate Extra remain explicit operator-authorized paths that may exceed the ordinary automatic batch; exactly-once and provider cooldown rules still apply.
- Emergency pause and Unusual Activity cooldown override a detected refill and block new Flow submission while allowing non-generation maintenance and publishing work.
- Required health invariants: daily_flow_credit_refresh_gate=true, calendar_midnight_does_not_open_batch=true, paid_monthly_credits_protected_until_daily_refresh=true.

## Recovery
If a generation exists in Flow but local retrieval failed:
- do not submit again;
- correlate/recover the existing fresh output first;
- if correlation cannot be proven, offer operator-assisted import rather than spending another credit.

---

# 3. Flow consent SOP

Flow can display:
- Approve
- Always approve
- Reject

For autonomous persistent operation:
- choose **Always approve**;
- do not approve old stale consent cards en masse;
- a delayed consent recovery must target the current pending generation only;
- after consent, still require proof of a new result before marking generation successful.

---

# 4. Review / REDO / AI feedback SOP

When the operator rejects/redo with natural-language feedback:
1. Treat feedback as semantic intent, not literal string replacement.
2. Use AI interpretation to determine what narrative/visual defect must change.
3. Preserve canon/show bible and anything the operator did not ask to change.
4. Produce a fresh creative package for the retry.
5. Persist the feedback and its interpreted correction.
6. Submit exactly one replacement generation.
7. Never let approval/rejection of one item block the normal generation of later daily items unless a serialized continuity dependency explicitly requires it.

A REDO is explicit operator authorization for another generation of that episode; it is not a normal daily-slot reset.

---

# 5. Publication SOP — YouTube

For the established YouTube workflow:
- do not upload directly public;
- do not upload immediately when review is approved;
- do not use YouTube `publishAt` as a substitute for the established two-step flow;
- at the configured private-upload time, upload as **private**;
- at the configured public time, edit the existing video and switch it to **public**;
- publication state in the Publisher must reflect the real YouTube state.

Publication time must be configurable from the Publisher UI and persisted.

---

# 6. Publication SOP — Facebook

- Use the publisher's selected Facebook Page/account and persisted schedule.
- Publication copy comes from the creative package.
- The schedule is editable in the Publisher UI.
- Changing publication time must reschedule eligible pending stock/publication records without regenerating video.
- Generation and publishing are separate concerns: pausing generation must not disable already-authorized publishing.

---

# 7. Stock / existing-video recovery SOP

When the correct video already exists:
- never regenerate solely because local retrieval failed;
- recover the existing asset if correlation can be proven;
- otherwise provide an operator upload/import route.

Manual import requirements:
- operator selects episode;
- MP4 is validated;
- existing active publication for that episode is checked;
- video is attached to the correct creative package;
- title/description/schedule remain publisher-generated metadata;
- no new Flow generation occurs.

---

# 8. Daily generation accounting SOP

The UI counter must describe reality, not only one transient database state.

Count evidence may include:
- generation ledger rows;
- retained review/stock/published media;
- approved publication rows;
- immutable confirmed automatic-start ledger.

Critical rule: a reset must never reduce the number of automatic credits already spent today.

If actual generated count is >= target:
- remaining = 0;
- scheduler must not submit another automatic Flow request.

---

# 9. Branding / iOS app icon SOP

Specialist 50-check audit: `docs/sops/IOS_APP_ICON_FULL_BLEED.md`.

Core invariant:
**The PNG delivered to iOS must itself be a finished square app icon.**
It must not be a small logo placed inside a second white square.

Required:
- 180x180 PNG for `apple-touch-icon`;
- opaque pixels to all four outer edges;
- no transparent outer margin;
- no white outer margin unless white is intentionally the brand background;
- artwork scaled as large as safely possible;
- background fills the entire square;
- iOS performs rounded-corner masking; the asset should not contain a second rounded white card;
- use a new concrete filename to defeat aggressive iOS icon caching;
- point `apple-touch-icon`, `apple-touch-icon-precomposed`, favicon/manifest as appropriate to the known-good asset;
- after changing the icon, remove and recreate the Home Screen shortcut when validating.

Never judge success from the logo on the webpage. Validate the actual icon endpoint/file.

---

# 10. Deployment SOP

A repository commit is not a production deployment.

Required chain:
1. commit source;
2. wait for runtime image workflow;
3. confirm workflow success;
4. make Railway use the newly built image if necessary;
5. trigger redeploy;
6. wait for deployment SUCCESS;
7. query production health/endpoint;
8. inspect the actual UI behavior;
9. verify no generation/publishing side effect was introduced.

If a workflow is still "in_progress", do not tell the operator the production fix is already live.

---

# 11. UI / responsive SOP

Every Publisher feature intended for operator use must work on:
- desktop;
- iPad/tablet;
- iPhone/mobile.

Do not add controls that are technically present but hidden below inaccessible layout, clipped, overlapped, or only visible on one breakpoint.

When a UI change appears missing:
1. verify production HTML actually contains it;
2. verify deployment version;
3. eliminate stale HTML caching;
4. then debug CSS/layout.

---

# 12. Emergency production SOP

When the operator says stop generation / credits are being wasted:
1. block generation submission first;
2. verify the block in production;
3. only then continue debugging unrelated issues;
4. preserve publishing if requested;
5. use existing assets for testing;
6. do not clear the block until the requested time/condition.

---

# 13. Inheritance rule for Publisher Factory

Every newly created publisher must inherit the shared-runtime SOP guarantees, including:
- package-before-generation;
- fresh-output correlation;
- no duplicate output reuse;
- AI feedback interpretation;
- configurable schedule;
- daily accounting that cannot reopen spent slots;
- existing-video recovery;
- responsive UI;
- full-bleed app icon/PWA asset rules;
- production verification before declaring success.

When a shared behavior is improved, audit existing publishers for missing inheritance. Do not rewrite working publisher-specific creative canon.

---

# 14. Change log protocol

Append a dated note after each newly verified class of fix:
- date/time;
- publisher(s);
- symptom;
- root cause;
- fix;
- verification;
- inheritance impact.

This log is an operational memory. It exists so the same failure is not debugged from zero twice.


## 2026-09-25 — Dinnie iOS icon / repeat-work prevention

**Symptom:** iOS Share/Add-to-Home-Screen kept showing Dinnie's artwork as a tiny mark inside a white rounded square even after the visible webpage logo looked correct.

**Root causes isolated:**
- multiple icon sources existed at once (HTML touch icon, legacy `/apple-touch-icon.png`, manifest icons, branding config URLs, favicon routes);
- some paths still passed through dynamic resizing/compositing while others served a static asset;
- changing only a query string was not a sufficient cache-busting strategy for iOS;
- visual inspection of the webpage logo was incorrectly treated as evidence about the actual iOS icon;
- the fix was being iterated without first converging every consumer onto one concrete known-good asset.

**Verified fix pattern:**
1. Use one concrete 180x180 full-bleed PNG with opaque green to every outer edge.
2. Serve that exact asset at a brand-new concrete filename (`/apple-touch-icon-dinnie-v2.png`).
3. Point `apple-touch-icon`, `apple-touch-icon-precomposed`, favicon/manifest and Publisher branding icon URLs to the same asset/derived copies.
4. Route the legacy Dinnie icon endpoints to that same static source so no consumer can fall back to a padded variant.
5. Serve with `Cache-Control: no-store` while validating.
6. Verify production endpoint status, MIME type and byte identity across legacy/current paths.
7. Do not call the Home Screen result proven until iOS itself displays the recreated shortcut correctly.

**Production evidence after deploy:**
- `/apple-touch-icon-dinnie-v2.png`: HTTP 200, `image/png`, no-store.
- legacy `/apple-touch-icon.png`: same ETag and same content length as the v2 icon.
- generation remained `GENERATION_PAUSED` with 0 remaining today during branding work.

**Inheritance:** all future publishers must use the full-bleed icon SOP and one-source icon convergence instead of independent favicon/touch/manifest pipelines.
