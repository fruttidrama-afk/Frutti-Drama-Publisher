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

# 5. Publication SOP — YouTube (operator-corrected 2026-11-02)

**Mandatory for FruttiDrama and EARTH IN 10 and inherited by future YouTube publishers:**

1. Explicit human APPROVE is required. The video remains in private Publisher-controlled Stock before its publication day.
2. **12:30 PM America/Argentina/Buenos_Aires on the assigned publication date:** upload exactly one approved video as **PRIVATE** via YouTube `videos.insert`, with its final title, description and native AI disclosure. Persist the remote video ID.
3. **7:00 PM on that very same assigned date:** return to the SAME YouTube video ID, verify the connected channel and observed PRIVATE status, then explicitly change its privacy to **PUBLIC** using YouTube `videos.update`. Verify the remote PUBLIC state.
4. **NEVER** upload directly PUBLIC at 19:00; **NEVER** use YouTube `publishAt` or native scheduling; **NEVER** upload any video to YouTube on earlier days as advance PRIVATE staging.
5. There is at most one publication per publisher per local day. Do not compensate for missed days by bulk uploads or rapid consecutive releases.
6. A 12:30 upload and a 19:00 release are **distinct remote mutation boundaries**. Reserve each durably before making the request; at timeouts, network failures or unknown responses, inspect YouTube's real state before considering any retry. Never initialize a fresh upload for the same item/day following an ambiguous result.
7. Keep all original video assets and identifiers. Repair or reconcile a legacy PRIVATE video in place; never create a duplicate.
8. The operator can change publication times in the Publisher UI; the runtime must adjust the lead window consistently rather than silently violating the two-stage workflow. The default for these two publishers remains 12:30 and 19:00 ART.

Required invariants:
- `privacy_before_publish = private`;
- `upload_lead_minutes = 390` (12:30 → 19:00);
- `release_mode = same_day_private_to_public_api_update`;
- `use_publish_at = false`;
- `preserve_private_lead_window = true`.

**Antispam rule shared with generation:** a scheduled obligation, runner claim or health probe is NOT a real external action. Never make the system mistake a retryable worker/credit-read error for permission to click Generate or send another upload. A submitted or ambiguous action is treated as potentially accepted until positively reconciled.
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

The canonical runtime architecture must not depend on Railway or any expiring free trial. The active target is the provider-replaceable **Free Runtime**: Supabase Free for durable control/state/media plus public GitHub Actions for ephemeral execution.

Required chain:
1. commit source;
2. wait for validation workflow;
3. confirm validation success;
4. confirm the Supabase Edge control plane is active;
5. confirm the scheduled GitHub worker can authenticate with GitHub OIDC without stored runner secrets;
6. confirm the publisher has a durable state snapshot and authenticated Flow profile snapshot;
7. run one targeted Golden Test obligation;
8. verify Review/Stock/publication state remotely;
9. enable unattended obligations only after the Golden Test passes;
10. verify no generation/publishing side effect was introduced.

If a workflow is still `in_progress`, if migration state is not `ready`, or if the Golden Test has not passed, do not tell the operator the publisher is autonomous.

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

---

# 15. Mandatory native AI disclosure SOP

**Global invariant:** every AI-generated video published by any Publisher must use the destination platform's native AI/synthetic-media disclosure whenever that platform exposes one. This is mandatory for every show, every video, every existing Publisher and every Publisher created later by Publisher Factory.

Required behavior:
- `publication.ai_disclosure_required` is always `true`;
- every configured publication provider must declare `contains_synthetic_media:true`;
- YouTube uploads/updates must set `status.containsSyntheticMedia=true`;
- Facebook Reel finalization must set `is_ai_generated=true`;
- a provider integration is not production-complete until the runtime can prove the native disclosure was requested and, where the provider exposes readable state, verify it remotely;
- disclosure is not a user-facing optional toggle and must not depend on title, caption, niche, realism, or creative style;
- adding “AI” text to a caption is not a substitute for the platform-native disclosure;
- a future platform without an implemented native disclosure mapping must fail the publication contract rather than silently publish unlabeled AI media.

