// supabase/functions/cf_create_osc/index.ts
// Edge Function — cria nova OSC (acesso: CF admin)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { geocodeByCep, GeocodeInput } from "$lib/geocode.ts";
import { validateCep }  from "$lib/cep.ts";
import { validateCnpj } from "$lib/cnpj.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS + método */
  const cors = handleCors(req);
  if (cors) return cors;
  const origin = req.headers.get("origin");

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(origin) });
  }

  try {
    /* ---------- Auth (CF admin) ---------- */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) {
      return new Response("Auth required", { status: 401, headers: corsHeaders(origin) });
    }
    const supaUser  = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

    const { data: isCf, error: isCfErr } = await supaUser.rpc("is_cf");
    if (isCfErr || !isCf) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
    }

    /* ---------- Body ---------- */
    const body = await req.json();
    const {
      name,
      cnpj,
      email,
      phone,
      responsible_name,

      // endereço — todos obrigatórios
      cep,
      number,
      street,
      city,
      uf,
    } = body ?? {};

    const emailLc = String(email ?? "").trim().toLowerCase();

    // Required checks
    if (!name || !emailLc || !cnpj || !phone || !responsible_name ||
        !cep || !number || !street || !city || !uf) {
      return new Response(
        JSON.stringify({ code: "INVALID_INPUT", message: "Campos obrigatórios ausentes" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    // CEP pattern (8 dígitos)
    const cepDigits = String(cep).replace(/\D/g, "");
    if (!validateCep(cepDigits)) {
      return new Response(
        JSON.stringify({ code: "INVALID_CEP", message: "CEP inválido" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    // CNPJ válido
    if (!validateCnpj(cnpj)) {
      return new Response(
        JSON.stringify({ code: "INVALID_CNPJ", message: "CNPJ inválido" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    /* ---------- Duplicidade (email ou cnpj) ---------- */
    {
      const { data: dup, error: dupErr } = await supaAdmin
        .from("osc")
        .select("id")
        .or(`cnpj.eq.${cnpj},email.ilike.${emailLc}`)
        .maybeSingle();

      if (dupErr) {
        return new Response(
          JSON.stringify({ code: "DUP_CHECK_ERROR", message: dupErr.message }),
          { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
        );
      }
      if (dup) {
        return new Response("OSC já existe", { status: 409, headers: corsHeaders(origin) });
      }
    }

    /* ---------- Geocoding (coords only; confia nos campos do front) ---------- */
    let geo;
    try {
      const gInput: GeocodeInput = {
        cep: cepDigits,
        number,
        street,
        city,
        uf,
      };
      geo = await geocodeByCep(gInput);

      const hasLat = geo && typeof geo.lat === "number";
      const hasLng = geo && typeof geo.lng === "number";
      if (!hasLat || !hasLng) {
        return new Response(
          JSON.stringify({ code: "GEOCODE_NO_COORDS", message: "Não foi possível obter coordenadas do endereço/CEP" }),
          { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
        );
      }
    } catch (e: any) {
      return new Response(
        JSON.stringify({ code: "GEOCODE_ERROR", message: e?.message ?? "Falha ao geocodificar CEP" }),
        { status: 422, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    /* ---------- Insert ---------- */
    const { error } = await supaAdmin.from("osc").insert({
      name,
      cnpj,
      email: emailLc,
      phone,
      responsible_name,
      street,
      number,
      city,
      uf,
      cep: cepDigits,
      lat: geo.lat,
      lng: geo.lng,
      status: "active",
    });
    if (error) {
      return new Response(
        JSON.stringify({ code: "INSERT_ERROR", message: error.message }),
        { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    return new Response("OSC criada", { status: 201, headers: corsHeaders(origin) });

  } catch (err: any) {
    console.error("cf_create_osc ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err?.message ?? "Unknown error" }),
      { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
    );
  }
};

/* ──────────────── Router ──────────────── */
serve({
  "/cf_create_osc": handler,   // runtime regional (/functions/v1/…)
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/cf_create_osc
*/
