import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* Supabase (service-role porque atualiza status) */
const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  /* --- CORS pre-flight --------------------------------------------------- */
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* --- Body -------------------------------------------------------------- */
  let body: { security_code?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  const { security_code } = body;
  if (!security_code) {
    return new Response("Missing security_code", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* --- Update donation --------------------------------------------------- */
  try {
    const { data, error } = await supa
      .from("donations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("security_code", security_code)
      .eq("status", "pending")
      .select("id");

    if (error) throw error;
    if (!data.length) {
      return new Response("Donation not found or not pending", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
    }

    console.log("✅ Donation accepted:", data[0].id);
    return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });

  } catch (err: any) {
    console.error("❌ osc_accept_donation ERROR:", err);
    return new Response(err.message, { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }
});

/* ──────────────── Rotas ────────────────
   /osc_accept_donation  → runtime regional  (/functions/v1/…)
   /osc-accept-donation  → runtime global    (.functions.supabase.co/…)
*/
serve({
  "/osc_accept_donation": handler,
  "/osc-accept-donation": handler,
});