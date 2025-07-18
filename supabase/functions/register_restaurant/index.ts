// supabase/functions/register_restaurant/index.ts
import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/register_restaurant": async (req: Request) => {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, x-client-info, apikey",
    };

    // 1) Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    // 2) Apenas POST
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: CORS });
    }

    try {
      const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
      const SRV_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

      // 3) Extrai e valida JWT de usuário
      const authHeader = req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({ code: "MISSING_AUTH", message: "Missing authorization header" }),
          { status: 401, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      const jwt = authHeader.replace("Bearer ", "");

      // 4) Instancia clientes
      const supaAdmin  = createClient(SUPA_URL, SRV_KEY, {
        global: { headers: { Authorization: `Bearer ${jwt}` } }
      });
      const supaInvoke = createClient(SUPA_URL, ANON_KEY);

      // 5) Parse do payload
      const { name, phone, cep } = await req.json().catch(() => ({}));
      if (!name || !phone || !cep) {
        return new Response(
          JSON.stringify({ code: "MISSING_FIELDS", message: "Missing name, phone or cep" }),
          { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // 6) Geocode via Edge Function
      const { data: geo, error: gErr } = await supaInvoke.functions.invoke("geocode_address", {
        body: { cep }
      });
      if (gErr || !geo) {
        return new Response(
          JSON.stringify({ code: "GEOCODE_ERROR", message: gErr?.message || "Failed to geocode address" }),
          { status: 502, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      const { street, neighborhood, city, state, lat, lng } = geo as any;

      // 7) Busca usuário logado
      const { data: meData, error: uErr } = await supaAdmin.auth.getUser();
      if (uErr || !meData.user) {
        return new Response(
          JSON.stringify({ code: "USER_LOOKUP_FAILED", message: "User lookup failed" }),
          { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      const uid   = meData.user.id;
      const email = meData.user.email!;

      // 8) Verifica registro existente
      const { data: existing, error: eErr } = await supaAdmin
        .from("restaurants")
        .select("id")
        .eq("user_id", uid)
        .maybeSingle();
      if (eErr) {
        return new Response(
          JSON.stringify({ code: "DB_ERROR", message: eErr.message }),
          { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
      if (existing) {
        return new Response(
          JSON.stringify({ code: "ALREADY_REGISTERED", message: "Restaurant already registered" }),
          { status: 409, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // 9) Insere novo restaurante
      const { data: newRows, error: rErr } = await supaAdmin
        .from("restaurants")
        .insert({
          user_id: uid,
          email,
          name,
          phone,
          address: `${street}, ${neighborhood}, ${city} - ${state}`,
          lat,
          lng
        })
        .select("id")
        .single();
      if (rErr || !newRows) {
        return new Response(
          JSON.stringify({ code: "DB_INSERT_ERROR", message: rErr?.message || "Insert failed" }),
          { status: rErr?.status || 400, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }

      // 10) Sucesso
      return new Response(
        JSON.stringify({ id: newRows.id, message: "Restaurant registered" }),
        { status: 201, headers: { ...CORS, "Content-Type": "application/json" } }
      );

    } catch (err: any) {
      console.error("‼ register_restaurant ERROR:", err);
      return new Response(
        JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }
  }
});
