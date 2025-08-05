import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { geocodeByCep } from "$lib/geocode.ts";
import { validateCep }  from "$lib/cep.ts";
import { validateCnpj } from "$lib/cnpj.ts";

const supa      = createClient(Deno.env.get("SUPABASE_URL")!,  Deno.env.get("SUPABASE_ANON_KEY")!);
const supaAdmin = createClient(Deno.env.get("SUPABASE_URL")!,  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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

    const {
      name, cnpj, email, cep, number, street, city, uf,
      responsible_name, phone,
    } = await req.json();

    if (!validateCep(cep))   return new Response("CEP inválido",  { status: 422, headers: corsHeaders(req.headers.get("origin")) });
    if (!validateCnpj(cnpj)) return new Response("CNPJ inválido", { status: 422, headers: corsHeaders(req.headers.get("origin")) });

    /* Dup check */
    const dup = await supaAdmin.from("osc")
      .select("id")
      .or(`cnpj.eq.${cnpj},email.ilike.${email ?? ""}`)
      .maybeSingle();
    if (dup) return new Response("OSC já existe", { status: 409, headers: corsHeaders(req.headers.get("origin")) });

    const geo = await geocodeByCep(cep, number);

    const { error } = await supaAdmin.from("osc").insert({
      name, cnpj, email, phone, responsible_name,
      street: street ?? geo.street, number,
      city:   city   ?? geo.city,   uf: uf ?? geo.uf,
      cep, lat: geo.lat, lng: geo.lng, status: "active",
    });
    if (error) throw error;

    return new Response("OSC criada", { status: 201, headers: corsHeaders(req.headers.get("origin")) });

  } catch (err: any) {
    console.error("cf_create_osc ERROR:", err);
    return new Response(JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }), {
      status: 500,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });
  }
});

/* ──────────────── Rotas ────────────────
   /util_cep_info  → runtime regional  (/functions/v1/…)
   /util-cep-info  → runtime global    (.functions.supabase.co/…)
*/
serve({
  "/cf_create_osc": handler,
  "/cf-create-osc": handler,
});
