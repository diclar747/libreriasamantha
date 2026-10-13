import { createHash, randomBytes } from 'node:crypto'

export const PUBLIC_URL = () => process.env.PUBLIC_URL ?? 'http://localhost:5173'
const mode = () => process.env.BANCARD_MODE ?? 'mock'
const privateKey = () => process.env.BANCARD_PRIVATE_KEY ?? 'dev-private-key'

export const md5 = (s: string) => createHash('md5').update(s).digest('hex')

// Formato de importe de Bancard: decimales con punto ("130000.00").
export const bancardAmount = (n: number) => n.toFixed(2)

// Token de confirmación (según la documentación de vPOS de Bancard — a validar al contratar el servicio):
// md5(private_key + shop_process_id + "confirm" + amount + currency)
export function confirmationToken(shopProcessId: string, amount: number, currency = 'PYG') {
  return md5(privateKey() + shopProcessId + 'confirm' + bancardAmount(amount) + currency)
}

export interface Confirmation { operation: { token: string; shop_process_id: string; response: string; response_details?: string; amount: string; currency: string } }

export function verifyConfirmation(c: Confirmation) {
  const o = c?.operation
  if (!o?.token || !o.shop_process_id) return false
  return o.token === md5(privateKey() + o.shop_process_id + 'confirm' + o.amount + o.currency)
}

export function buildConfirmation(ref: string, amount: number, approved: boolean): Confirmation {
  return { operation: {
    token: confirmationToken(ref, amount), shop_process_id: ref, response: approved ? 'S' : 'N',
    response_details: approved ? 'Procesado correctamente' : 'Rechazada (simulado)', amount: bancardAmount(amount), currency: 'PYG',
  } }
}

// En producción: llamar a vPOS (single_buy) con las credenciales del comercio y devolver la URL de pago.
export async function createPayment(o: { orderNumber: string; amount: number }) {
  if (mode() !== 'mock') throw new Error('Bancard real pendiente: configurar BANCARD_PUBLIC_KEY / BANCARD_PRIVATE_KEY y la integración vPOS')
  const ref = 'BC' + randomBytes(6).toString('hex')
  return { ref, url: `${PUBLIC_URL()}/pay/${ref}`, provider: 'bancard-mock' }
}

export const isMock = () => mode() === 'mock'
