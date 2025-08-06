// supabase/functions/restaurant_create_donation/index.ts
// Edge Function — restaurante libera um pacote (cria doação) e envia notificação

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* ──────────────── Service-role client (notificação) ──────────────── */
const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS + método --------------------------------------------------- */
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    /* ---------- JWT ------------------------------------------------ */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) {
      return new Response(
        JSON.stringify({ code: "MISSING_JWT", message: "JWT não fornecido" }),
        { status: 401, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
      );
    }

    /* ---------- User-scoped client (respeita RLS) ------------------ */
    const supaUser = createClient(
      SUPABASE_URL,
      ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );

    /* ---------- Body ---------------------------------------------- */
    const { restaurant_id } = await req.json();
    if (!restaurant_id) {
      return new Response(
        JSON.stringify({ code: "MISSING_RESTAURANT_ID", message: "restaurant_id ausente" }),
        { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
      );
    }

    /* ---------- RPC release_donation_safe -------------------------- */
    const { data, error } = await supaUser.rpc("release_donation_safe", {
      p_restaurant_id: restaurant_id,
    });

    if (error) {
      const map: Record<string, { status: number; msg: string }> = {
        NO_PACKAGES_IN_STOCK: { status: 409, msg: "Não há pacotes em estoque para liberar." },
        RESTAURANT_NOT_FOUND: { status: 404, msg: "Restaurante não encontrado." },
        NO_OSC_AVAILABLE:    { status: 404, msg: "Nenhuma OSC ativa disponível." },
      };
      const found = map[error.message];
      if (found) {
        return new Response(
          JSON.stringify({ code: error.message, message: found.msg }),
          { status: found.status, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
        );
      }
      throw error; // erro inesperado
    }

    const { donation_id, security_code } = (data as any)[0];

    /* ---------- Notificação --------------------------------------- */
    await supaAdmin.functions.invoke("util_send_notifications", {
      body: { donation_id, security_code },
    });

    /* ---------- Response ------------------------------------------ */
    return new Response(
      JSON.stringify({ donation_id, security_code }),
      { status: 200, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
    );

  } catch (err: any) {
    console.error("restaurant_create_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
      { status: 500, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
    );
  }
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  "/restaurant_create_donation": handler,
});

/* Endpoint final:
   POST https://<project>.supabase.co/functions/v1/restaurant_create_donation
*/
