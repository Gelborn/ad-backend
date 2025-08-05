import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!
);

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: corsHeaders(null) });

  const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!jwt) return new Response("Auth required", { status: 401 });
  supa.auth.setAuth(jwt);
  const { data: isCf } = await supa.rpc("is_cf");
  if (!isCf) return new Response("Forbidden", { status: 403 });

  const { restaurant_id, radius_km } = await req.json();
  if (!restaurant_id || !radius_km)
    return new Response("Missing fields", { status: 400 });

  const { data, error } = await supa.rpc("match_oscs", {
    p_restaurant: restaurant_id,
    p_radius_km: radius_km,
  });

  if (error)
    return new Response(error.message, {
      status: 400,
      headers: corsHeaders(req.headers.get("origin")),
    });

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
  });
});

/* ──────────────── Rotas ────────────────
   /cf_match_oscs  → runtime regional  (/functions/v1/…)
   /cf-match-oscs  → runtime global    (.functions.supabase.co/…)
*/
serve({
  "/cf_match_oscs": handler,
  "/cf-match-oscs": handler,
});