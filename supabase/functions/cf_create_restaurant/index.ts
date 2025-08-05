// supabase/functions/cf_create_restaurant/index.ts
// Edge Function — cria restaurante e convida o proprietário (acesso: CF admin)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { geocodeByCep }  from "$lib/geocode.ts";
import { validateCep }   from "$lib/cep.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL      = Deno.env.get("APP_URL")!;

/* Client service-role (ignora RLS) */
const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS */
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    /* ---------- Auth (CF admin) ---------- */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) {
      return new Response("Auth required", { status: 401, headers: corsHeaders(req.headers.get("origin")) });
    }
    const supa = createClient(
      SUPABASE_URL,
      ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );
    const { data: isCf } = await supa.rpc("is_cf");
    if (!isCf) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(req.headers.get("origin")) });
    }

    /* ---------- Body ---------- */
    const {
      name,
      emailOwner,
      cep,
      number,
      street,
      city,
      uf,
      phone,
    } = await req.json();

    const emailLc = (emailOwner as string).trim().toLowerCase();

    if (!validateCep(cep)) {
      return new Response("CEP inválido", { status: 422, headers: corsHeaders(req.headers.get("origin")) });
    }

    /* ---------- Verifica se o e-mail já está cadastrado ---------- */
    const { data: existing, error: dupErr } = await supabase
      .from('restaurants')
      .select('id')                                       // não precisa de tudo
      .ilike('email', emailLc)                            // case-insensitive
      .maybeSingle();                                     // devolve 0 ou 1

    if (dupErr) throw dupErr;

    if (existing) {
      return new Response(
        JSON.stringify({
          code: 'email_exists',
          message: 'E-mail já cadastrado',
        }),
        {
          status: 409,
          headers: {
            ...corsHeaders(req.headers.get('origin')),
            'Content-Type': 'application/json',
          },
        },
      );
    }

    /* ---------- Convida usuário ---------- */
    const { data: inviteRes, error: inviteErr } = await supaAdmin.auth.admin
      .inviteUserByEmail(emailLc, { redirectTo: `${APP_URL}/set-password` });
    if (inviteErr || !inviteRes?.user) throw new Error("Falha ao convidar usuário");
    const ownerId = inviteRes.user.id;

    /* ---------- Geocoding ---------- */
    const geo = await geocodeByCep(cep, number);

    /* ---------- Insere restaurante ---------- */
    const { data: restaurant, error: restErr } = await supa
      .from("restaurants")
      .insert({
        name,
        phone,
        email: emailLc,            // NOT NULL
        street: street ?? geo.street,
        number,
        city:   city   ?? geo.city,
        uf:     uf     ?? geo.uf,
        cep,
        lat: geo.lat,
        lng: geo.lng,
        status: "invite_sent",
        user_id: ownerId,          // NOT NULL
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

    /* ---------- Done ---------- */
    return new Response(JSON.stringify({ id: restaurant.id }), {
      status: 201,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("cf_create_restaurant ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
      {
        status: 500,
        headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
      }
    );
  }
};

/* ──────────────── Router ──────────────── */
serve({ "/cf_create_restaurant": handler });

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/cf_create_restaurant
*/
