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
 * Retorna endereço + coordenadas a partir do CEP.
 * Usa ViaCEP para dados de endereço e Nominatim só pelo CEP para lat/lng.
 */
export async function geocodeByCep(cep: string) {
  const VIACEP    = Deno.env.get("VIACEP_URL")   ?? "https://viacep.com.br/ws";
  const NOMINATIM = Deno.env.get("NOMINATIM_URL")
    ?? "https://nominatim.openstreetmap.org/search";

  // 1) Consulta ViaCEP
  const cleanCep = cep.replace(/\D/g, "");
  const r = await fetch(`${VIACEP}/${cleanCep}/json/`);
  if (!r.ok) throw new Error("Falha ao consultar ViaCEP");
  const vic: ViaCepResp = await r.json();
  if (vic.erro) throw new Error("CEP não encontrado em ViaCEP");

  // 2) Consulta Nominatim apenas pelo CEP
  const url = `${NOMINATIM}?postalcode=${cleanCep}&country=BR&format=json&limit=1`;
  const n = await fetch(url);
  if (!n.ok) throw new Error("Falha no geocoding reverso");
  const nom: NomResp[] = await n.json();
  if (!nom.length) throw new Error("Nenhuma coordenada retornada");

  // 3) Retorna dados
  return {
    street:       vic.logradouro,
    neighborhood: vic.bairro,
    city:         vic.localidade,
    uf:           vic.uf,
    lat:          parseFloat(nom[0].lat),
    lng:          parseFloat(nom[0].lon),
  };
}
