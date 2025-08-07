// supabase/functions/cf_create_restaurant/index.ts
// Edge Function — cria restaurante e envia magic-link de boas-vindas (acesso: CF admin)

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

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  const origin = req.headers.get("origin") ?? undefined;

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(origin) });
  }

  try {
    /* ---------- Auth (CF admin) ---------- */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) {
      return new Response(
        JSON.stringify({ code: "AUTH_REQUIRED", message: "Auth required" }),
        { status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const supaUser  = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

    const { data: isCf } = await supaUser.rpc("is_cf");
    if (!isCf) {
      return new Response(
        JSON.stringify({ code: "FORBIDDEN", message: "Forbidden" }),
        { status: 403, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ---------- Body ---------- */
    const { name, emailOwner, cep, number, street, city, uf, phone } = await req.json();
    const emailLc = (emailOwner as string).trim().toLowerCase();

    /* ─── 0) Verifica email duplicado em restaurants ─── */
    {
      const { data: existing, error: dupErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("email", emailLc)
        .limit(1)
        .maybeSingle();

      if (dupErr) {
        console.error("Erro validando duplicação de email:", dupErr);
        return new Response(
          JSON.stringify({ code: "EMAIL_CHECK_ERROR", message: dupErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
      if (existing) {
        return new Response(
          JSON.stringify({ code: "EMAIL_ALREADY_EXISTS", message: "Restaurante com esse e-mail já existe" }),
          { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    }

    /* ─── 1) Cria usuário (confirmado) ─── */
    const { data: newUser, error: userErr } = await supaAdmin.auth.admin
      .createUser({ email: emailLc, email_confirm: true });

    if (userErr) {
      const status = userErr.status ?? 400;
      return new Response(
        JSON.stringify({ code: "USER_CREATE_ERROR", message: userErr.message }),
        { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const ownerId = newUser.user?.id;
    if (!ownerId) {
      throw new Error("Falha ao criar usuário");
    }

    /* ─── 2) Gera & envia magic-link ─── */
    try {
      await supaAdmin.auth.signInWithOtp({
        email: emailLc,
        options: { emailRedirectTo: `${APP_URL}/dashboard` },
      });
    } catch (linkErr: any) {
      console.error("Erro gerando magic link:", linkErr);
      return new Response(
        JSON.stringify({ code: "MAGIC_LINK_ERROR", message: linkErr.message }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 3) Geocoding ─── */
    const geo = await geocodeByCep(cep, number);

    /* ─── 4) Insere restaurante ─── */
    const { data: restaurant, error: restErr } = await supaUser
      .from("restaurants")
      .insert({
        name,
        phone,
        email:   emailLc,
        street:  street ?? geo.street,
        number,
        city:    city  ?? geo.city,
        uf:      uf    ?? geo.uf,
        cep,
        lat:     geo.lat,
        lng:     geo.lng,
        status:  "active",
        user_id: ownerId,
      })
      .select()
      .single();

    if (restErr) {
      console.error("Erro inserindo restaurante:", restErr);
      throw restErr;
    }

    /* ─── 5) Liga user ↔ restaurant ─── */
    await supaAdmin
      .from("restaurant_users")
      .upsert({ user_id: ownerId, restaurant_id: restaurant.id, role: "owner" });

    /* ─── Sucesso ─── */
    return new Response(
      JSON.stringify({ id: restaurant.id }),
      {
        status: 201,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      }
    );

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
