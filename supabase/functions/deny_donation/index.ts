// supabase/functions/deny_donation/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/deny_donation": async (req: Request) => {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "apikey, Content-Type, x-client-info",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: CORS });
    }

    console.log("→ deny_donation invoke");
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: CORS });
    }
    console.log("Payload:", body);

    const { security_code } = body;
    if (!security_code) {
      return new Response("Missing security_code", { status: 400, headers: CORS });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supa = createClient(url, key);

    // observa que aqui mantemos o timestamp em accepted_at
    // se quiser criar um denied_at, precisa adicionar a coluna via migration
    const now = new Date().toISOString();
    const { data, error } = await supa
      .from("donations")
      .update({ status: "denied", accepted_at: now })
      .eq("security_code", security_code)
      .eq("status", "pending")
      .select("id");

    if (error) {
      console.error("❌ deny_donation error:", error);
      return new Response(error.message, { status: 400, headers: CORS });
    }
    if (!data.length) {
      return new Response("Donation not found or not pending", { status: 404, headers: CORS });
    }

    console.log("✅ Donation denied:", data[0].id);
    return new Response(null, { status: 204, headers: CORS });
  },
});
