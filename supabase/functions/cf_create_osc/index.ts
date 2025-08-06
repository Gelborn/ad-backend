// supabase/functions/cf_create_osc/index.ts
// Edge Function — cria nova OSC (acesso: CF admin)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { geocodeByCep } from "$lib/geocode.ts";
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
    const supaUser = createClient(
      SUPABASE_URL,
      ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );
    const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

    const { data: isCf } = await supaUser.rpc("is_cf");
    if (!isCf) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
    }

    /* ---------- Body ---------- */
    const {
      name, cnpj, email, cep, number,
      street, city, uf, responsible_name, phone,
    } = await req.json();

    if (!validateCep(cep))   return new Response("CEP inválido",  { status: 422, headers: corsHeaders(origin) });
    if (!validateCnpj(cnpj)) return new Response("CNPJ inválido", { status: 422, headers: corsHeaders(origin) });

    /* ---------- Duplicidade ---------- */
    const { data: dup } = await supaAdmin
      .from("osc")
      .select("id")
      .or(`cnpj.eq.${cnpj},email.ilike.${email ?? ""}`)
      .maybeSingle();

    if (dup) {
      return new Response("OSC já existe", { status: 409, headers: corsHeaders(origin) });
    }

    /* ---------- Geocoding ---------- */
    const geo = await geocodeByCep(cep, number);

    /* ---------- Insert ---------- */
    const { error } = await supaAdmin.from("osc").insert({
      name, cnpj, email, phone, responsible_name,
      street: street ?? geo.street,
      number,
      city:   city   ?? geo.city,
      uf:     uf     ?? geo.uf,
      cep,
      lat: geo.lat,
      lng: geo.lng,
      status: "active",
    });
    if (error) throw error;

    return new Response("OSC criada", { status: 201, headers: corsHeaders(origin) });

  } catch (err: any) {
    console.error("cf_create_osc ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
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