Legacy repair:
- existing YouTube videos with known video IDs are audited and updated in place with `containsSyntheticMedia=true`;
- existing Facebook Reels with known video IDs are audited for `is_ai_generated`; when Meta allows the field to be updated after publication, update the same Reel in place and verify it without re-uploading;
- if a platform does not permit a post-publication disclosure retrofit, preserve the already-public item and surface a specific operator action; never create a duplicate merely to repair the label unless the operator explicitly authorizes replacement.

Observability:
- publication rows persist `aiDisclosureSyncedAt`;
- health/publication diagnostics expose whether disclosure has been synchronized;
- runtime safety exposes `native_ai_disclosure_required=true`, `youtube_contains_synthetic_media_always=true`, `facebook_is_ai_generated_always=true`, and `legacy_ai_disclosure_repair_enabled=true`.

Publisher Factory inheritance:
- schema requires the invariant;
- Factory creation defaults enable it;
- deployment normalization re-enables it even for older configs;
- contract/self-tests fail if either YouTube or Facebook native disclosure support disappears.

**Invariant:** PUBLICATION SUCCESS IS NOT COMPLETE WITHOUT THE PLATFORM-NATIVE AI DISCLOSURE.


---

# 16. Free-no-expiry infrastructure policy — 2026-10-06

**Non-negotiable invariant:** Publisher Factory must not use infrastructure whose normal free operation ends automatically after a trial period, promotional credit period, or mandatory paid upgrade.

Railway is retired from the canonical architecture because the deployed publishers became unavailable when its trial expired. Existing Railway identifiers/volumes may be used only as migration evidence; Railway must never be selected as an automatic fallback.

## Active Free Runtime

Current deployable control plane:
- **Supabase Free**: durable publisher registry, daily obligation ledger, private runtime-state storage and Edge control endpoint;
- **GitHub Actions on the public runtime repository**: ephemeral Chromium/FreeBrowserProvider execution;
- **GitHub OIDC**: secretless runner authentication to the Supabase Edge control plane;
- Publisher web UI remains static/provider-independent.

The earlier Cloudflare Workers/D1/R2 implementation remains an optional replaceable adapter, not a dependency. Business state must be portable so another free provider can replace Supabase if its plan changes later.

## Durable obligation contract

For every enabled publisher and every local calendar day:
- create exactly 3 generation obligations by default;
- create exactly 1 publication obligation by default;
- generation and publication obligations are independent;
- only one mutable publisher-state job may run at a time;
- a job is leased, persisted and reconciled after crashes;
- a timeout after a Flow submit is **reconciliation-only** and never authorizes a duplicate submit;
- historical missed obligations remain visible as debt; they do not automatically increase today's Google Flow generation target or spend paid monthly credits.

The automatic Flow batch remains capped by the daily free-credit refresh. Only the explicit human **Generate Extra** action may raise the daily target.

## State/media contract

The runtime may be ephemeral, but state may not be:
- SQLite/runtime state is snapshotted between runs;
- the authenticated Flow browser profile is snapshotted separately;
- private snapshots must never be exposed through a public bucket;
- Review originals remain approval-gated;
- approved Stock is durable independently of the runner;
- the next run restores state before doing any external action.

## Authentication contract

GitHub Actions must authenticate to the control plane using GitHub OIDC bound to:
- repository `fruttidrama-afk/Frutti-Drama-Publisher`;
- branch `main`;
- the canonical Free Runtime workflow;
- a dedicated audience.

Do not place long-lived Supabase service-role keys, Google cookies or publication access tokens in a public repository or workflow input.

## Migration gate

