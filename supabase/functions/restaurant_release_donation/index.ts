// supabase/functions/restaurant_release_donation/index.ts
// Edge Function — restaurante confirma retirada (atomic via RPC)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

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
        JSON.stringify({ code: "MISSING_JWT", message: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
      );
    }

    /* ---------- User-scoped client (RLS respected) ----------------- */
    const supaUser = createClient(
      SUPABASE_URL,
      ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );

    /* ---------- Body ---------------------------------------------- */
    const { security_code } = await req.json();
    if (!security_code) {
      return new Response(
        JSON.stringify({ code: "MISSING_CODE", message: "Missing security_code" }),
        { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
      );
    }

    /* ---------- 1) Atomic pickup via RPC -------------------------- */
    const { data: picked, error: rpcErr } = await supaUser
      .rpc("donation_mark_picked_up", { p_security_code: security_code });

    if (rpcErr) {
      const msg = rpcErr.message || "";
      if (msg.includes("INTENT_NOT_FOUND")) {
        return new Response(
          JSON.stringify({ code: "INTENT_NOT_FOUND", message: "Donation intent not found" }),
          { status: 404, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
        );
      }
      if (msg.includes("WRONG_STATUS")) {
        return new Response(
          JSON.stringify({ code: "WRONG_STATUS", message: "Donation not accepted or wrong status" }),
          { status: 409, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
        );
      }
      // Generic DB error
      return new Response(
        JSON.stringify({ code: "DB_ERROR", message: msg }),
        { status: 400, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
      );
    }

    // The RPC returns exactly one row
    const row = Array.isArray(picked) ? picked[0] : picked;
    if (!row) {
      // Extremely unlikely, but be safe
      return new Response(
        JSON.stringify({ code: "DB_ERROR", message: "No data returned by RPC" }),
        { status: 500, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
      );
    }

    const donationId   = row.donation_id as string;
    const restaurantId = row.restaurant_id as string;
    const oscId        = row.osc_id as string;

    /* ---------- 2) Enrich (names + packages now delivered) -------- */
    const [{ data: rest }, { data: osc }] = await Promise.all([
      supaUser.from("restaurants").select("name").eq("id", restaurantId).single(),
      supaUser.from("osc").select("name").eq("id", oscId).single(),
    ]);

    const { data: pkgRows } = await supaUser
      .from("donation_packages")
      .select(`
        package_id,
        packages (
          id, quantity, status, created_at, label_code, expires_at,
          items ( id, name, description, unit, unit_to_kg )
        )
      `)
      .eq("donation_id", donationId);

    const packages = (pkgRows ?? []).map((row: any) => ({
      id:         row.packages.id,
      quantity:   row.packages.quantity,
      status:     row.packages.status, // now 'delivered'
      created_at: row.packages.created_at,
      label_code: row.packages.label_code,
      expires_at: row.packages.expires_at,
      item: {
        id:          row.packages.items?.id,
        name:        row.packages.items?.name,
        description: row.packages.items?.description,
        unit:        row.packages.items?.unit,
      },
    }));

    /* ---------- 3) Fetch donation summary for response ------------ */
    const { data: donationRow } = await supaUser
      .from("donations")
      .select("id, status, created_at, released_at")
      .eq("id", donationId)
      .single();

    /* ---------- 4) Response (same contract) ----------------------- */
    return new Response(JSON.stringify({
      donation_id: donationRow?.id,
      status:      donationRow?.status,      // 'picked_up'
      created_at:  donationRow?.created_at,
      released_at: donationRow?.released_at,
      restaurant:  rest?.name ?? null,
      osc:         osc?.name  ?? null,
      packages,
    }), {
      status: 200,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("restaurant_release_donation ERROR:", err);
    return new Response(
      JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
      { status: 500, headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" } },
    );
  }
};

/* ──────────────── Router (único serve) ──────────────── */
serve({ "/restaurant_release_donation": handler });
