import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/liberate_donation": async (req: Request) => {
    const CORS_HEADERS = {
      "Access-Control-Allow-Origin": "*",               // ou seu domínio
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, x-client-info, apikey",
    };

    // 1) Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2) Apenas POST
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: CORS_HEADERS });
    }

    try {
      // 3) Setup Supabase client
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const jwt          = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!jwt) {
        return new Response(
          JSON.stringify({ code: "MISSING_JWT", message: "JWT não fornecido" }),
          { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
      const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
        global: { headers: { Authorization: `Bearer ${jwt}` } }
      });

      // 4) Body e RPC
      const { restaurant_id } = await req.json();
      const { data, error } = await supa
        .rpc("release_donation", { in_restaurant_id: restaurant_id });

      if (error) {
        let status = 400, payload: any = {};
        switch (error.message) {
          case "NO_PACKAGES_IN_STOCK":
            status = 409;
            payload = { code: "NO_PACKAGES_IN_STOCK", message: "Não há pacotes em estoque para liberar." };
            break;
          case "RESTAURANT_NOT_FOUND":
            status = 404;
            payload = { code: "RESTAURANT_NOT_FOUND", message: "Restaurante não encontrado." };
            break;
          case "NO_OSC_AVAILABLE":
            status = 404;
            payload = { code: "NO_OSC_AVAILABLE", message: "Nenhuma OSC ativa disponível." };
            break;
          default:
            throw error;
        }
        return new Response(JSON.stringify(payload), {
          status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      const { donation_id, security_code } = (data as any)[0];
      // 5) Notificação
      await supa.functions.invoke("send_notifications", {
        body: { donation_id, security_code }
      });

      // 6) Sucesso
      return new Response(
        JSON.stringify({ donation_id, security_code }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );

    } catch (err: any) {
      console.error("‼ liberate_donation ERROR:", err);
      return new Response(
        JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
  }
});
