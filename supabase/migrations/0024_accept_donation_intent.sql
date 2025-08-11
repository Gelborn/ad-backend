BEGIN;

-- RPC: Accept a donation intent by its security code.
-- Enforces: only waiting_response; not expired; binds donation; closes others.
CREATE OR REPLACE FUNCTION public.accept_donation_intent(
  p_security_code text
)
RETURNS TABLE(donation_id uuid, intent_id uuid) AS $$
DECLARE
  v_now        timestamptz := now();
  v_intent_id  uuid;
  v_donation_id uuid;
  v_status     donation_intent_status;
  v_expires_at timestamptz;
BEGIN
  -- 1) Lookup intent by code
  SELECT di.id, di.donation_id, di.status, di.expires_at
    INTO v_intent_id, v_donation_id, v_status, v_expires_at
  FROM public.donation_intents di
  WHERE di.security_code = p_security_code
  LIMIT 1;

  IF v_intent_id IS NULL THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND';
  END IF;

  -- 2) Must be waiting_response
  IF v_status <> 'waiting_response' THEN
    RAISE EXCEPTION 'INTENT_NOT_WAITING';
  END IF;

  -- 3) Expiry gate
  IF v_expires_at IS NOT NULL AND v_now > v_expires_at THEN
    UPDATE public.donation_intents
       SET status = 'expired', updated_at = v_now
     WHERE id = v_intent_id AND status = 'waiting_response';
    RAISE EXCEPTION 'INTENT_EXPIRED';
  END IF;

  -- 4) Accept intent
  UPDATE public.donation_intents
     SET status = 'accepted', updated_at = v_now
   WHERE id = v_intent_id AND status = 'waiting_response';

  IF NOT FOUND THEN
    -- race condition safeguard
    RAISE EXCEPTION 'INTENT_NOT_WAITING';
  END IF;

  -- 5) Bind donation to accepted state (legacy model already has osc_id/code set)
  UPDATE public.donations
     SET status = 'accepted', accepted_at = v_now
   WHERE id = v_donation_id
     AND status = 'pending';

  -- It’s okay if NOT FOUND (already accepted). We carry on to close other intents.

  -- 6) Close other open intents
  UPDATE public.donation_intents
     SET status = 're_routed', updated_at = v_now
   WHERE donation_id = v_donation_id
     AND status = 'waiting_response'
     AND id <> v_intent_id;

  -- 7) Return identifiers
  RETURN QUERY SELECT v_donation_id, v_intent_id;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
