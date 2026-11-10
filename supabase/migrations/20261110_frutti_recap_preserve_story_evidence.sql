-- Recovery-only additions: operator-reviewed story evidence is not canonical.
ALTER TABLE public.publisher_frutti_reconstructed_stock
  ADD COLUMN IF NOT EXISTS episode_story_evidence text,
  ADD COLUMN IF NOT EXISTS episode_story_extraction_method text;
COMMENT ON COLUMN public.publisher_frutti_reconstructed_stock.episode_story_evidence
  IS 'Unverified textual evidence extracted from real Flow prompt; never canonical until operator review.';
COMMENT ON COLUMN public.publisher_frutti_reconstructed_stock.episode_story_extraction_method
  IS 'Informational extractor strategy, never proof of audiovisual identity.';
