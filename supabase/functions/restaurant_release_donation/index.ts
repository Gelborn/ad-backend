import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ------------------------------------------------------------------ */
/*  CLIENTS                                                           */
/* ------------------------------------------------------------------ */
const supaUser = createClient(                              // respeita RLS
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!
);

serve(async (req) => {
  /* CORS pre-flight */
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    /* --- JWT do restaurante ---------------------------------------- */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) {
      return new Response(
        JSON.stringify({ code: "MISSING_JWT", message: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } }
      );
    }
    supaUser.auth.setAuth(jwt);

    /* --- Body ------------------------------------------------------ */
    const { security_code } = await req.json();
    if (!security_code) {
      return new Response(
        JSON.stringify({ code: "MISSING_CODE", message: "Missing security_code" }),
        { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } }
      );
    }

    /* --- Update donation (RLS garante escopo do restaurante) ------ */
    const now = new Date().toISOString();
    const { data: rows, error: updErr } = await supaUser
      .from("donations")
      .update({ status: "picked_up", picked_up_at: now })
      .eq("security_code", security_code)
      .eq("status", "accepted")
      .select("id, restaurant_id, osc_id, status, created_at, released_at");

    if (updErr) {
      return new Response(
        JSON.stringify({ code: "UPDATE_ERROR", message: updErr.message }),
        { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } }
      );
    }
    if (!rows?.length) {
      return new Response(
        JSON.stringify({ code: "NOT_FOUND_OR_WRONG_STATUS", message: "Donation not found or wrong status" }),
        { status: 404, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } }
      );
    }
    const donation = rows[0];

    /* --- Extra data (nome restaurante / OSC / pacotes) ------------- */
    const [{ data: rest }, { data: osc }] = await Promise.all([
      supaUser.from("restaurants").select("name").eq("id", donation.restaurant_id).single(),
      supaUser.from("osc").select("name").eq("id", donation.osc_id).single(),
    ]);

    const { data: pkgRows } = await supaUser
      .from("donation_packages")
      .select(`
        package_id,
        packages (
          id, quantity, status, created_at, label_code, expires_at,
          items ( id, name, description, unit )
        )
      `)
      .eq("donation_id", donation.id);

    const packages = (pkgRows ?? []).map((row: any) => ({
      id:         row.packages.id,
      quantity:   row.packages.quantity,
      status:     row.packages.status,
      created_at: row.packages.created_at,
      label_code: row.packages.label_code,
      expires_at: row.packages.expires_at,
      item:       row.packages.items,
    }));

    /* --- Resposta -------------------------------------------------- */
    return new Response(JSON.stringify({
      donation_id: donation.id,
      status:      donation.status,
      created_at:  donation.created_at,
      released_at: donation.released_at,
      restaurant:  rest?.name ?? null,
      osc:         osc?.name  ?? null,
      packages,
    }), {
      status: 200,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("‼ restaurant_release_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
      { status: 500, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } }
    );
  }
});
