// supabase/functions/release_donation/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/release_donation": async (req: Request) => {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, x-client-info, apikey",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: CORS });
    }

    try {
      const auth = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!auth) {
        return new Response(
          JSON.stringify({ code: "MISSING_JWT", message: "Missing authorization header" }),
          { status: 401, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
        global: { headers: { Authorization: `Bearer ${auth}` } }
      });

      const { security_code } = await req.json();
      if (!security_code) {
        return new Response(
          JSON.stringify({ code: "MISSING_CODE", message: "Missing security_code" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      const now = new Date().toISOString();
      const { data: donationRows, error: updErr } = await supa
        .from("donations")
        .update({ status: "picked_up", picked_up_at: now })
        .eq("security_code", security_code)
        .eq("status", "accepted")
        .select("id, restaurant_id, osc_id, status, created_at, released_at");
      if (updErr) {
        return new Response(
          JSON.stringify({ code: "UPDATE_ERROR", message: updErr.message }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      if (!donationRows?.length) {
        return new Response(
          JSON.stringify({ code: "NOT_FOUND_OR_WRONG_STATUS", message: "Donation not found or wrong status" }),
          { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      const donation = donationRows[0];

      // fetch restaurant name
      const { data: rest, error: restErr } = await supa
        .from("restaurants")
        .select("name")
        .eq("id", donation.restaurant_id)
        .single();
      if (restErr || !rest) {
        return new Response(
          JSON.stringify({ code: "REST_FETCH_ERROR", message: restErr?.message || "Restaurant not found" }),
          { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // fetch OSC name
      const { data: osc, error: oscErr } = await supa
        .from("osc")
        .select("name")
        .eq("id", donation.osc_id)
        .single();
      if (oscErr || !osc) {
        return new Response(
          JSON.stringify({ code: "OSC_FETCH_ERROR", message: oscErr?.message || "OSC not found" }),
          { status: 404, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // fetch package details
      const { data: pkgRows, error: pkgErr } = await supa
        .from("donation_packages")
        .select(`
          package_id,
          packages (
            id,
            quantity,
            status,
            created_at,
            label_code,
            expires_at,
            items (
              id,
              name,
              description,
              unit
            )
          )
        `)
        .eq("donation_id", donation.id);
      if (pkgErr) {
        return new Response(
          JSON.stringify({ code: "PKG_FETCH_ERROR", message: pkgErr.message }),
          { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      const packages = pkgRows.map((row: any) => ({
        id:         row.packages.id,
        quantity:   row.packages.quantity,
        status:     row.packages.status,
        created_at: row.packages.created_at,
        label_code: row.packages.label_code,
        expires_at: row.packages.expires_at,
        item: {
          id:          row.packages.items.id,
          name:        row.packages.items.name,
          description: row.packages.items.description,
          unit:        row.packages.items.unit,
        }
      }));

      const result = {
        donation_id:   donation.id,
        status:        donation.status,
        created_at:    donation.created_at,
        released_at:   donation.released_at,
        restaurant:    rest.name,
        osc:           osc.name,
        packages,
      };

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });

    } catch (err: any) {
      console.error("‼ release_donation ERROR:", err);
      return new Response(
        JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
  }
});
