import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve({
  "/register_restaurant": async (req: Request) => {
    if (req.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
    const SRV_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    // 1) Extrai e valida JWT de usuário
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Missing authorization", { status: 401 });
    }
    const jwt = authHeader.replace("Bearer ", "");

    // 2) Instancia clientes
    const supaAdmin  = createClient(SUPA_URL, SRV_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } }
    });
    const supaInvoke = createClient(SUPA_URL, ANON_KEY);

    // 3) Lê payload
    const { name, phone, cep } = await req.json();
    if (!name || !phone || !cep) {
      return new Response("Missing name, phone or cep", { status: 400 });
    }

    // 4) Geocode via Edge Function (publica ou com anon key)
    const { data: geo, error: gErr } = await supaInvoke.functions.invoke("geocode_address", {
      body: { cep }
    });
    if (gErr) {
      return new Response(gErr.message, { status: 502 });
    }
    const { street, neighborhood, city, state, lat, lng } = geo as any;

    // 5) Busca user info (id + email)
    const { data: meData, error: uErr } = await supaAdmin.auth.getUser();
    if (uErr || !meData.user) {
      return new Response("User lookup failed", { status: 500 });
    }
    const uid   = meData.user.id;
    const email = meData.user.email!;

    // 6) Verifica se já existe um registro para este user_id
    const { data: existing, error: eErr } = await supaAdmin
      .from("restaurants")
      .select("id")
      .eq("user_id", uid)
      .maybeSingle();
    if (eErr) {
      return new Response(eErr.message, { status: 500 });
    }
    if (existing) {
      return new Response("Restaurante já cadastrado", { status: 409 });
    }

    // 7) Insere o novo restaurante
    const { error: rErr } = await supaAdmin
      .from("restaurants")
      .insert({
        user_id: uid,
        email,
        name,
        phone,
        address: `${street}, ${neighborhood}, ${city} - ${state}`,
        lat,
        lng
      });
    if (rErr) {
      return new Response(rErr.message, { status: rErr.status || 400 });
    }

    return new Response(null, { status: 201 });
  }
});
