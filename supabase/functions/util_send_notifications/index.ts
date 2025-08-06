// supabase/functions/send_notifications/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DISCORD_WEBHOOK = Deno.env.get("DISCORD_WEBHOOK_URL")!;
const SUPA_URL        = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL         = Deno.env.get("APP_URL")!;

// hardcode da rota
const CONFIRM_PATH    = "/confirm-donation";

serve({
  "/util_send_notifications": async (req: Request) => {
    console.log("→ util_send_notifications invoked");
    let body: any;
    try {
      body = await req.json();
    } catch (e) {
      console.error("Invalid JSON:", e);
      return new Response("Invalid JSON", { status: 400 });
    }
    console.log("Payload:", body);

    const { donation_id, security_code } = body;
    if (!donation_id || !security_code) {
      console.error("Missing donation_id or security_code");
      return new Response("Missing donation_id or security_code", { status: 400 });
    }
    if (!DISCORD_WEBHOOK) {
      console.error("❌ DISCORD_WEBHOOK_URL not set");
      return new Response("Webhook not configured", { status: 500 });
    }

    const supa = createClient(SUPA_URL, SERVICE_KEY);

    // busca nome do restaurante
    const { data: don, error: dErr } = await supa
      .from("donations")
      .select("restaurant_id")
      .eq("id", donation_id)
      .single();
    if (dErr || !don) {
      console.error("Donation not found:", dErr);
      return new Response("Donation not found", { status: 404 });
    }

    const { data: rest, error: rErr } = await supa
      .from("restaurants")
      .select("name")
      .eq("id", don.restaurant_id)
      .single();
    if (rErr || !rest) {
      console.error("Restaurant not found:", rErr);
      return new Response("Restaurant not found", { status: 404 });
    }

    // monta e envia a mensagem com o link
    const link    = `${APP_URL}${CONFIRM_PATH}/${security_code}`;
    const content = [
      "📢 **Nova Doação!**",
      `**Restaurante:** ${rest.name}`,
      `**Confira a doação pelo link e faça o aceite ou rejeite:** ${link}`,
    ].join("\n");

    const discordRes = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const text = await discordRes.text();
    if (!discordRes.ok) {
      console.error("❌ Discord webhook error:", discordRes.status, text);
      return new Response("Failed to send Discord message", { status: 502 });
    }
    console.log("✅ Discord notification sent:", text);

    return new Response(null, { status: 204 });
  },
});
