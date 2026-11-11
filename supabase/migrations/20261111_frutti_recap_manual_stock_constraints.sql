-- 2026-11-10 (Argentina) / 2026-11-11 UTC.
-- ALREADY APPLIED to production wrflttnmlrsuzuukdhtf; keep this file as
-- authoritative, replayable migration for new/recovered Supabase projects.
--
-- Root cause: the Frutti recovery Edge v40 correctly began saving manual
-- metadata as 'operator_manual_copy', and allowed missing Google Flow prompts.
-- The old DB constraints still permitted only the previous automated metadata
-- methods, a mandatory >=20-char prompt and one prompt provenance. A real
-- operator save failed with Postgres SQLSTATE 23514 on metadata_method.
--
-- Preserve every historic row and original prompt; do not loosen approval,
-- publishing, media, publisher ownership, file hash, or episode constraints.
BEGIN;
ALTER TABLE public.publisher_frutti_reconstructed_stock
  DROP CONSTRAINT IF EXISTS publisher_frutti_reconstructed_stock_metadata_method_check,
  DROP CONSTRAINT IF EXISTS publisher_frutti_reconstructed_stock_prompt_provenance_check,
  DROP CONSTRAINT IF EXISTS publisher_frutti_reconstructed_stock_generation_prompt_check,
  ADD CONSTRAINT publisher_frutti_reconstructed_stock_metadata_method_check
    CHECK (metadata_method IN (
      'operator_reviewed',
      'ai_draft_reviewed',
      'rules_draft_reviewed',
      'legacy_canonical_operator_reviewed',
      'operator_manual_copy'
    )),
  ADD CONSTRAINT publisher_frutti_reconstructed_stock_prompt_provenance_check
    CHECK (prompt_provenance IN (
      'operator_copied_google_flow',
      'historical_prompt_not_yet_available'
    )),
  ADD CONSTRAINT publisher_frutti_reconstructed_stock_generation_prompt_check
    CHECK (
      (generation_prompt = '' AND prompt_provenance = 'historical_prompt_not_yet_available')
      OR
      (char_length(generation_prompt) BETWEEN 20 AND 50000
        AND prompt_provenance = 'operator_copied_google_flow')
    );
COMMIT;
