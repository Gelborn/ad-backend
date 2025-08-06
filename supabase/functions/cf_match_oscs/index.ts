// supabase/functions/cf_match_oscs/index.ts
// Edge Function — devolve OSCs num raio X (acesso: CF admin)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS + método */
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Auth (CF admin) ---------- */
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

  /* ---------- Body ---------- */
  let body: { restaurant_id?: string; radius_km?: number };
  try { body = await req.json(); } catch { body = {}; }

  const { restaurant_id, radius_km } = body;
  if (!restaurant_id || !radius_km) {
    return new Response("Missing fields", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- RPC ---------- */
  const { data, error } = await supa.rpc("match_oscs", {
    p_restaurant: restaurant_id,
    p_radius_km:  radius_km,
  });

  if (error) {
    return new Response(
      JSON.stringify({ code: "RPC_ERROR", message: error.message }),
      { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
  });
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  "/cf_match_oscs":  handler,
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/cf_match_oscs
*/
