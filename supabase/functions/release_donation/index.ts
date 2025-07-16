import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/release_donation": async (req: Request) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    // 1) pega JWT do restaurante
    const auth = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!auth) return new Response("Missing authorization header", { status: 401 });

    // 2) init Supabase com Service Role e passa o JWT do restaurante
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: `Bearer ${auth}` } }
    });

    // 3) lê security_code
    const { security_code } = await req.json();
    if (!security_code) return new Response("Missing security_code", { status: 400 });

    // 4) faz UPDATE só se o restaurante dono estiver autenticado
    const { data, error } = await supa
      .from("donations")
      .update({ status: "released", released_at: new Date().toISOString() })
      .eq("security_code", security_code)
      .eq("status", "accepted")
      .select("id,restaurant_id,osc_id,status");

    if (error) return new Response(error.message, { status: 400 });
    if (!data?.length) return new Response("Donation not found or wrong status", { status: 404 });

    const donation = data[0];

    // 5) retorna detalhes + pacote_ids
    const { data: pkgs, error: pErr } = await supa
      .from("donation_packages")
      .select("package_id")
      .eq("donation_id", donation.id);
    if (pErr) return new Response(pErr.message, { status: 400 });

    return new Response(JSON.stringify({
      donation_id:   donation.id,
      restaurant_id: donation.restaurant_id,
      osc_id:        donation.osc_id,
      status:        donation.status,
      package_ids:   pkgs.map(p => p.package_id)
    }), { headers: { "Content-Type": "application/json" } });
  }
});
