// supabase/functions/restaurant_webhook_user_confirmed/index.ts
// Webhook — ativa restaurantes do novo proprietário após confirmação de e-mail

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ──────────────── Env & client (service-role) ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supa         = createClient(SUPABASE_URL, SRV_KEY);

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  /* ---------- Body ------------------------------------------------- */
  let payload: { id?: string };
  try { payload = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const userId = payload.id;
  if (!userId) {
    return new Response("Bad payload", { status: 400 });
  }

  /* ---------- RPC -------------------------------------------------- */
  await supa.rpc("activate_restaurants_by_owner", { p_user_id: userId });

  return new Response("ok", { status: 200 });
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  // runtime regional (/functions/v1/…)
  "/restaurant_webhook_user_confirmed": handler,
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/restaurant_webhook_user_confirmed
*/
