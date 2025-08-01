// functions/_lib/cors.ts
/**
 *  Allowed origins vêm das variáveis de ambiente
 *  definidas no dashboard / GitHub Secrets.
 */
const APP_URL   = Deno.env.get("APP_URL")   ?? "";   // e.g. https://app.cf.org
const ADMIN_URL = Deno.env.get("ADMIN_URL") ?? "";   // e.g. https://admin.cf.org

const ALLOWED = new Set(
  [APP_URL, ADMIN_URL].filter(Boolean)         // remove vazios
);

/** Gera cabeçalhos CORS para um origin específico (ou bloqueia) */
export function corsHeaders(origin: string | null): HeadersInit {
  if (origin && ALLOWED.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, x-client-info, apikey",
      "Access-Control-Allow-Credentials": "true",
    };
  }
  // → origin não permitido → sem CORS (browser bloqueará)
  return {};
}

/** Pré-flight helper */
export function handleCors(req: Request): Response | undefined {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }
  return undefined;
}
