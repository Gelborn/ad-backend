import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { validateCep, fetchCepInfo } from "$lib/cep.ts";

/** Aceita POST JSON { cep: "01310200" } ou GET ?cep=01310200 */
async function handler(req: Request): Promise<Response> {
  // CORS pre-flight
  const cors = handleCors(req);
  if (cors) return cors;

  /* ───────────── 1. Obtém CEP ───────────── */
  let cep = "";
  if (req.method === "POST") {
    // Supabase Edge Functions => Content-Type: application/json
    try {
      const { cep: bodyCep } = await req.json();
      cep = (bodyCep ?? "").toString();
    } catch {
      /* corpo inválido → cai na validação logo abaixo */
    }
  } else {
    // GET /util_cep_info?cep=01310200
    cep = new URL(req.url).searchParams.get("cep") ?? "";
  }

  cep = cep.replace(/\D/g, ""); // só dígitos

  /* ───────────── 2. Valida ───────────── */
  if (!validateCep(cep)) {
    return new Response("CEP inválido", {
      status: 422,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }

  /* ───────────── 3. Consulta ViaCEP ───────────── */
  try {
    const info = await fetchCepInfo(cep);
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: {
        ...corsHeaders(req.headers.get("origin")),
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("ViaCEP error:", err);
    return new Response("CEP não encontrado", {
      status: 404,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }
}

/* Rotas (regional e global). 
   Se sua função tiver apenas esse handler,
   dá pra exportar direto: `serve(handler)`. */
serve({
  "/util_cep_info": handler,
});
