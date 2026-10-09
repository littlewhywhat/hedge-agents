CREATE OR REPLACE FUNCTION public.reject_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Recognized history is append-only; append a reversal instead';
END;
$$;

DROP TRIGGER IF EXISTS immutable_events ON public.events;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON public.events
FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();

DROP TRIGGER IF EXISTS immutable_accounting ON public.accounting_entries;
CREATE TRIGGER immutable_accounting BEFORE UPDATE OR DELETE ON public.accounting_entries
FOR EACH ROW EXECUTE FUNCTION public.reject_history_mutation();

CREATE OR REPLACE FUNCTION public.advance_audit_head()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    tail_hash text;
    tail_sequence integer;
BEGIN
    SELECT hash, sequence INTO tail_hash, tail_sequence FROM public.audit_heads WHERE id = 1 FOR UPDATE;
    IF tail_hash IS NULL OR NEW.prev_hash <> tail_hash OR NEW.id <> tail_sequence + 1 THEN
        RAISE EXCEPTION 'Audit event must extend the locked tail';
    END IF;
    UPDATE public.audit_heads SET hash = NEW.hash, sequence = NEW.id WHERE id = 1;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS linked_event_insert ON public.events;
CREATE TRIGGER linked_event_insert BEFORE INSERT ON public.events
FOR EACH ROW EXECUTE FUNCTION public.advance_audit_head();

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hedge_app, hedge_signer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hedge_app, hedge_signer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hedge_app, hedge_signer;
REVOKE UPDATE, DELETE, TRUNCATE ON public.events, public.accounting_entries FROM hedge_app, hedge_signer;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.gate_evidence FROM hedge_app, hedge_signer;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_heads FROM hedge_app, hedge_signer;
GRANT UPDATE (id) ON public.audit_heads TO hedge_app, hedge_signer;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chain_attempts FROM hedge_app;
GRANT SELECT (id, wallet_id, parent_id, leg, number, state, chain, tx_id, request_id,
              validity, reserved_inputs, confirmation, error, created_at)
ON public.chain_attempts TO hedge_app;
REVOKE ALL ON FUNCTION public.advance_audit_head() FROM PUBLIC;