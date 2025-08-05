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

  const { restaurant_id, osc_id } = await req.json();
  if (!restaurant_id || !osc_id)
    return new Response("Missing fields", { status: 400 });

  try {
    await supa
      .from("partnerships")
      .update({ is_favorite: false })
      .eq("restaurant_id", restaurant_id);

    await supa.from("partnerships").upsert(
      [{ restaurant_id, osc_id, is_favorite: true }],
      { onConflict: "restaurant_id,osc_id" }
    );

    return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
  } catch (e: any) {
    return new Response(e.message, { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }
});
