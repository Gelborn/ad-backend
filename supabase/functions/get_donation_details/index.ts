// supabase/functions/get_donation_details/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve({
  "/get_donation_details": async (req: Request) => {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "apikey, Content-Type, x-client-info",
    };

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: CORS });
    }

    // Parse body
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: CORS });
    }
    const { security_code } = body;
    if (!security_code) {
      return new Response("Missing security_code", { status: 400, headers: CORS });
    }

    // Instancia supa com service role
    const supa = createClient(SUPA_URL, SERVICE_KEY);

    // 1) Busca dados básicos da doação
    const { data: donation, error: dErr } = await supa
      .from("donations")
      .select("id, status, created_at, restaurant_id")
      .eq("security_code", security_code)
      .single();
    if (dErr || !donation) {
      return new Response("Donation not found", { status: 404, headers: CORS });
    }

    // 2) Busca nome do restaurante
    const { data: rest, error: rErr } = await supa
      .from("restaurants")
      .select("name")
      .eq("id", donation.restaurant_id)
      .single();
    if (rErr || !rest) {
      return new Response("Restaurant not found", { status: 404, headers: CORS });
    }

    // 3) Busca TODOS os pacotes + item associado
    const { data: pkgRows, error: pErr } = await supa
      .from("donation_packages")
      .select(`
        package_id,
        packages (
          id,
          quantity,
          created_at,
          expires_at,
          status,
          items (
            id,
            name,
            description,
            unit
          )
        )
      `)
      .eq("donation_id", donation.id);
    if (pErr) {
      return new Response("Error fetching packages", { status: 500, headers: CORS });
    }

    // 4) Formata o array de pacotes
    const packages = (pkgRows || []).map((row: any) => ({
      id:            row.packages.id,
      quantity:      row.packages.quantity,
      status:        row.packages.status,
      created_at:    row.packages.created_at,
      expires_at:    row.packages.expires_at,
      item: {
        id:          row.packages.items.id,
        name:        row.packages.items.name,
        description: row.packages.items.description,
        unit:        row.packages.items.unit,
      }
    }));

    // 5) Retorna tudo
    const result = {
      id:             donation.id,
      status:         donation.status,
      created_at:     donation.created_at,
      restaurant:     rest.name,
      security_code,
      packages,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  },
});
