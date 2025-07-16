import { serve } from "https://deno.land/x/sift@0.6.0/mod.ts";

interface ViaCepResp { logradouro: string; bairro: string; localidade: string; uf: string; }
interface NomResp { lat: string; lon: string; }

serve({
  "/geocode_address": async (req) => {
    // 1) lê o CEP
    const { cep } = await req.json();
    if (!cep) return new Response("Missing CEP", { status: 400 });

    // 2) busca no ViaCEP
    const VIACEP = Deno.env.get("VIACEP_URL");
    if (!VIACEP) return new Response("Missing VIACEP_URL env", { status: 500 });
    const v = await fetch(`${VIACEP}/${cep}/json/`);
    if (!v.ok) return new Response("CEP not found", { status: 404 });
    const vic: ViaCepResp = await v.json();

    // 3) busca coords no Nominatim (note o '?q=')
    const NOM = Deno.env.get("NOMINATIM_URL");
    if (!NOM) return new Response("Missing NOMINATIM_URL env", { status: 500 });
    const query = encodeURIComponent(
      `${vic.logradouro}, ${vic.bairro}, ${vic.localidade}, ${vic.uf}, Brasil`
    );
    const nomRes = await fetch(`${NOM}?q=${query}&format=json&limit=1`);
    if (!nomRes.ok) return new Response("Geocode failed", { status: 502 });
    const nom: NomResp[] = await nomRes.json();
    if (!nom.length) return new Response("No coords", { status: 404 });

    // 4) retorna o JSON
    return new Response(
      JSON.stringify({
        street:       vic.logradouro,
        neighborhood: vic.bairro,
        city:         vic.localidade,
        state:        vic.uf,
        lat:          parseFloat(nom[0].lat),
        lng:          parseFloat(nom[0].lon),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  },
});
