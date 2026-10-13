# FruttiDrama — provenance audit of Prompt Studio, actual Flow prompts and recovered media
**Date:** 2026-10-12 (UTC). **Mode:** read-only/no spending. **Do not publish, generate, approve, delete or relabel originals.**

## Sources examined

1. Legacy repo `fruttidrama-afk/FruttiDrama-Publisher/public/index.html`, page `#page-prompts`, defines `BUILTIN_SEASON_DATA` **Seasons 2–6, 25 beats each = 125 planned episodes**, and uses `compilePrompt(season,episode,beat)`. These prompts are dynamically **compiled** from the beat description, general cinematic/canon rules and a continuity template. They are not confirmed verbatim prompts used in Google Flow and have no fixed scripted dialogue for each beat. The manually added seasons and completion marks come from `GET /app/state` / `PUT /app/state`, persisted in **legacy Railway local file `/data/frutti-app-state.json`** (legacy `server.js`). No confirmed Supabase copy of that file exists in inspected objects.
2. Legacy repo `factory-flow.js` exposes `GET /factory/:id/prompt` reading `factory_items.prompt` and `promptHash` directly from historical SQLite. Old Video Factory `public/factory-ui.js` renders **VER PROMPT COMPLETO** for a review card; this is the real generated-prompt provenance, but relies on the old volume database. The `factory_generations` table stores prompt HASH, not necessarily full prompt text.
3. New Supabase private object `publisher-runtime-state/7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7/state.tgz` was read and inspected via signed GitHub Actions OIDC read-only workflow `.github/workflows/frutti-state-audit.yml`; run `38322865569`, Oct 12 23:34 UTC. `factory_items`: exactly **15 season-3 rows**, E1–E6 status review and E7–E15 draft. **All 15 `prompt` fields EMPTY**, although story and hook are present. **No season-2 rows**. `factory_generations`: 6 entries / 6 distinct hashes. `publication_items`: 0 entries. The current archive does not contain original historical prompt text. A generation hash is not reconstructible into the full prompt. This is an incomplete migration, not proof the historical Railway database was deleted.
4. Supabase `publisher_runtime_publishers.config.content.initial_episodes` holds exactly 12 **Season 3 plot summaries** E1–E12; source-of-plot, NOT exact video generation prompts. The original historical plan of Prompt Studio can diverge sharply from actual produced season-2 canon: planned T2 E1 “HERENCIA OCULTA” yet the actually generated season-2 arc contains bananismo and Banana's death. Never treat a planned season/episode label from Prompt Studio as authoritative video provenance.
5. Existing private `publisher-review-videos/fruttidrama/review/` contains 31 MP4 with 31 distinct SHA-256 digests. Every MP4 has an offline `faster-whisper` Spanish transcript and 4-frame contact sheet under `publisher-runtime-state/media-forensics/pilot-20261012/{0..30}/`. The private forensic ledger, v1 and v2, lives in Supabase `publisher_factory_knowledge` with `active=false`.

## Cross-match obtained from preserved actual Season 3 plots (NOT full historical Flow prompts)

| File index, one-based | Candidate | Narrative evidence | Confidence | Blocker |
|---|---|---|---|---|
| 16 | T3E1 NUEVO COMIENZO | “Démonos una oportunidad. Empecemos de nuevo.” | High narrative | Distinct file 03 has same premise; T3E1 already in Review |
| 03 | T3E1 NUEVO COMIENZO | “Démonos una oportunidad” but next line “Uva ¿cómo pudiste?” is inconsistent | Low narrative | Two different archived SHA-256 MP4s + current Review, version conflict |
| 10 | T3E5 LÍMITE FINAL | “Criaremos a nuestro hijo juntos, pero no volveremos a ser pareja” | High narrative | T3E5 already in Review |
| 12 | T3E6 FRESIA CONTRAATACA | “Limón siempre estará unido a mí por nuestro hijo” / “la confianza se demuestra con hechos” | High narrative | T3E6 already in Review |

The previous five T2 candidates in `reconciliation-v1` remain **hypotheses**, not matches to verbatim generated prompts. In particular T2E7 has a historical YouTube public ID; T2E9 has a historical remote ID; the old Prompt Studio plots do not corroborate their dialogue.

**Current authoritative catalog:** `public.publisher_factory_knowledge` key `forensics/2026-10-12/fruttidrama/reconciliation-v2`, 31 files, 9 candidate identifications, ZERO final approved-stock/publication-ready items. Integrated UI `docs/index.html` and `factory-web/public/index.html` reads v2 via owner-authenticated Supabase Edge `publisher-unified-read`. Collisions are visible to user, but there is no write or approval action.

