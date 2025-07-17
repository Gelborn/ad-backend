import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/liberate_donation": async (req: Request) => {
    if (req.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    try {
      // 1) Setup Supabase client com Service Role Key + JWT
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
      if (!jwt) {
        return new Response(
          JSON.stringify({ code: "MISSING_JWT", message: "JWT não fornecido" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
      const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
        global: { headers: { Authorization: `Bearer ${jwt}` } }
      });

      // 2) Parse do body
      const { restaurant_id } = await req.json();
      console.log("→ Liberate donation for restaurant:", restaurant_id);

      // 3) Chama RPC atômica
      const { data, error } = await supa
        .rpc("release_donation", { in_restaurant_id: restaurant_id });

      if (error) {
        // Mapeia erros específicos para o front
        switch (error.message) {
          case "NO_PACKAGES_IN_STOCK":
            return new Response(
              JSON.stringify({
                code: "NO_PACKAGES_IN_STOCK",
                message: "Não há pacotes em estoque para liberar."
              }),
              { status: 409, headers: { "Content-Type": "application/json" } }
            );
          case "RESTAURANT_NOT_FOUND":
            return new Response(
              JSON.stringify({ code: "RESTAURANT_NOT_FOUND", message: "Restaurante não encontrado." }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            );
          case "NO_OSC_AVAILABLE":
            return new Response(
              JSON.stringify({ code: "NO_OSC_AVAILABLE", message: "Nenhuma OSC ativa disponível." }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            );
          default:
            throw error;
        }
      }

      const { donation_id, security_code } = (data as any)[0];
      console.log("→ Donation created:", donation_id, security_code);

      // 4) Dispara notificação
      const notif = await supa.functions.invoke("send_notifications", {
        body: { donation_id, security_code }
      });
      console.log("→ Notification result:", notif);

      // 5) Retorna sucesso
      return new Response(
        JSON.stringify({ donation_id, security_code }),
        { headers: { "Content-Type": "application/json" } }
      );

    } catch (err: any) {
      console.error("‼ liberate_donation ERROR:", err);
      return new Response(
        JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
});