A publisher cannot be marked `enabled`/autonomous until:
1. its creative/runtime config is present;
2. durable state has been imported or safely reconstructed;
3. an authenticated Flow profile is present;
4. exactly-once recovery state is reconciled;
5. one generation Golden Test reaches Review without duplicate submit;
6. one publication Golden Test confirms the remote platform result;
7. the scheduled worker passes at least one unattended cycle.

## Acceptance test

The business-health test is outcome-based, not process-based:

If the operator does not open a publisher for 10 days, then—assuming the platform accounts remain authenticated, daily Flow free credits arrive, and enough approved Stock exists—the publisher must show:
- **30 new Review-ready videos** (3 × 10);
- **10 confirmed publications** (1 × 10);
- zero duplicate submissions;
- zero rejected videos published;
- zero need to keep a browser/panel/chat open.

A green heartbeat without those outcomes is not automation health.

## Free runtime durability rules — 2026-10-09

These rules are mandatory for every existing and future Publisher that uses the free Supabase + GitHub Actions runtime.

1. **A refreshed Flow profile must never demote a runnable Publisher.** Browser/profile uploads are runtime-state refreshes, not migration resets. If an enabled Publisher is already `ready`, `auth_verified`, or `profile_uploaded`, a successful profile refresh must preserve/promote it to `ready`. The scheduler must accept verified uploaded profiles and self-promote them to `ready` before claiming work. Symptom to prevent: pending obligations plus repeated scheduler logs saying `No durable obligation is due.`

2. **Daily free Flow-credit exhaustion is a cooldown, not a terminal daily failure.** `WAITING_DAILY_FLOW_CREDIT_REFRESH` must never permanently close the day's production merely because credits were absent at local midnight. Keep the batch protected from paid-credit use, but re-probe Flow at a bounded cadence (default: no more than once every 30 minutes). When the free daily credit grant becomes available, reopen the remaining blocked generation obligations and continue the normal daily target automatically.

3. **Paid credits remain forbidden for unattended production.** Credit-refresh probes may inspect the current Flow state but may not authorize or consume paid/monthly credits. Automatic production only resumes when the daily free-credit gate is positively available.

4. **Persistent media paths must be portable.** Any restored `state.tgz` may contain paths from a previous ephemeral runner. Before review/publication/generation metrics are evaluated, rebase persisted media paths by basename into the current restored runtime directories and persist the corrected paths back into durable state.

5. **GitHub scheduled automation requires inactivity protection.** The public free-runtime repository must contain a low-frequency keepalive workflow that creates real repository activity at least weekly so scheduled workflows are not silently disabled after extended repository inactivity. The keepalive must not touch production state or trigger generation/publication itself.

6. **Golden verification requires state evidence, not only a green workflow.** A successful scheduler run is insufficient if no obligation was claimed. Verify the tuple: Publisher `enabled=true`, migration state runnable, obligation transitions `pending -> claimed -> running -> completed/blocked-with-known-cause`, durable state re-uploaded, and no unintended paid-credit consumption.



## FruttiDrama · titulado y descripción basados en trama real (2026-10-13)

Este procedimiento se aplica a la **recapitulación temporal de FruttiDrama** y a cualquier futura implementación que reutilice la generación de metadatos de FruttiDrama. No modificar los estilos de Dinnie ni de Earth.

