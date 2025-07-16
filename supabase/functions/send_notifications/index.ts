import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DISCORD_WEBHOOK = Deno.env.get("DISCORD_WEBHOOK_URL")!;
const SUPA_URL        = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve({
  "/send_notifications": async (req: Request) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });

    const { donation_id, security_code } = await req.json();
    if (!donation_id || !security_code) {
      return new Response("Missing donation_id or security_code", { status: 400 });
    }

    // uso da Service Role Key para bypassar RLS
    const supa = createClient(SUPA_URL, SERVICE_KEY);

    // 1) busca dados da doação
    const { data: don, error: dErr } = await supa
      .from("donations")
      .select("restaurant_id")
      .eq("id", donation_id)
      .single();
    if (dErr || !don) {
      return new Response(dErr?.message || "Donation not found", { status: 404 });
    }

    // 2) busca nome do restaurante
    const { data: rest, error: rErr } = await supa
      .from("restaurants")
      .select("name")
      .eq("id", don.restaurant_id)
      .single();
    if (rErr || !rest) {
      return new Response(rErr?.message || "Restaurant not found", { status: 404 });
    }

    // 3) monta a mensagem
    const content = [
      "📢 **Nova Doação!**",
      `**Restaurante:** ${rest.name}`,
      `**Código de segurança:** \`${security_code}\``,
      "",
      "**Para aceitar:**",
      "```bash",
      `curl -X POST http://localhost:54321/functions/v1/accept_donation -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"security_code":"${security_code}"}'`,
      "```",
      "**Para negar:**",
      "```bash",
      `curl -X POST http://localhost:54321/functions/v1/deny_donation -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"security_code":"${security_code}"}'`,
      "```"
    ].join("\n");

    // 4) envia para o Discord
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });

    return new Response(null, { status: 204 });
  },
});
