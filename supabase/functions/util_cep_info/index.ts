import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { validateCep, fetchCepInfo } from "$lib/cep.ts";

async function handler(req: Request): Promise<Response> {
  // Pré-flight (OPTIONS)
  const cors = handleCors(req);
  if (cors) return cors;

  // 1️⃣ Extrai CEP da querystring
  const cep = new URL(req.url).searchParams.get("cep")?.replace(/\D/g, "") ?? "";

  // 2️⃣ Valida antes de consultar
  if (!validateCep(cep)) {
    return new Response("CEP inválido", {
      status: 422,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }

  try {
    // 3️⃣ Consulta ViaCEP
    const info = await fetchCepInfo(cep);
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: {
        ...corsHeaders(req.headers.get("origin")),
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("Erro ViaCEP:", err);
    return new Response("CEP não encontrado", {
      status: 404,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }
}

/* Rotas (regional/global) */
serve({
  "/util_cep_info": handler,
  "/util-cep-info": handler,
});
