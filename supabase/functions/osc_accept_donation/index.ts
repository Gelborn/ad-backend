// Edge Function — OSC confirma retirada da doação (via intent/security_code)
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* ──────────────── Client (service-role, ignora RLS) ───────── */
const supa = createClient(SUPABASE_URL, SRV_KEY);

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(origin) });
  }

  // Body
  let body: { security_code?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders(origin) });
  }

  const security_code = body?.security_code?.trim();
  if (!security_code) {
    return new Response("Missing security_code", { status: 400, headers: corsHeaders(origin) });
  }

  // RPC call
  try {
    const { data, error } = await supa.rpc("accept_donation_intent", {
      p_security_code: security_code,
    });

    if (error) {
      // Map common error messages thrown by the RPC
      const map: Record<string, { status: number; message: string }> = {
        INTENT_NOT_FOUND:     { status: 404, message: "Invalid or unknown security code." },
        INTENT_NOT_WAITING:   { status: 409, message: "This offer is not open for acceptance." },
        INTENT_EXPIRED:       { status: 410, message: "This offer has expired." },
      };
      const found = map[error.message];
      if (found) {
        return new Response(
          JSON.stringify({ code: error.message, message: found.message }),
          { status: found.status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
        );
      }
      // Fallback
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      // extremely rare: no row returned but no pg error
      return new Response(
        JSON.stringify({ code: "NO_RESULT", message: "No result returned." }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    // Success — keep 204 like before (no body needed)
    console.log("✅ Donation accepted:", row.donation_id, "intent:", row.intent_id);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });

  } catch (err: any) {
    console.error("osc_accept_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "DB_ERROR", message: err.message }),
      { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
    );
  }
};

/* ──────────────── Router ──────────────── */
serve({ "/osc_accept_donation": handler });

/* Endpoint:
   POST https://<project>.supabase.co/functions/v1/osc_accept_donation
   body: { "security_code": "ABC123" }
*/
