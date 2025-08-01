// Validação básica de CNPJ (sem formatação)
export function validateCnpj(cnpj: string): boolean {
    const clean = cnpj.replace(/\D/g, "");
    if (clean.length !== 14 || /^(\d)\1+$/.test(clean)) return false;
  
    const calc = (base: string, factors: number[]) =>
      factors
        .reduce((sum, factor, idx) => sum + Number(base[idx]) * factor, 0) % 11;
  
    const base  = clean.slice(0, 12);
    const dv1   = calc(base, [5,4,3,2,9,8,7,6,5,4,3,2]);
    const dig1  = dv1 < 2 ? 0 : 11 - dv1;
  
    const base2 = base + dig1;
    const dv2   = calc(base2, [6,5,4,3,2,9,8,7,6,5,4,3,2]);
    const dig2  = dv2 < 2 ? 0 : 11 - dv2;
  
    return clean === base2 + dig2;
  }
  