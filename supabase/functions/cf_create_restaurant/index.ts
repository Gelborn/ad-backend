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

const LP = "[cf_create_restaurant]";

/* Helpers */
function normalizeCnpj(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = String(input).trim();
  if (cleaned === "") return null;
  const digits = cleaned.replace(/\D/g, "");
  console.log(LP, "normalizeCnpj: input=", cleaned, "digits=", digits);
  if (digits.length !== 14) {
    const e: any = new Error("CNPJ deve conter 14 dígitos");
    e.status = 422; e.code = "INVALID_CNPJ";
    // log BEFORE throwing so we see it in logs
    console.warn(LP, "422 INVALID_CNPJ (length != 14)", { provided: cleaned, digits });
    throw e;
  }
  return digits; // armazenamos só dígitos p/ garantir unicidade
}

function normalizeCode(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = String(input).trim();
  console.log(LP, "normalizeCode:", { input, cleaned });
  return cleaned === "" ? null : cleaned;
}

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  const origin = req.headers.get("origin") ?? undefined;

  console.log(LP, "START", { method: req.method, origin });

  if (req.method !== "POST") {
    console.warn(LP, "405 METHOD_NOT_ALLOWED");
    return new Response(null, { status: 405, headers: corsHeaders(origin) });
  }

  try {
    /* ---------- Auth (CF admin) ---------- */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) {
      console.warn(LP, "401 AUTH_REQUIRED");
      return new Response(
        JSON.stringify({ code: "AUTH_REQUIRED", message: "Auth required" }),
        { status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const supaUser  = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

    const { data: isCf, error: isCfErr } = await supaUser.rpc("is_cf");
    console.log(LP, "RPC is_cf:", { isCf, isCfErr });
    if (!isCf) {
      console.warn(LP, "403 FORBIDDEN (not CF)");
      return new Response(
        JSON.stringify({ code: "FORBIDDEN", message: "Forbidden" }),
        { status: 403, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ---------- Body ---------- */
    const body = await req.json();
    // Log sanitized body (no JWT)
    console.log(LP, "BODY RECEIVED:", body);

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
    } = body;

    const emailLc = String(emailOwner ?? "").trim().toLowerCase();
    console.log(LP, "Parsed fields:", { name, emailLc, cep, number, street, city, uf, phone, cnpjRaw, codeRaw });

    /* ─── Normaliza e valida CEP ─── */
    const cepDigits = String(cep ?? "").replace(/\D/g, "");
    const cepIsValid = validateCep(cepDigits);
    console.log(LP, "CEP validation:", { cepOriginal: cep, cepDigits, cepIsValid });
    if (!cepIsValid) {
      console.warn(LP, "422 INVALID_CEP", { cepOriginal: cep, cepDigits });
      return new Response(
        JSON.stringify({ code: "INVALID_CEP", message: "CEP inválido" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── Validar/normalizar CNPJ & Code (opcionais) ─── */
    let cnpj: string | null = null;
    let code: string | null = null;
    try {
      cnpj = normalizeCnpj(cnpjRaw);
      code = normalizeCode(codeRaw);
    } catch (valErr: any) {
      const status = valErr.status ?? 422;
      console.warn(LP, "422 INVALID_INPUT (CNPJ/Code normalize failed)", { code: valErr.code, message: valErr.message });
      return new Response(
        JSON.stringify({ code: valErr.code ?? "INVALID_INPUT", message: valErr.message }),
        { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }
    console.log(LP, "Normalized optional fields:", { cnpj, code });

    /* ─── 0) Verifica email duplicado ─── */
    {
      const { data: existing, error: dupErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("email", emailLc)
        .limit(1)
        .maybeSingle();

      console.log(LP, "Duplicate check: email", { emailLc, existing, dupErr });
      if (dupErr) {
        console.error(LP, "EMAIL_CHECK_ERROR:", dupErr);
        return new Response(
          JSON.stringify({ code: "EMAIL_CHECK_ERROR", message: dupErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
      if (existing) {
        console.warn(LP, "409 EMAIL_ALREADY_EXISTS", { emailLc });
        return new Response(
          JSON.stringify({ code: "EMAIL_ALREADY_EXISTS", message: "Restaurante com esse e-mail já existe" }),
          { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    }

    /* ─── 0.1) Verifica CNPJ duplicado (se enviado) ─── */
    if (cnpj) {
      const { data: existingCnpj, error: cnpjErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("cnpj", cnpj)
        .limit(1)
        .maybeSingle();

      console.log(LP, "Duplicate check: cnpj", { cnpj, existingCnpj, cnpjErr });
      if (cnpjErr) {
        console.error(LP, "CNPJ_CHECK_ERROR:", cnpjErr);
        return new Response(
          JSON.stringify({ code: "CNPJ_CHECK_ERROR", message: cnpjErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
      if (existingCnpj) {
        console.warn(LP, "409 CNPJ_ALREADY_EXISTS", { cnpj });
        return new Response(
          JSON.stringify({ code: "CNPJ_ALREADY_EXISTS", message: "Já existe restaurante com este CNPJ" }),
          { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    }

    /* ─── 0.2) Verifica CODE duplicado (se enviado) ─── */
    if (code) {
      const { data: existingCode, error: codeErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("code", code)
        .limit(1)
        .maybeSingle();

      console.log(LP, "Duplicate check: code", { code, existingCode, codeErr });
      if (codeErr) {
        console.error(LP, "CODE_CHECK_ERROR:", codeErr);
        return new Response(
          JSON.stringify({ code: "CODE_CHECK_ERROR", message: codeErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
      if (existingCode) {
        console.warn(LP, "409 CODE_ALREADY_EXISTS", { code });
        return new Response(
          JSON.stringify({ code: "CODE_ALREADY_EXISTS", message: "Já existe restaurante com este código" }),
          { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
        );
      }
    }

    /* ─── 1) Cria usuário (confirmado) ─── */
    const { data: newUser, error: userErr } = await supaAdmin.auth.admin
      .createUser({ email: emailLc, email_confirm: true });

    console.log(LP, "Create user:", { emailLc, userErr, userId: newUser?.user?.id });
    if (userErr) {
      const status = userErr.status ?? 400;
      console.warn(LP, "USER_CREATE_ERROR", { emailLc, status, message: userErr.message });
      return new Response(
        JSON.stringify({ code: "USER_CREATE_ERROR", message: userErr.message }),
        { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    const ownerId = newUser.user?.id;
    if (!ownerId) {
      console.error(LP, "ownerId missing after createUser");
      throw new Error("Falha ao criar usuário");
    }

    /* ─── 2) Gera & envia magic-link ─── */
    try {
      await supaAdmin.auth.signInWithOtp({
        email: emailLc,
        options: { emailRedirectTo: `${APP_URL}/dashboard` },
      });
      console.log(LP, "Magic link sent");
    } catch (linkErr: any) {
      console.error(LP, "MAGIC_LINK_ERROR:", linkErr);
      return new Response(
        JSON.stringify({ code: "MAGIC_LINK_ERROR", message: linkErr.message }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
      );
    }

    /* ─── 3) Geocoding (usar CEP normalizado) ─── */
    console.log(LP, "Geocoding with:", { cepDigits, number });
    const geo = await geocodeByCep(cepDigits, number);
    console.log(LP, "Geocoding result:", geo);

    /* ─── 4) Insere restaurante ─── */
    const insertPayload: any = {
      name,
      phone,
      email:   emailLc,
      street:  street ?? geo.street,
      number:  number,
      city:    city  ?? geo.city,
      uf:      uf    ?? geo.uf,
      cep:     cepDigits,
      lat:     geo.lat,
      lng:     geo.lng,
      status:  "active",
      user_id: ownerId,
    };
    if (cnpj) insertPayload.cnpj = cnpj; // 14 dígitos
    if (code) insertPayload.code = code;

    console.log(LP, "Insert payload (restaurants):", insertPayload);

    const { data: restaurant, error: restErr } = await supaUser
      .from("restaurants")
      .insert(insertPayload)
      .select()
      .single();

    if (restErr) {
      // Tratamento amigável para violação de unicidade
      if ((restErr as any).code === "23505") {
        const msg = (restErr.message ?? "").toLowerCase();
        console.warn(LP, "23505 unique_violation on insert:", msg);
        if (msg.includes("restaurants_cnpj_key") || msg.includes("(cnpj)")) {
          return new Response(
            JSON.stringify({ code: "CNPJ_ALREADY_EXISTS", message: "Já existe restaurante com este CNPJ" }),
            { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
          );
        }
        if (msg.includes("restaurants_code_key") || msg.includes("(code)")) {
          return new Response(
            JSON.stringify({ code: "CODE_ALREADY_EXISTS", message: "Já existe restaurante com este código" }),
            { status: 409, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
          );
        }
      }
      console.error(LP, "Erro inserindo restaurante:", restErr);
      throw restErr;
    }

    /* ─── 5) Liga user ↔ restaurant ─── */
    const linkRes = await supaAdmin
      .from("restaurant_users")
      .upsert({ user_id: ownerId, restaurant_id: restaurant.id, role: "owner" });
    console.log(LP, "restaurant_users upsert:", { error: linkRes.error });

    return new Response(
      JSON.stringify({ id: restaurant.id }),
      { status: 201, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    // Any thrown error that bubbles here
    console.error(LP, "UNHANDLED ERROR:", err);
    const status = err?.status ?? 500;
    const code   = err?.code   ?? "INTERNAL_ERROR";
    return new Response(
      JSON.stringify({ code, message: err?.message ?? "Erro interno" }),
      { status, headers: { ...corsHeaders(req.headers.get("origin") ?? undefined), "Content-Type": "application/json" } }
    );
  }
};

/* ──────────────── Router ──────────────── */
serve({ "/cf_create_restaurant": handler });
