import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const payload = await req.json();        // { id, email, ... }
  const userId  = payload?.id;
  if (!userId) return new Response("Bad payload", { status: 400 });

  await supa.rpc("activate_restaurants_by_owner", { p_user_id: userId });

  return new Response("ok", { status: 200 });
});

/* ──────────────── Rotas ────────────────
   /restaurant_webhook_user_confirmed  → runtime regional  (/functions/v1/…)
   /restaurant-webhook-user-confirmed  → runtime global    (.functions.supabase.co/…)
*/
serve({
  "/restaurant_webhook_user_confirmed": handler,
  "/restaurant-webhook-user-confirmed": handler,
});