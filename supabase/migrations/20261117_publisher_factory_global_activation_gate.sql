-- Publisher Factory: owner-controlled repair/activation state.
-- Installed 2026-11-17 with execute_sql; committed for reproducible disaster recovery.
-- Initial phase is always repair. This migration never activates automation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.publisher_factory_control(
 id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
 owner_id uuid NOT NULL,
 phase text NOT NULL DEFAULT 'repair'
  CHECK(phase IN ('repair','ready_for_reconciliation','armed','active','paused')),
 automation_enabled boolean NOT NULL DEFAULT false,
 technical_readiness boolean NOT NULL DEFAULT false,
 historical_reconciliation_complete boolean NOT NULL DEFAULT false,
 audit_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 activated_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT publisher_factory_control_phase_consistency CHECK(
  automation_enabled=(phase='active') AND
  (phase NOT IN ('armed','active') OR (technical_readiness AND historical_reconciliation_complete))
 )
);
ALTER TABLE public.publisher_factory_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publisher_factory_control FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.publisher_factory_control TO service_role;
INSERT INTO public.publisher_factory_control
 (id,owner_id,phase,automation_enabled,technical_readiness,historical_reconciliation_complete)
SELECT 1,(array_agg(owner_id))[1],'repair',false,false,false
 FROM public.publisher_runtime_publishers
 HAVING COUNT(*)=3 AND COUNT(DISTINCT owner_id)=1
ON CONFLICT(id) DO NOTHING;
CREATE OR REPLACE FUNCTION public.publisher_factory_activate(
 p_owner_id uuid,p_expected_revision integer,p_confirmation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE state public.publisher_factory_control%ROWTYPE; publisher_count integer; active_count integer;
BEGIN
 IF p_confirmation IS DISTINCT FROM 'ACTIVAR AUTOMATIZACION'
 THEN RAISE EXCEPTION 'ACTIVATION_EXPLICIT_CONFIRMATION_REQUIRED' USING ERRCODE='P0001'; END IF;
 SELECT * INTO state FROM public.publisher_factory_control WHERE id=1 FOR UPDATE;
 IF NOT FOUND OR state.owner_id IS DISTINCT FROM p_owner_id
 THEN RAISE EXCEPTION 'ACTIVATION_OWNER_MISMATCH' USING ERRCODE='42501'; END IF;
 IF state.phase IS DISTINCT FROM 'armed' OR state.automation_enabled IS DISTINCT FROM false OR
    state.technical_readiness IS DISTINCT FROM true OR state.historical_reconciliation_complete IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'FACTORY_NOT_ARMED' USING ERRCODE='P0001'; END IF;
 IF state.revision IS DISTINCT FROM p_expected_revision
 THEN RAISE EXCEPTION 'ACTIVATION_STALE_REVISION' USING ERRCODE='40001'; END IF;
 SELECT count(*) INTO publisher_count FROM public.publisher_runtime_publishers WHERE owner_id=p_owner_id
    AND migration_state='ready' AND enabled=false
    AND coalesce((config->'automation'->>'historical_reconciliation_pending')::boolean,false)=false;
 IF publisher_count<>3 THEN RAISE EXCEPTION 'PUBLISHER_READINESS_MISMATCH' USING ERRCODE='P0001'; END IF;
 SELECT count(*) INTO active_count FROM public.publisher_runtime_obligations o
 JOIN public.publisher_runtime_publishers p ON p.id=o.publisher_id
 WHERE p.owner_id=p_owner_id AND o.status IN ('claimed','running');
 IF active_count<>0 THEN RAISE EXCEPTION 'ACTIVE_WORK_MUST_BE_RECONCILED' USING ERRCODE='P0001'; END IF;
 UPDATE public.publisher_runtime_publishers SET enabled=true,updated_at=now()
 WHERE owner_id=p_owner_id AND enabled=false;
 GET DIAGNOSTICS publisher_count=ROW_COUNT;
 IF publisher_count<>3 THEN RAISE EXCEPTION 'ACTIVATION_PARTIAL_PUBLISHER_UPDATE' USING ERRCODE='P0001'; END IF;
 UPDATE public.publisher_factory_control SET phase='active',automation_enabled=true,
   activated_at=now(),revision=revision+1,updated_at=now() WHERE id=1;
 RETURN jsonb_build_object('activated',true,'publisher_count',publisher_count,'at',now());
END $function$;
REVOKE ALL ON FUNCTION public.publisher_factory_activate(uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publisher_factory_activate(uuid,integer,text) TO service_role;
CREATE OR REPLACE FUNCTION public.publisher_factory_pause(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE state public.publisher_factory_control%ROWTYPE;
BEGIN
 SELECT * INTO state FROM public.publisher_factory_control WHERE id=1 FOR UPDATE;
 IF NOT FOUND OR state.owner_id IS DISTINCT FROM p_owner_id
 THEN RAISE EXCEPTION 'FACTORY_OWNER_MISMATCH' USING ERRCODE='42501'; END IF;
 UPDATE public.publisher_runtime_publishers SET enabled=false,updated_at=now()
 WHERE owner_id=p_owner_id AND enabled=true;
 UPDATE public.publisher_factory_control SET phase='paused',automation_enabled=false,
    revision=revision+1,updated_at=now() WHERE id=1;
 RETURN jsonb_build_object('paused',true,'at',now());
END $function$;
REVOKE ALL ON FUNCTION public.publisher_factory_pause(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publisher_factory_pause(uuid) TO service_role;
COMMIT;