1. Para una generación reconstruida, el prompt confirmado que pega la operadora es la fuente documental. **No usar** los prompts históricos compilados de Prompt Studio ni su mapeo hipotético.
2. Del prompt completo, **extraer el bloque argumental del episodio** (`EPISODE`, `EPISODIO`, `TRAMA`, `PLOT`, `EPISODE INTENT`, escenas o beats expresos). Excluir canon previo, instrucciones de cámara, audio, referencias visuales, continuidad genérica, restricciones técnicas y reglas antiglitch.
3. La estructura del título se conserva: **DOS PRIMERAS PALABRAS EN MAYÚSCULAS: [suceso concreto de ese video]**. El suceso debe nombrar personajes y/o acciones reconocibles. Prohibido usar como resultado final “DRAMA FAMILIAR: una nueva crisis golpea a la familia”, “GIRO IMPACTANTE: lo cambia todo” u otros metadatos vacíos.
4. La **descripción no es el prompt**. Es un párrafo original, melodramático y específico: qué personaje actuó, contra quién, qué reveló o decidió y qué conflicto se abrió. Cerrar con una pregunta conectada a **ese** acontecimiento, luego `#Shorts #ViralShorts #FruttiDrama`. No incluir instrucciones de estilo, “one continuous scene”, “unbroken take”, 9:16 ni otras órdenes de producción.
5. Si la narrativa no puede extraerse con suficiente confianza, **fallar sin contenido** y dejar edición manual, no inventar personajes, diagnósticos, relaciones o giros. Una mención en `CANON` sobre Banana o Mango no prueba que ese sea el suceso del video nuevo.
6. **PROCEDIMIENTO VIGENTE, confirmado por la operadora:** restaurar el mecanismo editorial histórico `hook + story → título + descripción` de FruttiDrama, usando el bloque de trama del prompt REAL aportado manualmente. En la recapitulación se ejecuta el módulo local `supabase/functions/publisher-frutti-recap/frutti-recap-copy.js`, SIN IA externa, claves, OpenRouter, Gemini, DeepSeek, Qwen ni ningún proveedor que cobre o limite solicitudes. Formato: dos primeras palabras MAYÚSCULAS + dos puntos + hecho del episodio; descripción original narrada que cuenta acciones, personajes, consecuencias, pregunta final y hashtags. Está PROHIBIDO copiar fragmentos de instrucciones técnicas, tomar hechos del canon histórico como si pasaran ahora, asignar videos por prompts antiguos, o reemplazar la narrativa por frases vacías. Cuando el prompt carezca de suficiente acción, solicitar edición manual conservando el prompt, sin inventar. Los campos editables y el guardado del stock reconstruido permanecen protegidos, ajenos a publicación.

7. Mantener el set de pruebas `scripts/test-frutti-copy.mjs` ejecutado por el smoke workflow. Los casos cubren aislamiento de CANON y de texto técnico, dos primeras palabras en mayúsculas, longitud del título, narración específica, pregunta final y hashtags. Nuevo incidente de metadata exige agregar fixture de regresión representativa antes de cerrar.

8. **Postmortem 2026-10-13, STORY_NOT_FOUND:** el sistema histórico no leía un prompt entero para inventar metadatos: utilizaba los datos estructurados `hook` y `story` antes de construir Google Flow. El recap interpretaba incorrectamente el prompt completo con un parser que exigía encabezados `STORY`/`EPISODE`, descartaba párrafos con texto técnico y confundía encabezados `SCENE 1: acción` con líneas vacías; además algunas reglas ignoraban reacciones y turnos de habla en el mismo párrafo. Corregir sin tocar el publishing: extraer escenas, intervenciones y acciones de texto natural; usar una frase `operator_story` opcional solo cuando falte estructura; mantener la copia íntegra de `generation_prompt` inalterada y jamás reemplazarla por ese resumen. Regresión obligatoria con prompts sin encabezados, SCENE 1 inline, múltiples hechos, diálogos, CANON aislado, gramática y relación entre sujeto/objeto. El fallback aparece solamente si el generador no pudo identificar una acción, y sigue siendo editable.

9. **Regresión de tres personajes 2026-10-13:** ante un prompt donde Fresia interrumpe o descubre una conversación/encuentro entre Uva y Limón, no reducir el acontecimiento a "Fresia interrumpe a Uva" ni redactar "una conversación de Uva". Detectar **actor que irrumpe** y **las dos personas que estaban conversando**, con contexto romántico solo si es explícito en la acción actual (no en CANON, constraints o fichas). El evento completo y las reacciones constituyen un micro-relato: título con dos primeras palabras MAYÚSCULAS y una acción específica de los tres personajes; descripción original con contexto, hecho, consecuencia y pregunta dramática. Comprobar 100 caracteres máximos en título, límite conservador de 4000 caracteres en descripción y hashtags de YouTube #Shorts #ViralShorts #FruttiDrama. Mantener `scripts/test-frutti-copy.mjs` con casos de interrupción romántica de tres personajes, una sola frase, conversación NO romántica y persona ausente solo en canon. La función de recap no publica nada y solo propone texto editable.


