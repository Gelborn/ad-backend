// Valida CEP (apenas dígitos) e consulta ViaCEP.
export function validateCep(cep: string): boolean {
    return /^[0-9]{8}$/.test(cep.replace(/\D/g, ""));
  }
  
  interface ViaCepResp {
    logradouro: string;
    bairro: string;
    localidade: string;
    uf: string;
    erro?: boolean;
  }
  
  export async function fetchCepInfo(cep: string) {
    const VIACEP = Deno.env.get("VIACEP_URL") ?? "https://viacep.com.br/ws";
    const clean  = cep.replace(/\D/g, "");
  
    const r = await fetch(`${VIACEP}/${clean}/json/`);
    if (!r.ok) throw new Error("ViaCEP fail");
    const json: ViaCepResp = await r.json();
    if (json.erro) throw new Error("CEP not found");
  
    return {
      street:       json.logradouro,
      neighborhood: json.bairro,
      city:         json.localidade,
      uf:           json.uf,
    };
  }
  