// functions/_lib/cors.ts

/**
 *  Secrets definidas no Supabase:
 *    APP_URL   = https://app.cf.org
 *    ADMIN_URL = https://admin-cf.netlify.app
 */
const APP_URL   = Deno.env.get("APP_URL")   ?? "";
const ADMIN_URL = Deno.env.get("ADMIN_URL") ?? "";

/** Remove espaços, barras finais e força minúsculas */
function normalize(url = ""): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** Conjunto de origens explicitamente permitidas */
const ALLOWED = new Set(
  [APP_URL, ADMIN_URL].filter(Boolean).map(normalize)
);

/** Regex para pré-views do Netlify:  https://algo--admin-cf.netlify.app */
const NETLIFY_PREVIEW = /^https:\/\/.*--admin-cf\.netlify\.app$/i;

/** Verifica se a origem é aceita */
function isAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const norm = normalize(origin);
  return ALLOWED.has(norm) || NETLIFY_PREVIEW.test(norm);
}

/** Gera cabeçalhos CORS (ou vazio, se não permitido) */
export function corsHeaders(origin: string | null): HeadersInit {
  if (isAllowed(origin)) {
    return {
      "Access-Control-Allow-Origin": origin!,          // ecoa a origem exata
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, x-client-info, apikey",
      "Access-Control-Allow-Credentials": "true",
    };
  }
  return {}; // bloqueado → browser vai recusar
}

/** Pré-flight helper (responde a OPTIONS) */
export function handleCors(req: Request): Response | undefined {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req.headers.get("origin")),
    });
  }
  return undefined;
}