---

## Protocolo permanente de peritaje y operación desde iPad — 2026-11-09

Regla expresa de la operadora, vigente para Publisher Factory, FruttiDrama, EARTH IN 10, Dinnie y futuros publishers:

1. Presuponer que toda interacción humana necesaria se efectuará exclusivamente desde un iPad. Toda operación obligatoria debe poder hacerse con Safari o una aplicación de iPad con enlaces directos, controles táctiles, teclado en pantalla, inicio de sesión/2FA y sin terminal, CLI, PC ni arrastrar archivos desde un escritorio. Si un flujo todavía no es viable en iPad, es un defecto del producto que debe resolverse técnicamente antes de pedirle a la operadora que lo ejecute.
2. Ante solicitudes de peritaje, realizar primero la verificación real de GitHub Actions, Supabase, Storage, flujos de autenticación, Review/Stock, publicaciones, idempotencia y disponibilidad de alta de canales. Separar evidencia verificada, hipótesis, pruebas de código y producción efectiva. No presentar como exitosas automatizaciones que solo inician workflows.
3. Formato OBLIGATORIO de respuesta: (a) dictamen ejecutivo y fecha de corte; (b) estado comprobado por publisher y por subsistema; (c) problemas y riesgos priorizados con pruebas; (d) plan técnico de reparación con dependencias y validación; (e) SOLO AL FINAL, una sección única de intervenciones humanas efectivamente necesarias, con links directos y pasos detallados desde iPad en el orden correcto. No intercalar pedidos a la operadora en secciones anteriores.
4. Las cuentas, contraseñas, códigos MFA, cookies, tokens y enlaces temporales se introducen únicamente en las interfaces autorizadas, nunca en respuestas, logs o chats. No solicitar pagos, upgrades ni TinyFish.
5. No disparar Generate, uploads de videos privados, publicaciones, REDO, acciones destructivas, ni sesiones cortas con vencimiento para una futura intervención humana sin una razón y preparación concreta. Preferir auditar sin mutaciones y conservar estado histórico.
6. Cuando una intervención requiere una sesión temporal de 55 minutos, coordinarla para cuando la operadora ya esté lista en el iPad; no asumir que sesiones de días anteriores siguen vigentes. Los botones y acciones de Factory deben incluir estado real, expiración, errores y posibilidad de reintentar la apertura de la sesión sin crear generaciones ni publicaciones.


## Conexión Google Flow desde iPad — inicio autónomo protegido (implementación 2026-11-09)

La operadora no debe depender de un mensaje a ChatGPT ni de manejar GitHub manualmente para solicitar la sesión de Google Flow. En cada Publisher integrado, en la tarjeta **Google Flow · reconexión segura**, el botón **INICIAR RECONEXIÓN DESDE ESTE IPAD** llama `publisher-flow-operator` autenticada con JWT de Supabase y propietario exacto. Encola `requested` en `publisher_runtime_bootstrap_sessions` para UNO de los tres publishers. Las otras cuentas jamás deben abrirse por arrastre.

La cola está protegida por la propiedad de la cuenta, y las solicitudes duplicadas reciben su estado original sin crear otro runner. El tiempo inicial de cola es 90 minutos y el ritmo de reinicio se limita. El observador `.github/workflows/flow-reconnect-on-demand.yml` consulta esa cola sin abrir navegador ni generar videos, mediante GitHub OIDC, y solo cuando existe una solicitud real despacha el workflow V2 aislado de ese publisher con `GITHUB_TOKEN` limitado a `actions:write`. El Free Runtime Scheduler también puede consultar la cola con el mismo mecanismo como respaldo. GitHub Actions puede retrasar los cron; jamás prometer un plazo exacto de inicio de sesión.

