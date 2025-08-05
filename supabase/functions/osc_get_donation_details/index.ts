import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";

/* service-role → ignora RLS, leitura garantida */
const supa = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  /* --- CORS / pre-flight ---------------------------------------------- */
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* --- Body ------------------------------------------------------------ */
  let body: { security_code?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }
  const { security_code } = body;
  if (!security_code) {
    return new Response("Missing security_code", { status: 400, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* --- 1) Donation ----------------------------------------------------- */
  const { data: donation, error: dErr } = await supa
    .from("donations")
    .select("id, status, created_at, restaurant_id")
    .eq("security_code", security_code)
    .single();
  if (dErr || !donation) {
    return new Response("Donation not found", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* --- 2) Restaurant name --------------------------------------------- */
  const { data: rest, error: rErr } = await supa
    .from("restaurants")
    .select("name")
    .eq("id", donation.restaurant_id)
    .single();
  if (rErr || !rest) {
    return new Response("Restaurant not found", { status: 404, headers: corsHeaders(req.headers.get("origin")) });
  }

  /* --- 3) Packages + item --------------------------------------------- */
  const { data: pkgRows, error: pErr } = await supa
    .from("donation_packages")
    .select(`
      package_id,
      packages (
        id, quantity, created_at, expires_at, status,
        items ( id, name, description, unit )
      )
    `)
    .eq("donation_id", donation.id);
  if (pErr) {
    return new Response("Error fetching packages", { status: 500, headers: corsHeaders(req.headers.get("origin")) });
  }

  const packages = (pkgRows ?? []).map((row: any) => ({
    id:         row.packages.id,
    quantity:   row.packages.quantity,
    status:     row.packages.status,
    created_at: row.packages.created_at,
    expires_at: row.packages.expires_at,
    item: {
      id:          row.packages.items.id,
      name:        row.packages.items.name,
      description: row.packages.items.description,
      unit:        row.packages.items.unit,
    },
  }));

  /* --- 4) Response ----------------------------------------------------- */
  const result = {
    id:          donation.id,
    status:      donation.status,
    created_at:  donation.created_at,
    restaurant:  rest.name,
    security_code,
    packages,
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
  });
});
