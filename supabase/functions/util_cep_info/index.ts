import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { validateCep, fetchCepInfo } from "$lib/cep.ts";

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const cep = new URL(req.url).searchParams.get("cep")?.replace(/\D/g, "") ?? "";
  if (!validateCep(cep)) {
    return new Response("CEP inválido", { status: 422, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    const info = await fetchCepInfo(cep);
    return new Response(JSON.stringify(info), {
      status: 200,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });
  } catch {
    return new Response("CEP não encontrado", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }
});