Cada workflow Bootstrap V2 necesita antes de instalar navegador un `/authorize/<show>` OIDC con identidad del workflow correcto, solicitud del propietario en estado `launching` y plazo vigente; jamás iniciar una reconexión en un push, reintento o `workflow_dispatch` no autorizado. La sesión se anuncia como `waiting_for_google_login` durante 55 minutos; el URL/noVNC password solo los devuelve el endpoint al propietario autenticado. La tarjeta consulta estado cada 12 segundos cuando está en cola y cambia a enlace de Safari + botón de copiar contraseña + botón de confirmar captura. La captura verifica el proyecto exacto y archiva el estado de Flow. NUNCA compartir contraseñas/tokens en el chat o GitHub Actions.

Este proceso es exclusivamente de **reconexión de Google Flow**: NO genera MP4, NO gasta créditos, NO aprueba Review, NO publica en YouTube ni Facebook. La reconexión `auth_verified` no basta para declarar el canal autónomo; después se realizan los Golden Tests con aprobación humana y las garantías antispam del SOP.

**Validación del despliegue:** Edge `publisher-flow-operator` v3 y `publisher-flow-account-bootstrap-v2` v8 ACTIVE, Factory GitHub Pages desplegado y UI Smoke Test pasó. El observador de solicitudes `Flow Reconnect On Demand` ejecución 42703248443 verificó por OIDC los tres estados `idle` y terminó `success` sin abrir sesiones. El caso con una solicitud genuina solo puede comprobarse después de que la operadora toque el botón desde el iPad; no inventar que se verificó la captura real.


---

## Google Flow: persistencia de sesión verificada — 2026-11-09

Objetivo: una autenticación humana por cuenta reutilizable a través de ejecuciones efímeras, reinicios de GitHub Actions y redeploys. No prometer caducidad infinita: Google puede revocar la sesión, exigir MFA y hacer comprobaciones de riesgo. No usar contraseñas guardadas, saltarse controles Google ni copiar tokens a artefactos públicos.

1. **Captura de la sesión después de iniciar sesión.** El bootstrap V2 abre Chrome aislado por canal en el escritorio remoto noVNC del iPad. La operadora debe pulsar explícitamente **YA ENTRÉ A GOOGLE FLOW · VALIDAR Y GUARDAR SESIÓN**; una URL que contiene el proyecto no se considera consentimiento ni prueba de autenticación. Capturar el proyecto ID exacto y comprobar URL y cookies de la cuenta Google sin imprimir valores.
2. **Estado persistente doble y privado.** Archivar la carpeta Chrome `flow-profile/` que contiene Cookies, almacenamiento local, IndexedDB y estado del dispositivo; en paralelo exportar `flow-auth-state.json` de Playwright usando `storageState({indexedDB:true})`. Cerrar Chrome antes de archivar para no copiar las bases de datos bloqueadas. Excluir únicamente caches/archivos transitorios; NO excluir Cookies ni IndexedDB. Si el perfil supera el límite de 40MiB, usar la alternativa portable *verificada*.
3. **Almacenamiento durable privado.** Cada publisher guarda `profile.tgz` en `publisher-runtime-state/<publisher_id>/`. Solo el flujo OIDC de GitHub con identidad de workflow autorizada y el rol de servicio de Supabase acceden a estos bytes. JAMÁS dar acceso público, registrar cookies/tokens, ni guardar el perfil en GitHub, textos de SOP, screenshots o diagnósticos.
4. **Restauración verificable antes de cada producción.** En un runner nuevo, desarchivar el perfil del publisher correcto y abrir el proyecto Flow esperado *sin pulsar Generate*. Comprobar que no redirige al login y que existe sesión Google válida. Si falla, detener la producción sin gastar créditos, conservar la copia buena y marcar error de autenticación; no relanzar Google login múltiples veces.
5. **Refresh solo de estado válido.** Al inicio y al final de cada ejecución autorizada, exportar un candidato con `indexedDB:true`, comprobar cookies/estructura/proyecto, y sustituir atómicamente la copia local. Solo entonces subir un perfil recortado de cachés. Un navegador que haya quedado deslogueado o una operación de red ambigua nunca debe sobrescribir el perfil privado existente.
6. **Separación estricta de cuentas.** FruttiDrama, EARTH IN 10 y Dinnie mantienen perfiles, estado, ID de proyecto y autenticaciones aislados; no mezclar cookies. Reconciliar autenticaciones nuevas con el canal exacto, no sólo con un URL.
7. **Pruebas antes de declarar persistencia operativa.** El CI no interactivo debe verificar sintaxis y reglas antidegradación. Después de una sola autorización humana, restaurar el perfil en un runner completamente nuevo, abrir Flow en lectura y validar que mantiene autenticación; repetir tras reinicio y en días posteriores. El estado `auth_verified` del bootstrap no es por sí solo prueba de sesión duradera.
8. **Límites honestos.** Playwright documenta que cookies/localStorage/IndexedDB pueden guardarse y restaurarse, pero que los estados expiran. Google explica que las cookies y las comprobaciones de seguridad afectan la permanencia de la sesión. **No existe un mecanismo legítimo que garantice por siempre una sesión de Google Flow sin posibilidad de nueva validación humana.** El objetivo es reducir las reautenticaciones al mínimo inevitable y detectar el problema sin destruir el estado anterior.