## What is still unavailable / next safe recovery sources

- Exact old `factory_items.prompt` text and any older revisions in Railway `/data/frutti-factory/factory.sqlite` (may reside on historical volume).
- Custom seasons and marks, if any, in old `/data/frutti-app-state.json`.
- Any actual Flow project prompt history accessible after authenticated session reconnect; do not mistake drafts or planned template text for submitted prompt.
- Confirmation of remote YouTube published IDs vs byte-identical or visually identical archived media.
- Original approval/rejection history from legacy `publication_items`. No historical dates should be restored; future dates will be replanned.

**Zero-budget rule:** do NOT require a paid Railway subscription. Continue using reconstructed visual/dialogue comparisons and extant GitHub/Supabase evidence. If exact original prompt text is later recovered, preserve it in restricted storage with per-video evidence and do not override earlier revision data. Keep Season 3 E1–E6 current Review untouched. Never mark an MP4 approved/stock/published based solely on text likeness or a shared narrative beat.

## Supplemental verification: exact old Video Factory prompt endpoint, not a chat transcript

Direct review of `FruttiDrama-Publisher/factory-flow.js` shows that `startGeneration(row)` executes `makePrompt(row,chars)`, then `UPDATE factory_items SET prompt=?,promptHash=?,...` before asking Google Flow to generate. `GET /factory/:id/prompt` returns precisely that stored `factory_items.prompt`; the legacy Review UI `public/factory-ui.js` prints it in `VER PROMPT COMPLETO`. This **fully corroborates the operator's account**: neither user discussion nor manual prompt copy was required. The source is the historical Video Factory SQLite database. Distinguish it from a separately generated `Prompt Studio` template on the site's old `#page-prompts`.

**Crucial limitation:** That older `makePrompt` implementation instructs Flow to generate short Latin-American Spanish dialogue but does **not always prescribe verbatim lines**. Even a successfully recovered authentic prompt can identify the numbered *storyline* without containing the exact spoken dialogue. Use scene content and published video identity for final validation; do not claim string matching must succeed.

Additional October 12 Supabase scan: only three buckets (`publisher-branding`, `publisher-review-videos`, `publisher-runtime-state`); no other older SQLite/prompt-history object visible there, and public tables have no full prompt ledger. `publisher_runtime_publishers.migration_state='auth_reconnect_pending'` with previous profile-upload size failure, so authenticated read-only lookup of Google Flow's own prompt history requires resolving the Flow login/profile limitation first. Do not bypass authentication or reenable automatic generations.

**Zero-cost next legitimate routes**: first recover exact prompts from existing authenticated Google Flow project history by its built-in Reuse Prompt UI or supported read-only provider after owner authorization; otherwise legacy volume extraction only if access becomes available without payment. Meanwhile use video audio/frames and actual numbered story beats as *hypotheses*. Future generations must archive full final submitted prompt plus episode, revision, Flow video identity, hashes, approval decision and upload state to private Supabase transactionally.

## 2026-10-13 — operator matching UI now installed in Publisher Factory

Operator explicitly prefers identifying videos herself by choosing the matching numbered Prompt Studio episode while comparing dialogue and original MP4 playback, not through manual Google Flow exploration. Deployed:
- Exact legacy `compilePrompt`-derived full text of **125 Prompt Studio plans, seasons 2–6 x 25 each**, extracted unchanged from `fruttidrama-afk/FruttiDrama-Publisher/public/index.html` to `docs/data/frutti-prompt-studio-legacy.json` and `factory-web/public/data/frutti-prompt-studio-legacy.json` in main repo. These are source-faithful **Prompt Studio plans**, not proven historical generated `factory_items.prompt` records; maintain distinct provenance.
- Authenticated unified reader `publisher-unified-read` v7 projects short-lived private signed video MP4 and contact sheet links plus explicit user assignment rows. Video streaming is on user click only.
- Edge writer `publisher-forensic-match` v1 validates Supabase bearer user, owner of fixed FruttiDrama publisher id `7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7`, file index 0..30, expected full original SHA-256 in immutable `reconciliation-v2`, season 2..6, episode 1..25, note length <=700. Upserts only `publisher_forensic_episode_assignments`; no stock, publish, generation, or approval table writes. Direct anon/authenticated grants revoked; row-level security enabled. Clearing is null/null; multiple files may be assigned same season/episode to support alternate renders. This is **narrative identification only**.
- `docs/index.html` and `factory-web/public/index.html` show 31 signed-contact previews, MP4 playback, 125 full prompts searchable by season, controls per original to select, inspect complete prompt, save/clear assignment, and read prior saved assignments on refresh. Layout responsive. GitHub Actions `Unified Publisher Factory UI Smoke Test` run `38324969198` SUCCESS; GitHub Pages run `38324968252` SUCCESS. Real user-authenticated assignment has **not yet been verified by saving one in production**. Never claim otherwise.

