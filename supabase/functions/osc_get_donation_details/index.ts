// supabase/functions/osc_get_donation_details/index.ts
// Edge Function — devolve detalhes completos da doação para a OSC (via donation_intents)

import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* ──────────────── Env & client (service-role) ──────────────── */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SRV_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supa         = createClient(SUPABASE_URL, SRV_KEY);

type IntentStatus = "waiting_response" | "accepted" | "denied" | "expired" | "re_routed";

/** Normaliza o status para manter o contrato de resposta anterior */
function mapIntentToDonationStatus(s: IntentStatus) {
  switch (s) {
    case "waiting_response": return "pending";
    case "accepted":         return "accepted";
    case "denied":           return "denied";
    case "expired":          return "expired";
    case "re_routed":        return "re_routed";
    default:                 return "pending";
  }
}

/* ──────────────── Handler ──────────────── */
const handler = async (req: Request): Promise<Response> => {
  /* CORS + método --------------------------------------------------- */
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- Body ------------------------------------------------- */
  let body: { security_code?: string };
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }
  const { security_code } = body;
  if (!security_code) {
    return new Response("Missing security_code", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- 1) Intent + Donation (fonte da verdade = donation_intents) ---- */
  const { data: intentRow, error: iErr } = await supa
    .from("donation_intents")
    .select(`
      id,
      status,
      donation_id,
      security_code,
      expires_at,
      donations!inner (
        id, status, created_at, restaurant_id
      )
    `)
    .eq("security_code", security_code)
    .single();

  if (iErr || !intentRow) {
    return new Response("Donation intent not found", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }

  const donation = intentRow.donations;
  if (!donation) {
    return new Response("Donation not found", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }

  const resolvedStatus = mapIntentToDonationStatus(intentRow.status as IntentStatus);

  /* ---------- 2) Restaurant --------------------------------------- */
  const { data: rest, error: rErr } = await supa
    .from("restaurants")
    .select("name")
    .eq("id", donation.restaurant_id)
    .single();

  if (rErr || !rest) {
    return new Response("Restaurant not found", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* ---------- 3) Packages + item ---------------------------------- */
  const { data: pkgRows, error: pErr } = await supa
    .from("donation_packages")
    .select(`
      package_id,
      packages (
        id, quantity, created_at, expires_at, status,
        items ( id, name, description, unit, unit_to_kg )
      )
    `)
    .eq("donation_id", donation.id);

  if (pErr) {
    return new Response("Error fetching packages", { status: 500, headers: corsHeaders(req.headers.get("origin")) });
  }

  const packages = (pkgRows ?? []).map((row: any) => {
    const pkg = row.packages;
    const item = pkg.items;
    const isUnit = item?.unit === "unit";
    const totalKg = isUnit ? (Number(pkg.quantity) * Number(item?.unit_to_kg ?? 0)) : Number(pkg.quantity);

    return {
      id:         pkg.id,
      quantity:   pkg.quantity,
      status:     pkg.status,
      created_at: pkg.created_at,
      expires_at: pkg.expires_at,
      total_kg:   totalKg,
      item: {
        id:          item?.id,
        name:        item?.name,
        description: item?.description,
        unit:        item?.unit,
      },
    };
  });

  /* ---------- 4) Response (contrato preservado) -------------------- */
  const result = {
    id:           donation.id,
    status:       resolvedStatus,         // ← agora vem do intent
    created_at:   donation.created_at,
    restaurant:   rest.name,
    security_code,
    expires_at:   intentRow.expires_at,
    packages,
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
  });
};

/* ──────────────── Router (único serve) ──────────────── */
serve({
  "/osc_get_donation_details": handler,
});

/* Endpoint:
   POST https://<project>.supabase.co/functions/v1/osc_get_donation_details
*/
