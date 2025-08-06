// supabase/functions/osc_deny_donation/index.ts
// Edge Function — OSC recusa a doação (status ➜ denied)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* ──────────────── Client (service-role, ignora RLS) ──────────────── */
const supa = createClient(SUPABASE_URL, SRV_KEY);

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS + método --------------------------------------------------- */
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Body ------------------------------------------------- */
  let body: { security_code?: string };
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  const { security_code } = body;
  if (!security_code) {
    return new Response("Missing security_code", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Update donation -------------------------------------- */
  try {
    const { data, error } = await supa
      .from("donations")
      .update({ status: "denied", accepted_at: new Date().toISOString() })
      .eq("security_code", security_code)
      .eq("status", "pending")
      .select("id");

    if (error) throw error;
    if (!data.length) {
      return new Response(
        "Donation not found or not pending",
        { status: 404, headers: corsHeaders(req.headers.get("origin")) },
      );
    }

    console.log("✅ Donation denied:", data[0].id);
    return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });

  } catch (err: any) {
    console.error("osc_deny_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "DB_ERROR", message: err.message }),
      { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
    );
  }
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  "/osc_deny_donation": handler,
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/osc_deny_donation
*/
