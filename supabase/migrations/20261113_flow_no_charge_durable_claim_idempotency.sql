-- A duplicate delivery of a previously confirmed Flow no-charge claim must
-- NEVER become a fresh 1h/2h/... alert merely because another publisher
-- reported a newer claim in the meantime. The old cooldown projection keeps
-- only the latest claim ID, so it is not a durable idempotency ledger.
-- This migration changes no existing publisher, obligation, or cooldown row.
CREATE TABLE IF NOT EXISTS public.publisher_flow_no_charge_claim_events (
  claim_id uuid PRIMARY KEY,
  publisher_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.publisher_flow_no_charge_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.publisher_flow_no_charge_claim_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.publisher_flow_no_charge_claim_events TO service_role;

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
 current_streak integer;
 current_deadline timestamptz;
 next_streak integer;
 delay_minutes integer;
 proposed_until timestamptz;
 inserted_events integer;
BEGIN
 IF p_publisher_id IS NULL OR p_claim_id IS NULL THEN
  RAISE EXCEPTION 'FLOW_CLAIM_OR_PUBLISHER_REQUIRED';
 END IF;
 PERFORM pg_advisory_xact_lock(20261112, 91341);
 IF NOT EXISTS(
  SELECT 1 FROM public.publisher_runtime_obligations o
  WHERE o.publisher_id=p_publisher_id AND o.claim_id=p_claim_id
    AND o.kind='generation' AND o.status IN ('claimed','running','blocked')
 ) THEN
  RAISE EXCEPTION 'FLOW_NO_CHARGE_GENERATION_CLAIM_NOT_FOUND';
 END IF;
 INSERT INTO public.publisher_runtime_flow_cooldowns(publisher_id,streak,status,updated_at)
 SELECT id,0,'clear',now() FROM public.publisher_runtime_publishers
 ON CONFLICT(publisher_id) DO NOTHING;
 -- The primary key is permanent across newer alerts and successful resets.
 -- A duplicate claim is acknowledged WITHOUT extending any global deadline.
 INSERT INTO public.publisher_flow_no_charge_claim_events(claim_id,publisher_id)
 VALUES(p_claim_id,p_publisher_id)
 ON CONFLICT(claim_id) DO NOTHING;
 GET DIAGNOSTICS inserted_events = ROW_COUNT;
 IF inserted_events=0 THEN
  IF NOT EXISTS(
   SELECT 1 FROM public.publisher_flow_no_charge_claim_events e
   WHERE e.claim_id=p_claim_id AND e.publisher_id=p_publisher_id
  ) THEN
   RAISE EXCEPTION 'FLOW_NO_CHARGE_CLAIM_PUBLISHER_MISMATCH';
  END IF;
  RETURN QUERY SELECT c.streak,c.not_before,c.status
   FROM public.publisher_runtime_flow_cooldowns c
   WHERE c.publisher_id=p_publisher_id;
  RETURN;
 END IF;
 SELECT COALESCE(MAX(c.streak),0),MAX(c.not_before)
 INTO current_streak,current_deadline
 FROM public.publisher_runtime_flow_cooldowns c
 WHERE c.status <> 'clear';
 next_streak:=LEAST(1000,current_streak+1);
 delay_minutes:=CASE
  WHEN next_streak=1 THEN 30
  WHEN next_streak=2 THEN 60
  WHEN next_streak=3 THEN 120
  WHEN next_streak=4 THEN 240
  WHEN next_streak=5 THEN 480
  ELSE 1440 END;
 proposed_until:=GREATEST(COALESCE(current_deadline,now()),now()+make_interval(mins=>delay_minutes));
 UPDATE public.publisher_runtime_flow_cooldowns c
 SET streak=next_streak,not_before=proposed_until,last_alert_at=now(),
     last_alert_claim_id=p_claim_id,
     last_alert_item_id=left(coalesce(p_item_id,''),150),
     status=CASE WHEN next_streak>=6 THEN 'attention_24h' ELSE 'cooldown' END,
     updated_at=now();
 RETURN QUERY SELECT next_streak,proposed_until,
  CASE WHEN next_streak>=6 THEN 'attention_24h' ELSE 'cooldown' END::text;
END $$;
REVOKE ALL ON FUNCTION public.publisher_flow_record_no_charge(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publisher_flow_record_no_charge(uuid,uuid,text) TO service_role;
