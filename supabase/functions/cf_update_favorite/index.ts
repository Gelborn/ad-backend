// supabase/functions/cf_update_favorite/index.ts
// Edge Function — define a OSC favorita de um restaurante
// Acesso: CF admin

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS + método --------------------------------------------------- */
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Auth (CF admin) -------------------------------------- */
  const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!jwt) {
    return new Response("Auth required", { status: 401, headers: corsHeaders(req.headers.get("origin")) });
  }
  const supa = createClient(
    SUPABASE_URL,
    ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );

  const { data: isCf } = await supa.rpc("is_cf");
  if (!isCf) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Body ------------------------------------------------- */
  let body: { restaurant_id?: string; osc_id?: string };
  try { body = await req.json(); } catch { body = {}; }

  const { restaurant_id, osc_id } = body;
  if (!restaurant_id || !osc_id) {
    return new Response("Missing fields", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- DB ops ------------------------------------------------ */
  try {
    // Remove qualquer favorito anterior
    await supa
      .from("partnerships")
      .update({ is_favorite: false })
      .eq("restaurant_id", restaurant_id);

    // Define novo favorito (upsert)
    await supa
      .from("partnerships")
      .upsert(
        [{ restaurant_id, osc_id, is_favorite: true }],
        { onConflict: "restaurant_id,osc_id" },
      );

    return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
  } catch (e: any) {
    console.error("cf_update_favorite ERROR:", e);
    return new Response(
      JSON.stringify({ code: "DB_ERROR", message: e.message }),
      {
        status: 400,
        headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
      },
    );
  }
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  "/cf_update_favorite": handler,
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/cf_update_favorite
*/
