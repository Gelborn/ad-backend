import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "../_lib/cors.ts";
import { inviteUser } from "../_lib/invite.ts";

const supa      = createClient(Deno.env.get("SUPABASE_URL")!,  Deno.env.get("SUPABASE_ANON_KEY")!);
const supaAdmin = createClient(Deno.env.get("SUPABASE_URL")!,  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const APP_URL   = Deno.env.get("APP_URL")!;

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });

  try {
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) return new Response("Auth required", { status: 401, headers: corsHeaders(req.headers.get("origin")) });
    supa.auth.setAuth(jwt);
    const { data: isCf } = await supa.rpc("is_cf");
    if (!isCf) return new Response("Forbidden", { status: 403, headers: corsHeaders(req.headers.get("origin")) });

    const { restaurant_id } = await req.json();

    const { data: link } = await supaAdmin
      .from("restaurant_users")
      .select("user_id, users:auth.users(email)")
      .eq("restaurant_id", restaurant_id)
      .eq("role", "owner")
      .single();
    if (!link) return new Response("Owner não encontrado", { status: 404, headers: corsHeaders(req.headers.get("origin")) });

    await inviteUser(link.users.email, `${APP_URL}/set-password`);
    await supaAdmin.from("restaurants").update({ status: "invite_sent" }).eq("id", restaurant_id);

    return new Response("Invite reenviado", { status: 200, headers: corsHeaders(req.headers.get("origin")) });

  } catch (err: any) {
    console.error("cf_send_invite_email ERROR:", err);
    return new Response(JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }), {
      status: 500,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });
  }
});
