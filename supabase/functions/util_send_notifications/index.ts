// supabase/functions/util_send_notifications/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL     = Deno.env.get("APP_URL")!;
const BREVO_KEY   = Deno.env.get("BREVO_API_KEY")!;
const MAIL_FROM   = Deno.env.get("MAIL_FROM")!;
const FROM_NAME   = Deno.env.get("MAIL_FROM_NAME") ?? "Connecting Food";
const CONFIRM_PATH = "/confirm-donation";

function ensureEnv() {
  if (!BREVO_KEY) throw new Error("Missing BREVO_API_KEY");
  if (!MAIL_FROM) throw new Error("Missing MAIL_FROM");
}

async function sendEmail({ to, subject, html, text }: { to: string; subject: string; html: string; text: string }) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: MAIL_FROM, name: FROM_NAME },
      to: [{ email: to }],
      subject, htmlContent: html, textContent: text,
    }),
  });
  const body = await res.text();
  if (!res.ok) { console.error("❌ Brevo error:", res.status, body); throw new Error("EMAIL_SEND_FAILED"); }
  console.log("✅ Email queued (Brevo):", body);
}

function emailTemplateSimple(oscName: string, restaurantName: string, confirmLink: string) {
  const subject = `Nova doação disponível — ${restaurantName}`;
  const text = [`Olá, ${oscName}.`, ``, `Você tem uma nova doação disponível.`, `Clique para aceitar/recusar:`, confirmLink].join("\n");
  const html = `... your same HTML here ...`; // keep your template
  return { subject, text, html };
}

const handler = async (req: Request): Promise<Response> => {
  console.log("→ util_send_notifications invoked");

  let body: { security_code?: string };
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const { security_code } = body || {};
  if (!security_code) return new Response("Missing security_code", { status: 400 });

  try { ensureEnv(); } catch (e) { console.error(String(e)); return new Response("Email not configured", { status: 500 }); }

  const supa = createClient(SUPA_URL, SERVICE_KEY);

  const { data: intent } = await supa
    .from("donation_intents")
    .select(`id, status, donation_id, security_code, osc:osc ( id, name, email )`)
    .eq("security_code", security_code)
    .single();

  if (!intent) return new Response("Donation intent not found", { status: 404 });
  if (intent.status !== "waiting_response") return new Response("Intent not in waiting_response", { status: 409 });

  const { data: donation } = await supa.from("donations").select("id, restaurant_id").eq("id", intent.donation_id).single();
  if (!donation) return new Response("Donation not found", { status: 404 });

  const { data: restaurant } = await supa.from("restaurants").select("name").eq("id", donation.restaurant_id).single();
  if (!restaurant) return new Response("Restaurant not found", { status: 404 });

  const to = intent.osc?.email;
  if (!to) return new Response("OSC email missing", { status: 422 });

  const confirmLink = `${APP_URL}${CONFIRM_PATH}/${security_code}`;
  const { subject, text, html } = emailTemplateSimple(intent.osc.name, restaurant.name, confirmLink);

  try { await sendEmail({ to, subject, html, text }); } 
  catch { return new Response("Failed to send email", { status: 502 }); }

  return new Response(null, { status: 204 });
};

serve({
  "/": handler,                              // <-- root route (required)
  "/util_send_notifications": handler,       // optional alias for manual tests
});
