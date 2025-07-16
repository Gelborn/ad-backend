import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Haversine para distância em metros
function toRad(deg: number) { return (deg * Math.PI) / 180; }
function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1), Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

serve({
  "/liberate_donation": async (req: Request) => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = await req.json();
    const { restaurant_id, package_ids } = body;

    // 1) Extrai JWT do header e instancia client com Service Role Key
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const jwtHeader  = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!jwtHeader) return new Response("Missing JWT", { status: 401 });

    const supa = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: `Bearer ${jwtHeader}` } }
    });

    // 2) Busca coords do restaurante
    const { data: rest, error: rErr } = await supa
      .from("restaurants")
      .select("lat,lng")
      .eq("id", restaurant_id)
      .single();
    if (rErr || !rest) return new Response(rErr?.message || "Restaurant not found", { status: 404 });

    // 3) Lista OSCs ativas
    const { data: oscs, error: oErr } = await supa
      .from("osc")
      .select("id,lat,lng,last_received_at")
      .eq("active", true);
    if (oErr || !oscs?.length) return new Response(oErr?.message || "No OSC available", { status: 404 });

    // 4) Seleciona a mais próxima
    const pick = oscs
      .map(o => ({ ...o, dist: haversine(rest.lat, rest.lng, o.lat, o.lng) }))
      .sort((a, b) => a.dist - b.dist || new Date(a.last_received_at).getTime() - new Date(b.last_received_at).getTime())[0];

    // 5) Insere doação e retorna o ID
    const code = crypto.randomUUID().slice(0, 6);
    const { data: dData, error: dErr } = await supa
      .from("donations")
      .insert([{ restaurant_id, osc_id: pick.id, status: "pending", security_code: code }])
      .select("id");            // <-- força o retorno da linha criada
    if (dErr || !dData?.length) return new Response(dErr?.message || "Insert failed", { status: 400 });
    const donation_id = dData[0].id;

    // 6) Vincula pacotes
    await Promise.all(
      package_ids.map(id =>
        supa.from("donation_packages").insert({ donation_id, package_id: id })
      )
    );

    // 7) Envia notificação
    await supa.functions.invoke("send_notifications", { body: { donation_id, security_code: code } });

    // 8) Responde JSON
    return new Response(JSON.stringify({ donation_id, security_code: code }), {
      headers: { "Content-Type": "application/json" }
    });
  }
});
