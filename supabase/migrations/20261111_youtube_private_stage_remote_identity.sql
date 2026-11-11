-- Correlate the 12:30 PRIVATE YouTube upload with the exact 19:00 release.
-- Additive and safe: no historical obligation is approved or reopened.
ALTER TABLE public.publisher_runtime_obligations
  ADD COLUMN IF NOT EXISTS remote_video_id text,
  ADD COLUMN IF NOT EXISTS remote_item_id uuid;

ALTER TABLE public.publisher_runtime_obligations
  ADD CONSTRAINT publisher_runtime_stage_identity_pair_chk
  CHECK ((remote_video_id IS NULL AND remote_item_id IS NULL)
      OR (remote_video_id ~ '^[A-Za-z0-9_-]{11}$' AND remote_item_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS publisher_runtime_remote_video_identity_uq
  ON public.publisher_runtime_obligations(publisher_id,remote_video_id)
  WHERE remote_video_id IS NOT NULL;

COMMENT ON COLUMN public.publisher_runtime_obligations.remote_video_id IS
  'Exact verified YouTube PRIVATE video ID persisted at 12:30; required to release same video at 19:00.';
COMMENT ON COLUMN public.publisher_runtime_obligations.remote_item_id IS
  'Exact immutable local publication_items.id that owns the PRIVATE staged video.';
