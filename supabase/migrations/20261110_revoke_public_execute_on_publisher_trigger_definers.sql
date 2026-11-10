-- Applied to Supabase wrflttnmlrsuzuukdhtf on 2026-11-10.
-- These are SECURITY DEFINER trigger functions, not owner-facing RPCs.
-- Triggers continue to execute as configured; direct Data API EXECUTE is
-- intentionally unavailable to anon/authenticated. Service role remains.
REVOKE EXECUTE ON FUNCTION public.close_daily_generation_batch_on_credit_exhaustion() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_publisher_to_free_runtime() FROM PUBLIC, anon, authenticated;
