import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* Supabase client que RESPEITA RLS (Anon Key) */
const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!
);

serve(async (req) => {
  /* ---------------- CORS ---------------- */
  const cors = handleCors(req);
  if (cors) return cors;
  const origin = req.headers.get("origin");

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(origin) });
  }

  /* ---------------- Auth (CF admin) ---------------- */
  const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!jwt) {
    return new Response("Auth required", { status: 401, headers: corsHeaders(origin) });
  }
  supa.auth.setAuth(jwt);
  const { data: isCf } = await supa.rpc("is_cf");
  if (!isCf) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
  }

  /* ---------------- Body ---------------- */
  const { restaurant_id, osc_id, is_favorite = false } = await req.json();
  if (!restaurant_id || !osc_id) {
    return new Response("Missing restaurant_id or osc_id", {
      status: 400,
      headers: corsHeaders(origin),
    });
  }

  try {
    /* 1) Remove favorito anterior (se for o caso) */
    if (is_favorite) {
      await supa
        .from("partnerships")
        .update({ is_favorite: false })
        .eq("restaurant_id", restaurant_id);
    }

    /* 2) Upsert da parceria */
    await supa.from("partnerships").upsert(
      [{ restaurant_id, osc_id, is_favorite }],
      { onConflict: "restaurant_id,osc_id" }
    );

    /* 3) Retorna lista atualizada (opcional) */
    const { data } = await supa
      .from("partnerships")
      .select("*")
      .eq("restaurant_id", restaurant_id);

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });

  } catch (e: any) {
    /* ---------- Tratamento de FK (23503) ---------- */
    if (e.code === "23503") {
      const friendly =
        e.message.includes("restaurant_id")
          ? "Restaurante não encontrado"
        : e.message.includes("osc_id")
          ? "OSC não encontrada"
        : "Entidade inexistente";

      return new Response(friendly, {
        status: 404,
        headers: { ...corsHeaders(origin), "Content-Type": "text/plain" },
      });
    }

    /* ---------- Qualquer outro erro ---------- */
    console.error("cf_create_partnership ERROR:", e);
    return new Response(e.message, {
      status: 400,
      headers: { ...corsHeaders(origin), "Content-Type": "text/plain" },
    });
  }
});

/* ──────────────── Rotas ────────────────
   /cf_create_partnership  → runtime regional  (/functions/v1/…)
   /cf-create-partnership  → runtime global    (.functions.supabase.co/…)
*/
serve({
  "/cf_create_partnership": handler,
  "/cf-create-partnership": handler,
});