// functions/_lib/geocode.ts

/** ───────────── Types ───────────── */
interface NomResp {
  lat: string;
  lon: string;
}

export type GeoResult = {
  street: string | null;
  neighborhood: string | null;
  city: string | null;
  uf: string | null;
  lat: number;
  lng: number;
};

export type GeocodeInput = {
  cep: string;                // required; we only pattern-check it here
  number?: string | null;     // optional
  street?: string | null;     // optional but preferred (we trust it)
  city?: string | null;       // optional but preferred (we trust it)
  uf?: string | null;         // optional but preferred (we trust it, 2-letter)
  neighborhood?: string | null; // optional, just echoed back
};

/**
 * Geocodes using ONLY Nominatim, trusting the provided address fields.
 * We DO NOT call ViaCEP here. We only sanity-check the CEP pattern (8 digits).
 *
 * Strategy (progressive attempts):
 *  1) street + number + city + uf + postalcode
 *  2) street + city + uf + postalcode
 *  3) city + uf + postalcode
 *  4) postalcode-only
 *
 * Returns lat/lng and echoes the trusted address fields back (filling nulls as needed).
 */
export async function geocodeByCep(input: GeocodeInput): Promise<GeoResult> {
  const NOMINATIM = Deno.env.get("NOMINATIM_URL") ?? "https://nominatim.openstreetmap.org/search";
  const UA        = Deno.env.get("NOMINATIM_UA")  ?? "CF-Geocoder/1.0 (+https://connectingfood.com.br)";

  const cepClean = String(input.cep ?? "").replace(/\D/g, "");
  if (!cepClean || cepClean.length !== 8) {
    throw new Error("CEP inválido (esperado 8 dígitos)");
  }

  const street = safeTrim(input.street);
  const number = safeTrim(input.number);
  const city   = safeTrim(input.city);
  const uf     = safeTrim(input.uf);
  const neigh  = safeTrim(input.neighborhood);

  async function searchNom(params: Record<string, string>): Promise<NomResp[] | null> {
    const qs = new URLSearchParams({
      format: "json",
      limit: "1",
      addressdetails: "0",
      ...params,
    });
    const url = `${NOMINATIM}?${qs.toString()}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      if (res.status === 429) throw new Error("Nominatim rate-limited (429)");
      if (res.status === 403) throw new Error("Nominatim forbidden (403) - verifique User-Agent");
      throw new Error(`Falha no geocoding (${res.status})`);
    }
    const data: NomResp[] = await res.json();
    return data?.length ? data : null;
  }

  // 1) street + number + city + uf + postalcode
  if (street && number && city && uf) {
    const hit = await searchNom({
      street: `${street} ${number}`,
      city,
      state: uf,
      postalcode: cepClean,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) return pack(hit[0], street, neigh, city, uf);
  }

  // 2) street + city + uf + postalcode
  if (street && city && uf) {
    const hit = await searchNom({
      street,
      city,
      state: uf,
      postalcode: cepClean,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) return pack(hit[0], street, neigh, city, uf);
  }

  // 3) city + uf + postalcode
  if (city && uf) {
    const hit = await searchNom({
      city,
      state: uf,
      postalcode: cepClean,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) return pack(hit[0], street, neigh, city, uf);
  }

  // 4) postalcode-only
  {
    const hit = await searchNom({
      postalcode: cepClean,
      country: "Brazil",
      countrycodes: "br",
    });
    if (hit) return pack(hit[0], street, neigh, city, uf);
  }

  throw new Error("Não foi possível obter coordenadas para o CEP informado");
}

/** ───────────── Helpers ───────────── */
function safeTrim(v?: string | null): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function pack(hit: NomResp, street: string | null, neigh: string | null, city: string | null, uf: string | null): GeoResult {
  return {
    street,
    neighborhood: neigh ?? null,
    city: city ?? null,
    uf: uf ?? null,
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
  };
}
