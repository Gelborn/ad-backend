// supabase/functions/send_notifications/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPA_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL      = Deno.env.get("APP_URL")!;
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY")!;
const MAIL_FROM    = Deno.env.get("MAIL_FROM")!;

// Rota do front para aceite/recusa
const CONFIRM_PATH = "/confirm-donation";

type IntentStatus = "waiting_response" | "accepted" | "denied" | "expired" | "re_routed";

function ensureEnv() {
  if (!RESEND_KEY) throw new Error("Missing RESEND_API_KEY");
  if (!MAIL_FROM)  throw new Error("Missing MAIL_FROM");
}

async function sendEmail({
  to, subject, html, text,
}: { to: string; subject: string; html: string; text: string }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: MAIL_FROM, to, subject, html, text }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error("❌ Resend error:", res.status, body);
    throw new Error("EMAIL_SEND_FAILED");
  }
  console.log("✅ Email queued:", body);
}

function emailTemplateSimple(params: {
  oscName: string;
  restaurantName: string;
  confirmLink: string;
}) {
  const { oscName, restaurantName, confirmLink } = params;
  const subject = `Nova doação disponível — ${restaurantName}`;
  const text = [
    `Olá, ${oscName}.`,
    ``,
    `Você tem uma nova doação disponível.`,
    `Clique no link para aceitar ou negar:`,
    confirmLink,
  ].join("\n");

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f6f7fb;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <tr><td align="center">
      <table width="560" role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);overflow:hidden">
        <tr>
          <td style="padding:24px 28px;border-bottom:1px solid #eef1f6">
            <h1 style="margin:0;font-size:20px;line-height:1.3;color:#111827">Nova doação disponível</h1>
            <p style="margin:8px 0 0 0;color:#6b7280;font-size:14px">Convite para responder</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;color:#111827;font-size:14px;line-height:1.6">
            <p style="margin:0 0 12px">Olá, <strong>${oscName}</strong>.</p>
            <p style="margin:0 0 16px">Você tem uma nova doação disponível do restaurante <strong>${restaurantName}</strong>.</p>
            <p style="margin:0 0 16px">Clique no botão abaixo para <strong>aceitar</strong> ou <strong>negar</strong> a doação.</p>
            <div style="text-align:center;margin:24px 0">
              <a href="${confirmLink}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Responder agora</a>
            </div>
            <p style="margin:12px 0 0;color:#6b7280;font-size:12px">Se o botão não funcionar, acesse: <br><a href="${confirmLink}" style="color:#111827">${confirmLink}</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px;border-top:1px solid #eef1f6;color:#6b7280;font-size:12px">
            Esta é uma notificação automática da plataforma Connecting Food.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`.trim();

  return { subject, html, text };
}

serve({
  "/util_send_notifications": async (req: Request) => {
    console.log("→ util_send_notifications invoked");

    // Body: { security_code, resend?: boolean }
    let body: { security_code?: string; resend?: boolean };
    try { body = await req.json(); }
    catch { return new Response("Invalid JSON", { status: 400 }); }

    const { security_code, resend } = body || {};
    if (!security_code) return new Response("Missing security_code", { status: 400 });

    try { ensureEnv(); }
    catch (e) {
      console.error(String(e));
      return new Response("Email not configured", { status: 500 });
    }

    const supa = createClient(SUPA_URL, SERVICE_KEY);

    // Intent como fonte da verdade
    const { data: intent, error: iErr } = await supa
      .from("donation_intents")
      .select(`
        id, status, expires_at, donation_id, security_code,
        osc:osc ( id, name, email ),
        donations!inner ( id, restaurant_id ),
        restaurants:donations!inner ( restaurant_id )
      `)
      .eq("security_code", security_code)
      .single();

    if (iErr || !intent) {
      console.error("Intent not found:", iErr);
      return new Response("Donation intent not found", { status: 404 });
    }

    // Só envia enquanto waiting_response (tanto 1º envio quanto reenvio)
    if (intent.status !== "waiting_response") {
      return new Response("Intent not in waiting_response", { status: 409 });
    }

    const osc = intent.osc as { id: string; name: string; email?: string } | null;
    if (!osc?.email) {
      console.error("OSC email missing");
      return new Response("OSC email missing", { status: 422 });
    }

    const { data: donation, error: dErr } = await supa
      .from("donations")
      .select("id, restaurant_id")
      .eq("id", intent.donation_id)
      .single();
    if (dErr || !donation) {
      console.error("Donation not found:", dErr);
      return new Response("Donation not found", { status: 404 });
    }

    const { data: restaurant, error: rErr } = await supa
      .from("restaurants")
      .select("name")
      .eq("id", donation.restaurant_id)
      .single();
    if (rErr || !restaurant) {
      console.error("Restaurant not found:", rErr);
      return new Response("Restaurant not found", { status: 404 });
    }

    const confirmLink = `${APP_URL}${CONFIRM_PATH}/${security_code}`;
    const { subject, html, text } = emailTemplateSimple({
      oscName: osc.name,
      restaurantName: restaurant.name,
      confirmLink,
    });

    try {
      await sendEmail({ to: osc.email!, subject, html, text });
    } catch (e) {
      console.error("Email error:", e);
      return new Response("Failed to send email", { status: 502 });
    }

    return new Response(null, { status: 204 });
  },
});
