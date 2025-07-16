// supabase/functions/accept_donation/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/accept_donation": async (req) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const { security_code } = await req.json();
    if (!security_code) return new Response("Missing security_code", { status: 400 });

    const url        = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa       = createClient(url, serviceKey);

    const { data, error } = await supa
      .from("donations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("security_code", security_code)
      .eq("status", "pending")
      .select("id");

    if (error) return new Response(error.message, { status: 400 });
    if (!data.length) return new Response("Donation not found or not pending", { status: 404 });
    return new Response(null, { status: 204 });
  },
});
