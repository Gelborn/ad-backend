// functions/_lib/geocode.ts

interface ViaCepResp {
  logradouro: string;  // street
  bairro: string;      // neighborhood
  localidade: string;  // city
  uf: string;          // state
  erro?: boolean;
}

interface NomResp {
  lat: string;
  lon: string;
}

type GeoResult = {
  street: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
  lat: number;
  lng: number;
};

/**
 * Retorna endereço + coordenadas a partir do CEP (e opcionalmente número).
 * Estratégia:
 *  - ViaCEP para street/city/uf
 *  - Nominatim com tentativas progressivas (street+number → street → cep+city/uf → cep)
 */
export async function geocodeByCep(cep: string, number?: string): Promise<GeoResult> {
  const VIACEP    = Deno.env.get("VIACEP_URL")    ?? "https://viacep.com.br/ws";
  const NOMINATIM = Deno.env.get("NOMINATIM_URL") ?? "https://nominatim.openstreetmap.org/search";
  const UA        = Deno.env.get("NOMINATIM_UA")  ?? "CF-Geocoder/1.0 (+https://connectingfood.com.br)";

  const cleanCep = String(cep ?? "").replace(/\D/g, "");
  if (!cleanCep) throw new Error("CEP ausente");
  // 1) ViaCEP (endereço base)
  const r = await fetch(`${VIACEP}/${cleanCep}/json/`);
  if (!r.ok) throw new Error("Falha ao consultar ViaCEP");
  const vic: ViaCepResp = await r.json();
  if (vic.erro) throw new Error("CEP não encontrado em ViaCEP");

  const street = vic.logradouro?.trim() || null;
  const city   = vic.localidade?.trim() || null;
  const uf     = vic.uf?.trim()         || null;
  const neigh  = vic.bairro?.trim()     || null;

  const numClean = (number ?? "").toString().trim();

  // Helper: build and fire a Nominatim request with params
  async function searchNom(params: Record<string, string>): Promise<NomResp[] | null> {
    const qs = new URLSearchParams({ format: "json", limit: "1", addressdetails: "0", ...params });
    const url = `${NOMINATIM}?${qs.toString()}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      // Rate limit / forbidden are common; bubble up a clear error
      if (res.status === 429) throw new Error("Nominatim rate-limited (429)");
      if (res.status === 403) throw new Error("Nominatim forbidden (403) - verifique User-Agent");
      throw new Error(`Falha no geocoding (${res.status})`);
    }
    const data: NomResp[] = await res.json();
    return data?.length ? data : null;
  }

  // Attempt 1: street + number + city + state + postalcode (best precision)
  if (street && numClean && city && uf) {
    const hit = await searchNom({
      street: `${street} ${numClean}`,
      city,
      state: uf,
      postalcode: cleanCep,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) {
      return {
        street,
        neighborhood: neigh,
        city,
        uf,
        lat: parseFloat(hit[0].lat),
        lng: parseFloat(hit[0].lon),
      };
    }
  }

  // Attempt 2: street + city + state + postalcode
  if (street && city && uf) {
    const hit = await searchNom({
      street,
      city,
      state: uf,
      postalcode: cleanCep,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) {
      return {
        street,
        neighborhood: neigh,
        city,
        uf,
        lat: parseFloat(hit[0].lat),
        lng: parseFloat(hit[0].lon),
      };
    }
  }

  // Attempt 3: postalcode + city + state (CEP centroid within city/uf)
  if (city && uf) {
    const hit = await searchNom({
      postalcode: cleanCep,
      city,
      state: uf,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) {
      return {
        street,
        neighborhood: neigh,
        city,
        uf,
        lat: parseFloat(hit[0].lat),
        lng: parseFloat(hit[0].lon),
      };
    }
  }

  // Attempt 4: postalcode-only (least precise; sometimes Nominatim has no pure CEP data)
  {
    const hit = await searchNom({
      postalcode: cleanCep,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) {
      return {
        street,
        neighborhood: neigh,
        city,
        uf,
        lat: parseFloat(hit[0].lat),
        lng: parseFloat(hit[0].lon),
      };
    }
  }

  // If all attempts failed:
  throw new Error("Nenhuma coordenada retornada para o CEP informado");
}
