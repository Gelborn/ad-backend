// supabase/functions/osc_deny_donation/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_KEY = Deno.env.get("FUNCTIONS_INTERNAL_KEY")!; // same secret you used in util_send_notifications

const supa = createClient(SUPABASE_URL, SRV_KEY);

const handler = async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  let body: { security_code?: string };
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  const { security_code } = body ?? {};
  if (!security_code) {
    return new Response("Missing security_code", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    // 1) Anchor donation_id before RPC
    const { data: currentIntent, error: iErr } = await supa
      .from("donation_intents")
      .select("donation_id, status")
      .eq("security_code", security_code)
      .single();

    if (iErr || !currentIntent || currentIntent.status !== "waiting_response") {
      return new Response("Donation not found or not pending", {
        status: 404,
        headers: corsHeaders(req.headers.get("origin")),
      });
    }

    const donationId = currentIntent.donation_id as string;

    // 2) Deny + (maybe) reroute
    const { error: rpcErr } = await supa.rpc("osc_deny_and_reroute", { p_security_code: security_code });
    if (rpcErr) {
      if (rpcErr.message?.includes("DONATION_NOT_FOUND_OR_NOT_PENDING")) {
        return new Response("Donation not found or not pending", {
          status: 404,
          headers: corsHeaders(req.headers.get("origin")),
        });
      }
      throw rpcErr;
    }

    // 3) Check for the new waiting intent (rerouted)
    const { data: newIntent, error: nErr } = await supa
      .from("donation_intents")
      .select("security_code, status, created_at")
      .eq("donation_id", donationId)
      .eq("status", "waiting_response")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // No open intent now → donation was closed; just finish
    if (nErr || !newIntent) {
      return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
    }

    // 4) Notify the **new** OSC with the **new** code
    if (newIntent.security_code && newIntent.security_code !== security_code) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/util_send_notifications`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-key": INTERNAL_KEY,                     // internal guard
            // If util_send_notifications was NOT deployed with --no-verify-jwt, also include a JWT:
            // "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")!}`,
          },
          body: JSON.stringify({ security_code: newIntent.security_code }), // 👈 use NEW code
        });
      } catch (notifyErr) {
        console.error("osc_deny_donation: notify rerouted intent failed:", notifyErr);
      }
    }

    return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
  } catch (err: any) {
    console.error("osc_deny_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "DB_ERROR", message: err.message }),
      { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
    );
  }
};

// Map root + path (invoke-by-name hits "/")
serve({ "/": handler, "/osc_deny_donation": handler });
