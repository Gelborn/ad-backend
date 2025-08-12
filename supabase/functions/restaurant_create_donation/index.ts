// supabase/functions/restaurant_create_donation/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* ──────────────── Clients ──────────────── */
const supaAdmin = createClient(SUPABASE_URL, SRV_KEY);

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin") ?? "*";

  // CORS / preflight
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(origin) });
  }

  try {
    console.log("→ restaurant_create_donation invoked");

    /* ---------- JWT ------------------------------------------------ */
    const authHeader = req.headers.get("authorization");
    const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    if (!jwt) {
      return new Response(
        JSON.stringify({ code: "MISSING_JWT", message: "JWT não fornecido" }),
        { status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    /* ---------- User-scoped client (RLS) --------------------------- */
    const supaUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    /* ---------- Body ---------------------------------------------- */
    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ code: "INVALID_JSON", message: "Body inválido" }),
        { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }
    const { restaurant_id } = payload ?? {};
    if (!restaurant_id) {
      return new Response(
        JSON.stringify({ code: "MISSING_RESTAURANT_ID", message: "restaurant_id ausente" }),
        { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
      );
    }

    /* ---------- RPC (new) ----------------------------------------- */
    const { data, error } = await supaUser.rpc("release_donation_partnered", {
      p_restaurant_id: restaurant_id,
    });

    if (error) {
      console.error("RPC error:", error);
      const map: Record<string, { status: number; msg: string }> = {
        NO_PACKAGES_IN_STOCK: { status: 409, msg: "Não há pacotes em estoque para liberar." },
        RESTAURANT_NOT_FOUND: { status: 404, msg: "Restaurante não encontrado." },
        NO_OSC_AVAILABLE:     { status: 404, msg: "Nenhuma OSC disponível no raio configurado." },
      };
      const found = map[error.message];
      if (found) {
        return new Response(
          JSON.stringify({ code: error.message, message: found.msg }),
          { status: found.status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
        );
      }
      throw error; // erro inesperado
    }

    const row = Array.isArray(data) ? data[0] : data;
    const { donation_id, security_code, osc_id, osc_name, osc_address, distance_km } = row || {};
    console.log("RPC OK → donation_id:", donation_id, "osc_id:", osc_id);

    /* ---------- Notificação --------------------------------------- */
    try {
      await supaAdmin.functions.invoke("util_send_notifications", {
        body: { security_code },
        headers: { "x-internal-key": Deno.env.get("FUNCTIONS_INTERNAL_KEY")! },
      });
      console.log("Notifications invoked");
    } catch (notifyErr) {
      console.error("Notification invoke failed:", notifyErr);
      // segue mesmo se notificação falhar
    }

    /* ---------- Response ------------------------------------------ */
    return new Response(
      JSON.stringify({
        donation_id,
        security_code,
        osc: {
          id: osc_id,
          name: osc_name,
          address: osc_address,
          distance_km,
        },
      }),
      { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("restaurant_create_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err?.message ?? "Unknown error" }),
      { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
    );
  }
};

/* ──────────────── Router ──────────────── */
/* In Supabase, the request hits "/" inside the function. Keep both for safety. */
serve({
  "/": handler,
  "/restaurant_create_donation": handler, // handy for local/manual testing
});
