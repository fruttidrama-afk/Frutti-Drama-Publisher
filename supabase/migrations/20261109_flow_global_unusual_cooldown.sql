-- Supabase production migrations applied on 2026-11-09 to
-- publisher-factory wrflttnmlrsuzuukdhtf.
-- One owner account per publisher; RLS only service-role can read/write this
-- timer. No login secrets or video content stored.
CREATE TABLE IF NOT EXISTS public.publisher_runtime_flow_cooldowns (
 publisher_id uuid PRIMARY KEY REFERENCES public.publisher_runtime_publishers(id) ON DELETE CASCADE,
 streak integer NOT NULL DEFAULT 0 CHECK (streak BETWEEN 0 AND 1000),
 not_before timestamptz,
 last_alert_at timestamptz,
 last_alert_claim_id uuid,
 last_alert_item_id text,
 status text NOT NULL DEFAULT 'clear' CHECK (status IN ('clear','cooldown','attention_24h')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.publisher_runtime_flow_cooldowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.publisher_runtime_flow_cooldowns FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS publisher_runtime_flow_cooldown_due_idx
 ON public.publisher_runtime_flow_cooldowns(not_before)
 WHERE status <> 'clear';

CREATE OR REPLACE FUNCTION public.publisher_flow_record_no_charge(
 p_publisher_id uuid,
 p_claim_id uuid,
 p_item_id text DEFAULT NULL
)
RETURNS TABLE(streak integer, not_before timestamptz, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
 rec public.publisher_runtime_flow_cooldowns%ROWTYPE;
 next_streak integer;
 minutes integer;
 proposed_until timestamptz;
BEGIN
 IF p_publisher_id IS NULL OR p_claim_id IS NULL THEN
  RAISE EXCEPTION 'FLOW_CLAIM_OR_PUBLISHER_REQUIRED';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.publisher_runtime_publishers WHERE id=p_publisher_id) THEN
  RAISE EXCEPTION 'FLOW_PUBLISHER_NOT_FOUND';
 END IF;
 INSERT INTO public.publisher_runtime_flow_cooldowns(publisher_id,streak,status,updated_at)
 VALUES(p_publisher_id,0,'clear',now())
 ON CONFLICT(publisher_id) DO NOTHING;
 SELECT * INTO STRICT rec
 FROM public.publisher_runtime_flow_cooldowns c
 WHERE c.publisher_id=p_publisher_id FOR UPDATE;
 IF rec.last_alert_claim_id=p_claim_id THEN
  RETURN QUERY SELECT rec.streak,rec.not_before,rec.status;
  RETURN;
 END IF;
 next_streak:=LEAST(1000,rec.streak+1);
 minutes:=CASE
  WHEN next_streak=1 THEN 30
  WHEN next_streak=2 THEN 60
  WHEN next_streak=3 THEN 120
  WHEN next_streak=4 THEN 240
  WHEN next_streak=5 THEN 480
  ELSE 1440 END;
 proposed_until:=GREATEST(
  COALESCE(rec.not_before,now()),
  now()+make_interval(mins=>minutes)
 );
 UPDATE public.publisher_runtime_flow_cooldowns c
 SET streak=next_streak,
     not_before=proposed_until,
     last_alert_at=now(),
     last_alert_claim_id=p_claim_id,
     last_alert_item_id=left(coalesce(p_item_id,''),150),
     status=CASE WHEN next_streak>=6 THEN 'attention_24h' ELSE 'cooldown' END,
     updated_at=now()
 WHERE c.publisher_id=p_publisher_id;
 RETURN QUERY SELECT next_streak,proposed_until,
  CASE WHEN next_streak>=6 THEN 'attention_24h' ELSE 'cooldown' END::text;
END $$;
REVOKE ALL ON FUNCTION public.publisher_flow_record_no_charge(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publisher_flow_record_no_charge(uuid,uuid,text) TO service_role;
