import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { validateCep, fetchCepInfo } from "$lib/cep.ts";

/** Handler principal ─ faz CORS + validação + fetch */
async function handler(req: Request): Promise<Response> {
  // Pré-flight (OPTIONS)
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const info = await fetchCepInfo(cep);
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: {
        ...corsHeaders(req.headers.get("origin")),
        "Content-Type": "application/json",
      },
    });
  } catch {
    return new Response("CEP não encontrado", {
      status: 404,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }
}

/* ──────────────── Rotas ────────────────
   /util_cep_info  → runtime regional  (/functions/v1/…)
   /util-cep-info  → runtime global    (.functions.supabase.co/…)
*/
serve({
  "/util_cep_info": handler,
  "/util-cep-info": handler,
});
