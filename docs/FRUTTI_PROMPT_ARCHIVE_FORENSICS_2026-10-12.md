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