Future operator check: open GitHub Pages owner authenticated → FruttiDrama → Recuperación histórica; expand Prompt Studio, play one video, select season/episode, read full prompt, tap GUARDAR IDENTIFICACIÓN, reload and confirm persisted. No manual selection ever authorizes a public upload. If client error occurs, diagnose without mutating historical files.

## 2026-10-13 — Separate temporary two-pane operator matching workbench

The user corrected the UX: the episode matching process must be a **dedicated temporary section**, not a long dashboard gallery mixing source videos and auto-suggested prompts. Implementation on both `docs/index.html` (GitHub Pages) and `factory-web/public/index.html`:

- FruttiDrama publisher has two navigation choices: **RESUMEN GENERAL** and **CONCILIACIÓN TEMPORAL · FRUTTIDRAMA**. `?publisher_id=7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7&mode=recovery` opens the independent reconciliation workspace.
- Wide screens show two **simultaneous independent scrolling windows**: **01 VIDEOS RECUPERADOS** (31 private signed previews, click-to-play originals, Spanish transcripts, manually chosen season/episode selectors, optional notes, button to read the chosen complete prompt, persistent save) and **02 PROMPTS DE LA HISTORIA** (all available historical Prompt Studio **season 2 and season 3** prompts one by one, separate episode cards, exact full text expandable inline or readable in modal, free-text search and season filter). Tablet/phone screens show the two panes as a segmented switch instead of tiny side-by-side columns.
- Only **50 loaded historical Prompt Studio prompts** are shown in this temporary workbench: `docs/data/frutti-prompt-studio-active.json` and matching `factory-web/public/data/frutti-prompt-studio-active.json`. The complete 125-prompt historical backup remains separately archived for provenance; future seasons 4–6 are **not listed or suggested** to the operator.
- Crucial: do **not automatically select or display candidate prompt IDs inferred by the model** on any video card. Only a manual saved assignment has a season/episode label. Operator judges the content herself, not the matching algorithm.
- Saved choices go through previously deployed protected owner-authenticated Supabase `publisher-forensic-match` v1, keyed by immutable SHA-256 and file index, to table `publisher_forensic_episode_assignments`; existing read model `publisher-unified-read` v7 loads their saved values. No effect on generated stock, approved Review, publication, schedules or original MP4s.
- GitHub Pages and both-host UI smoke runs were completed, but the very first **operator-authenticated production save+reload test is pending**. Never claim saving was end-to-end proven until that check.

## 2026-10-13 — TEMPORARY HUMAN MATCHING WORKSPACE (current UI contract)

By explicit operator direction, manual recovery is now a **separate temporary tab in FruttiDrama Publisher**, labelled `CONCILIACIÓN TEMPORAL · FRUTTIDRAMA`, rather than controls scattered through general status/review pages. Root URL deep-link `?publisher_id=7c359bd5-76b8-43b9-9d5c-cc8ca38d06e7&mode=recovery`.

Desktop shows **two independent windows side by side**: `01 · VIDEOS RECUPERADOS` lists all 31 Supabase-backed originals with per-file signed MP4 playback, original contact sheet, speech transcript, selectors for manual season/episode, optional note, and save; `02 · PROMPTS DE LA HISTORIA` shows individually browsable, searchable historic Prompt Studio prompts with all text visible on expansion / modal. Narrow-screen layout switches between VIDEO and PROMPTS with two buttons.

**Scope is strictly active seasons 2 and 3**: 50 numbered Prompt Studio texts, 25 for each, mirrored at `docs/data/frutti-prompt-studio-active.json` and `factory-web/public/data/frutti-prompt-studio-active.json`. The source-complete 125-prompt archive is preserved separately and NOT exposed by the temporary workspace. Never silently select a prompt for a video using model conjecture. Provisional AI candidates remain archived forensic evidence only, not user assignments. Each user save is subject to owner token validation, original file SHA-256 evidence match and Supabase `publisher_forensic_episode_assignments` persistence; it does not change review/stock/approval/publication records.

UI release: GitHub Pages run `38326393243` successful; unified UI smoke run `38326393486` successful. A manual save from the operator's authenticated browser **remains unverified** as of this documentation.
