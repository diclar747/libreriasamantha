// Utilidades de RUC / cédula paraguaya. El endpoint público /ruc/ ya devuelve el dígito verificador (DV),
// así que acá solo normalizamos, separamos el DV y comparamos "sin DV" (para que "3626142" y "3626142-4" sean el mismo).

/** Número base (sin DV ni separadores): de "3626142-4" o "3626142" → "3626142". */
export function baseRuc(doc: string | null | undefined): string {
  const s = String(doc ?? '').trim()
  // Si trae guion, el número base es lo que está antes del guion.
  const beforeDash = s.includes('-') ? s.split('-')[0] : s
  return beforeDash.replace(/\D/g, '')
}

/** Dígito verificador oficial (módulo 11, base 11). Solo para validar/formatear cuando no viene del servicio. */
export function calcDv(base: string): number {
  const digits = base.replace(/\D/g, '')
  let total = 0
  let factor = 2
  for (let i = digits.length - 1; i >= 0; i--) {
    total += Number(digits[i]) * factor
    factor = factor === 11 ? 2 : factor + 1
  }
  const mod = total % 11
  return mod > 1 ? 11 - mod : 0
}

/** Devuelve "base-DV". Si ya viene con DV lo respeta. */
export function withDv(doc: string): string {
  const s = String(doc ?? '').trim()
  if (/-\d$/.test(s)) return s.replace(/\s/g, '')
  const base = baseRuc(s)
  return base ? `${base}-${calcDv(base)}` : s
}

/** Dos documentos son el mismo si comparten el número base (ignorando el DV). */
export function sameDoc(a: string | null | undefined, b: string | null | undefined): boolean {
  const ba = baseRuc(a), bb = baseRuc(b)
  return !!ba && ba === bb
}
