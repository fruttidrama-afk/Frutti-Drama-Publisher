-- A no-charge "Unusual Activity" rejection pauses the ENTIRE Factory, not
-- merely the show that happened to receive the rejection. No Flow calls here.
-- Preserve the existing per-publisher table as the read-only panel projection.
-- A fixed advisory transaction lock serializes escalation and successful reset.
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
BEGIN
 IF p_publisher_id IS NULL OR p_claim_id IS NULL THEN
  RAISE EXCEPTION 'FLOW_CLAIM_OR_PUBLISHER_REQUIRED';
 END IF;
 PERFORM pg_advisory_xact_lock(20261112, 91341);
 IF NOT EXISTS(SELECT 1 FROM public.publisher_runtime_publishers WHERE id=p_publisher_id) THEN
  RAISE EXCEPTION 'FLOW_PUBLISHER_NOT_FOUND';
 END IF;
 -- Include disabled/onboarding publishers so the UI also shows the global
 -- pause; a future publisher is still protected by the Edge global read.
 INSERT INTO public.publisher_runtime_flow_cooldowns(publisher_id,streak,status,updated_at)
 SELECT id,0,'clear',now() FROM public.publisher_runtime_publishers
 ON CONFLICT(publisher_id) DO NOTHING;
 -- Repeated delivery of the SAME claim is not a new anti-abuse incident.
 IF EXISTS(
  SELECT 1 FROM public.publisher_runtime_flow_cooldowns
  WHERE last_alert_claim_id=p_claim_id
 ) THEN
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
 -- All shows share the same streak, deadline, and attention_24h indicator.
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

-- A later, truly completed generation can reset the global escalation.
-- An older in-flight generation must NEVER erase a newer safety deadline.
CREATE OR REPLACE FUNCTION public.publisher_flow_clear_after_success(
 p_publisher_id uuid,
 p_claim_id uuid,
 p_claimed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE latest_alert timestamptz;
BEGIN
 IF p_publisher_id IS NULL OR p_claim_id IS NULL OR p_claimed_at IS NULL THEN
  RETURN false;
 END IF;
 PERFORM pg_advisory_xact_lock(20261112, 91341);
 IF NOT EXISTS(
  SELECT 1 FROM public.publisher_runtime_obligations o
  WHERE o.publisher_id=p_publisher_id AND o.claim_id=p_claim_id
    AND o.kind='generation' AND o.status='completed'
 ) THEN
  RETURN false;
 END IF;
 SELECT MAX(c.last_alert_at) INTO latest_alert
 FROM public.publisher_runtime_flow_cooldowns c WHERE c.status <> 'clear';
 IF latest_alert IS NULL OR p_claimed_at <= latest_alert THEN
  RETURN false;
 END IF;
 UPDATE public.publisher_runtime_flow_cooldowns
 SET streak=0,not_before=NULL,last_alert_at=NULL,last_alert_claim_id=NULL,
     last_alert_item_id=NULL,status='clear',updated_at=now()
 WHERE status <> 'clear';
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.publisher_flow_clear_after_success(uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publisher_flow_clear_after_success(uuid,uuid,timestamptz) TO service_role;
