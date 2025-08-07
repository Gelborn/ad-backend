// functions/_lib/geocode.ts

interface ViaCepResp {
  logradouro: string;
  bairro: string;
  localidade: string;
  uf: string;
  erro?: boolean;
}

interface NomResp {
  lat: string;
  lon: string;
}

/**
 * Retorna endereço + coordenadas a partir do CEP e, opcionalmente, número.
 */
export async function geocodeByCep(cep: string, number?: string) {
  const VIACEP    = Deno.env.get("VIACEP_URL")   ?? "https://viacep.com.br/ws";
  const NOMINATIM =
    Deno.env.get("NOMINATIM_URL") ??
    "https://nominatim.openstreetmap.org/search"; // fallback público

  /* --------------- ViaCEP --------------- */
  const clean = cep.replace(/\D/g, "");
  const r = await fetch(`${VIACEP}/${clean}/json/`);
  if (!r.ok) throw new Error("CEP fail");
  const vic: ViaCepResp = await r.json();
  if (vic.erro) throw new Error("CEP not found");

  /* -------------- Nominatim -------------- */
  const addressParts = [
    vic.logradouro,
    vic.bairro,
    vic.localidade,
    vic.uf,
    "Brasil",
  ]
  const query = encodeURIComponent(addressParts.join(", "))

  const n = await fetch(`${NOMINATIM}?q=${query}&format=json&limit=1`);
  if (!n.ok) throw new Error("Geocode fail");
  const nom: NomResp[] = await n.json();
  if (!nom.length) throw new Error("No coords");

  return {
    street: vic.logradouro,
    neighborhood: vic.bairro,
    city: vic.localidade,
    uf: vic.uf,
    lat: parseFloat(nom[0].lat),
    lng: parseFloat(nom[0].lon),
  };
}