Cambios 2026-11-09: `free-browser-provider.js` preserva IndexedDB y actualiza snapshots atómicamente; `scripts/free-runtime-runner-v2.mjs` incorpora preflight de cuenta/proyecto y no reemplaza un perfil si falla el refresh; `scripts/bootstrap-flow-account-v2.mjs` valida cookies y exige confirmación humana; `scripts/run-flow-account-bootstrap-v2.sh` cierra Chrome antes de empacar; `scripts/check-flow-auth-persistence.mjs` añade invariantes. CI `Unified Publisher Factory UI Smoke Test` run 42705892399 terminó en SUCCESS. Verificar autenticación real cold-restore solo después de que la operadora concluya la actual sesión de Flow.


---

## SOP iPad — desplazamiento táctil en controlador Google Flow (2026-11-09)

**Problema comprobado por operadora:** Safari/iPad dentro de noVNC transforma el gesto tradicional de un dedo en eventos de ratón del navegador Chrome remoto, no en scroll del contenido. **Nunca pedirle que use un PC, un mouse físico o que repita autenticación por este defecto.** noVNC actual admite gestos de dos dedos; el nuevo controlador agrega explícitamente un modo de un dedo.

**Corrección persistente:** `scripts/novnc-ipad-touch.mjs` se instala dentro de `/usr/share/novnc/app/` antes de abrir cada túnel mediante `scripts/install-novnc-ipad-touch.mjs` invocado por `scripts/run-flow-account-bootstrap-v2.sh`. El panel flotante ofrece `☝️ DESLIZAR` (activa superficie táctil y convierte gestos verticales de un dedo a WheelEvent que el RFB ya procesa), `▲ SUBIR` y `▼ BAJAR` (respaldo PageUp/PageDown usando `UI.rfb.sendKey`). Al desactivar `DESLIZAR`, se restablecen los taps/clicks normales. No recoge credenciales, no toca Flow ni ejecuta Generate.

