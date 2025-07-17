import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DISCORD_WEBHOOK = Deno.env.get("DISCORD_WEBHOOK_URL");
const SUPA_URL        = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

serve({
  "/send_notifications": async (req: Request) => {
    console.log("→ send_notifications invoked");
    console.log("Headers:", Object.fromEntries(req.headers));
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

    // Bypass RLS
    const supa = createClient(SUPA_URL!, SERVICE_KEY!);
    try {
      // Busca dados da doação
      const { data: don, error: dErr } = await supa
        .from("donations")
        .select("restaurant_id")
        .eq("id", donation_id)
        .single();
      if (dErr || !don) throw new Error(dErr?.message || "Donation not found");

      // Busca nome do restaurante
      const { data: rest, error: rErr } = await supa
        .from("restaurants")
        .select("name")
        .eq("id", don.restaurant_id)
        .single();
      if (rErr || !rest) throw new Error(rErr?.message || "Restaurant not found");

      console.log("→ Sending Discord notification for donation", donation_id);

      // Monta e envia mensagem
      const content = [
        "📢 **Nova Doação!**",
        `**Restaurante:** ${rest.name}`,
        `**Código de segurança:** \`${security_code}\``,
        "",
        "**Para aceitar:**",
        "```bash",
        `curl -X POST https://<SEU-PROJECT>.supabase.co/functions/v1/accept_donation -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" -d '{"security_code":"${security_code}"}'`,
        "```",
        "**Para negar:**",
        "```bash",
        `curl -X POST https://<SEU-PROJECT>.supabase.co/functions/v1/deny_donation -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" -d '{"security_code":"${security_code}"}'`,
        "```"
      ].join("\n");

      const discordRes = await fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      const text = await discordRes.text();
      if (!discordRes.ok) {
        console.error("❌ Discord webhook error:", discordRes.status, text);
        return new Response("Failed to send Discord message", { status: 502 });
      }
      console.log("✅ Discord notification sent:", text);

      return new Response(null, { status: 204 });
    } catch (err: any) {
      console.error("‼ send_notifications ERROR:", err);
      return new Response(err.message, { status: 500 });
    }
  },
});
