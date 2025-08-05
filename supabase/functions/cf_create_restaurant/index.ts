// supabase/functions/cf_create_restaurant/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { geocodeByCep }  from "$lib/geocode.ts";
import { validateCep }   from "$lib/cep.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL      = Deno.env.get("APP_URL")!;

const supaAdmin = createClient(SUPABASE_URL, SRV_KEY); // ignora RLS

const handler = async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    /* ---------- Auth CF ---------- */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) return new Response("Auth required", { status: 401, headers: corsHeaders(req.headers.get("origin")) });

    const supa = createClient(
      SUPABASE_URL,
      ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );
    const { data: isCf } = await supa.rpc("is_cf");
    if (!isCf) return new Response("Forbidden", { status: 403, headers: corsHeaders(req.headers.get("origin")) });

    /* ---------- Body ---------- */
    const { name, emailOwner, cep, number, street, city, uf, phone } = await req.json();
    if (!validateCep(cep)) {
      return new Response("CEP inválido", { status: 422, headers: corsHeaders(req.headers.get("origin")) });
    }

    /* ---------- Checa duplicidade ---------- */
    const { data: dup } = await supaAdmin
      .from("auth.users")
      .select("id")
      .ilike("email", emailOwner)
      .maybeSingle();
    if (dup) {
      return new Response("E-mail já cadastrado", { status: 409, headers: corsHeaders(req.headers.get("origin")) });
    }

    /* ---------- Convida usuário ---------- */
    const { data: inviteRes, error: inviteErr } = await supaAdmin.auth.admin
      .inviteUserByEmail(emailOwner, { redirectTo: `${APP_URL}/set-password` });
    if (inviteErr || !inviteRes?.user) throw new Error("Falha ao convidar usuário");
    const ownerId = inviteRes.user.id;                    // ✅ id imediato

    /* ---------- Geocoding ---------- */
    const geo = await geocodeByCep(cep, number);

    /* ---------- Insere restaurante ---------- */
    const { data: restaurant, error: restErr } = await supa
      .from("restaurants")
      .insert({
        name,
        phone,
        street: street ?? geo.street,
        number,
        city:   city   ?? geo.city,
        uf:     uf     ?? geo.uf,
        cep,
        lat: geo.lat,
        lng: geo.lng,
        status: "invite_sent",
        user_id: ownerId,                                 // NOT NULL
      })
      .select()
      .single();
    if (restErr) throw restErr;

    /* ---------- Liga user ↔ restaurant ---------- */
    await supaAdmin.from("restaurant_users").upsert({
      user_id:       ownerId,
      restaurant_id: restaurant.id,
      role:          "owner",
    });

    return new Response(JSON.stringify({ id: restaurant.id }), {
      status: 201,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("cf_create_restaurant ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
      { status: 500, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } }
    );
  }
};

serve({ "/cf_create_restaurant": handler });
