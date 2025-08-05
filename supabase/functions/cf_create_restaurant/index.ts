import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, corsHeaders } from "$lib/cors.ts";
import { geocodeByCep }  from "$lib/geocode.ts";
import { validateCep }   from "$lib/cep.ts";
import { inviteUser }    from "$lib/invite.ts";

/* ---------- Supabase clients ---------- */
const supa      = createClient(Deno.env.get("SUPABASE_URL")!,  Deno.env.get("SUPABASE_ANON_KEY")!);
const supaAdmin = createClient(Deno.env.get("SUPABASE_URL")!,  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const APP_URL   = Deno.env.get("APP_URL")!;

serve(async (req) => {
  /* CORS pre-flight */
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: corsHeaders(req.headers.get("origin")) });
  }

  try {
    /* Auth: apenas CF */
    const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwt) return new Response("Auth required", { status: 401, headers: corsHeaders(req.headers.get("origin")) });
    supa.auth.setAuth(jwt);
    const { data: isCf } = await supa.rpc("is_cf");
    if (!isCf) return new Response("Forbidden", { status: 403, headers: corsHeaders(req.headers.get("origin")) });

    /* Body */
    const { name, emailOwner, cep, number, street, city, uf, phone } = await req.json();
    if (!validateCep(cep)) return new Response("CEP inválido", { status: 422, headers: corsHeaders(req.headers.get("origin")) });

    /* Dup e-mail */
    const { data: dup } = await supaAdmin.from("auth.users").select("id").ilike("email", emailOwner).maybeSingle();
    if (dup) return new Response("E-mail já cadastrado", { status: 409, headers: corsHeaders(req.headers.get("origin")) });

    /* Geocoding */
    const geo = await geocodeByCep(cep, number);

    /* Insert restaurante */
    const { data: restaurant, error } = await supa
      .from("restaurants")
      .insert({
        name,
        phone,
        street: street ?? geo.street,
        number,
        city:   city   ?? geo.city,
        uf:     uf     ?? geo.uf,
        cep,
        lat: geo.lat,
        lng: geo.lng,
        status: "invite_sent",
      })
      .select()
      .single();
    if (error) throw error;

    /* Invite owner */
    const user = await inviteUser(emailOwner, `${APP_URL}/set-password`);
    await supaAdmin.from("restaurant_users").insert({ user_id: user.id, restaurant_id: restaurant.id, role: "owner" });

    return new Response(JSON.stringify({ id: restaurant.id }), {
      status: 201,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("cf_create_restaurant ERROR:", err);
    return new Response(JSON.stringify({ code: "INTERNAL_ERROR", message: err.message }), {
      status: 500,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });
  }
});