**Sesiones ya abiertas:** modificar el código de GitHub NO cambia el JavaScript de un runner efímero que ya hizo checkout; NO reiniciar una sesión mientras la operadora está iniciando sesión. Para FruttiDrama, si ya inició sesión Google y quedó en el selector de proyectos, NO necesita desplazarlo: pulsar el botón de Factory `YA ENTRÉ A GOOGLE FLOW · VALIDAR Y GUARDAR SESIÓN` hace que `capture()` abra automáticamente el proyecto canónico `705d7ac2-30fe-4481-aa4c-076c31a64214`, verifique su identidad y archive el perfil, sin recorrer el listado manualmente. Para desplazarse en la sesión existente, probar gesto de **dos dedos** en el área remota, no arrastre de un dedo. Si requiere navegación directa, escribir el URL del proyecto en la barra del Chrome remoto, nunca en el Safari local, preservando la sesión.

**Validación:** CI `Unified Publisher Factory UI Smoke Test` ejecución 42708773691 = success, pruebas sintácticas y de presencia de eventos táctiles/botones. No se ha ejecutado una prueba táctil física con iPad en una sesión nueva; verificar gesto, botones, login, captura y persistencia con la siguiente sesión genuina. La sesión activa de FruttiDrama del 9 nov (runner creado a las 21:42Z) conserva el noVNC anterior; no reiniciarla por este fix.


---

## Incidente resuelto — estado de captura Flow no visible en iPad (2026-11-09)

**Síntoma:** tras tocar `YA ENTRÉ A GOOGLE FLOW · VALIDAR Y GUARDAR SESIÓN`, Factory mostraba `Captura solicitada. Tocá ACTUALIZAR`; al refrescar reiniciaba visualmente el panel y no informaba éxito. En Frutti, pese a eso, el backend confirmó `migration_state=auth_verified`, sesión `completed` a las 2026-11-09T22:15:00Z, perfil privado subido y workflow 42704908110 `success`. La consola mostró `FLOW_ACCOUNT_CAPTURED frutti 705d7ac2-30fe-4481-aa4c-076c31a64214` y `FLOW_ACCOUNT_BOOTSTRAP_COMPLETE`. NO pedir otra autenticación al usuario si estos comprobantes existen.

**Causa y corrección:** el cliente mostraba solo la aceptación de `capture_requested`, no consultaba el estado nuevamente hasta otro click, y el endpoint `publisher-flow-operator` trataba una captura `completed` como `expired` al vencer el enlace remoto de 55 minutos. Edge v4 ahora prioriza éxito real `session.status=completed` + `publisher.migration_state=auth_verified|ready`, devuelve `auth_saved` y `auth_saved_at`, NO entrega contraseña ni enlace luego de completar. UIs `docs/index.html` y `factory-web/public/index.html` muestran explícitamente `✓ GOOGLE FLOW · AUTENTICACIÓN GUARDADA CORRECTAMENTE`, fecha y nota de que el restablecimiento cold-restore es pendiente, y NO sugieren reconectar. El botón de confirmación activa polling de cinco segundos sin que la operadora presione ACTUALIZAR. `#udRefresh` restaura scroll en vez de sacar a la operadora de la zona actual. `#udStatus` muestra `GOOGLE FLOW AUTENTICADO · PRODUCCIÓN AÚN NO VERIFICADA` para no confundir credenciales con generación/publicación.

**Caveat crítico:** el Chrome profile archivado tenía 66.882.255 bytes, excedió el límite Edge y se archivó únicamente el Playwright storageState portátil en `profile.tgz` de 3.471 bytes. Este artefacto se guardó exitosamente, pero **no demuestra que vaya a restaurar Google en otro runner**. Antes de declarar reautenticación realmente solucionada, efectuar preflight de restauración de Google exacto y en modo lectura, sin Generate, y verificar sesiones duraderas. Si falla, mejorar backup multipart de perfil completo sin perder el estado portátil ni obligar a repetir el login innecesariamente.

**Seguridad:** nunca mostrar URL ni contraseña temporal del VNC tras cierre; no registrar tokens. Todas las verificaciones de credenciales deben ocurrir por la API protegida por propietario. Validación del cliente: GitHub Actions `Unified Publisher Factory UI Smoke Test` 42710953375 SUCCESS. El despliegue Pages correspondiente debe verificarse antes de pedir recarga de Safari.
