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

/* Helpers */
function normalizeCnpj(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = String(input).trim();
  if (cleaned === "") return null;
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length !== 14) {
    const e: any = new Error("CNPJ deve conter 14 dígitos");
    e.status = 422; e.code = "INVALID_CNPJ";
    throw e;
  }
  return digits; // armazenar só dígitos para garantir unicidade
}

function normalizeCode(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = String(input).trim();
  return cleaned === "" ? null : cleaned;
}

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
    const body = await req.json();
    const {
      name,
      emailOwner,
      cep,
      number,
      street,
      city,
      uf,
      phone,
      cnpj: cnpjRaw,
      code: codeRaw,
    } = body ?? {};

    const emailLc = String(emailOwner ?? "").trim().toLowerCase();

    // Minimal required input checks (422)
    if (!name || !emailLc || !cep) {
      return new Response(
        JSON.stringify({ code: "INVALID_INPUT", message: "Campos obrigatórios ausentes" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 1) CEP: normalizar + validar ─── */
    const cepDigits = String(cep).replace(/\D/g, "");
    if (!validateCep(cepDigits)) {
      return new Response(
        JSON.stringify({ code: "INVALID_CEP", message: "CEP inválido" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 2) CNPJ/Code: normalizar (opcionais) ─── */
    let cnpj: string | null = null;
    let code: string | null = null;
    try {
      cnpj = normalizeCnpj(cnpjRaw);
      code = normalizeCode(codeRaw);
    } catch (valErr: any) {
      const status = valErr.status ?? 422;
      return new Response(
        JSON.stringify({ code: valErr.code ?? "INVALID_INPUT", message: valErr.message }),
        { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 3) Duplicates: email / cnpj / code ─── */
    // Email
    {
      const { data: existing, error: dupErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("email", emailLc)
        .limit(1)
        .maybeSingle();

      if (dupErr) {
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
    // CNPJ (if provided)
    if (cnpj) {
      const { data: existingCnpj, error: cnpjErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("cnpj", cnpj)
        .limit(1)
        .maybeSingle();

      if (cnpjErr) {
        return new Response(
          JSON.stringify({ code: "CNPJ_CHECK_ERROR", message: cnpjErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
      if (existingCnpj) {
        return new Response(
          JSON.stringify({ code: "CNPJ_ALREADY_EXISTS", message: "Já existe restaurante com este CNPJ" }),
          { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    }
    // Code (if provided)
    if (code) {
      const { data: existingCode, error: codeErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("code", code)
        .limit(1)
        .maybeSingle();

      if (codeErr) {
        return new Response(
          JSON.stringify({ code: "CODE_CHECK_ERROR", message: codeErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
      if (existingCode) {
        return new Response(
          JSON.stringify({ code: "CODE_ALREADY_EXISTS", message: "Já existe restaurante com este código" }),
          { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    }

    /* ─── 4) Geocode BEFORE creating user ─── */
    let geo;
    try {
      geo = await geocodeByCep(cepDigits, number);
      // Require coordinates
      const latOk = geo && typeof geo.lat === "number";
      const lngOk = geo && typeof geo.lng === "number";
      if (!latOk || !lngOk) {
        return new Response(
          JSON.stringify({ code: "GEOCODE_NO_COORDS", message: "Não foi possível obter coordenadas do CEP/número" }),
          { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    } catch (e: any) {
      return new Response(
        JSON.stringify({ code: "GEOCODE_ERROR", message: e?.message ?? "Falha ao geocodificar CEP" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 5) Cria usuário (confirmado) ─── */
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
    if (!ownerId) throw new Error("Falha ao criar usuário");

    /* ─── 6) Gera & envia magic-link ─── */
    try {
      await supaAdmin.auth.signInWithOtp({
        email: emailLc,
        options: { emailRedirectTo: `${APP_URL}/dashboard` },
      });
    } catch (linkErr: any) {
      return new Response(
        JSON.stringify({ code: "MAGIC_LINK_ERROR", message: linkErr.message }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 7) Insere restaurante ─── */
    const insertPayload: any = {
      name,
      phone,
      email:   emailLc,
      street:  street ?? geo.street,
      number,
      city:    city  ?? geo.city,
      uf:      uf    ?? geo.uf,
      cep:     cepDigits,
      lat:     geo.lat,
      lng:     geo.lng,
      status:  "active",
      user_id: ownerId,
    };
    if (cnpj) insertPayload.cnpj = cnpj;
    if (code) insertPayload.code = code;

    const { data: restaurant, error: restErr } = await supaUser
      .from("restaurants")
      .insert(insertPayload)
      .select()
      .single();

    if (restErr) {
      throw restErr;
    }

    /* ─── 8) Liga user ↔ restaurant ─── */
    const link = await supaAdmin
      .from("restaurant_users")
      .upsert({ user_id: ownerId, restaurant_id: restaurant.id, role: "owner" });

    if (link.error) {
      // Not critical to the main creation, but surface it
      return new Response(
        JSON.stringify({ code: "LINK_CREATE_ERROR", message: link.error.message }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── OK ─── */
    return new Response(
      JSON.stringify({ id: restaurant.id }),
      { status: 201, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ code: err?.code ?? "INTERNAL_ERROR", message: err?.message ?? "Erro interno" }),
      { status: err?.status ?? 500, headers: { ...corsHeaders(req.headers.get("origin") ?? undefined), "Content-Type": "application/json" } }
    );
  }
};

/* ──────────────── Router ──────────────── */
serve({ "/cf_create_restaurant": handler });
