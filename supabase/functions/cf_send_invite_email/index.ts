// supabase/functions/cf_send_invite_email/index.ts
// Edge Function — reenvia o convite de acesso ao proprietário do restaurante
// Acesso: CF admin

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { inviteUser } from "$lib/invite.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL      = Deno.env.get("APP_URL")!;

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
  const supa      = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

  const { data: isCf } = await supa.rpc("is_cf");
  if (!isCf) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Body ------------------------------------------------- */
  let body: { restaurant_id?: string };
  try { body = await req.json(); } catch { body = {}; }
  const { restaurant_id } = body;
  if (!restaurant_id) {
    return new Response("Missing restaurant_id", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Busca owner + reenvia convite ------------------------ */
  const { data: link, error: linkErr } = await supaAdmin
    .from("restaurant_users")
    .select("user_id, users:auth.users(email)")
    .eq("restaurant_id", restaurant_id)
    .eq("role", "owner")
    .single();

  if (linkErr) {
    return new Response(linkErr.message, { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }
  if (!link) {
    return new Response("Owner não encontrado", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }

  await inviteUser(link.users.email, `${APP_URL}/set-password`);
  await supaAdmin.from("restaurants").update({ status: "invite_sent" }).eq("id", restaurant_id);

  /* ---------- Done ------------------------------------------------- */
  return new Response(
    JSON.stringify({ message: "Invite reenviado" }),
    {
      status: 200,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    },
  );
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  "/cf_send_invite_email": handler,
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/cf_send_invite_email
*/
