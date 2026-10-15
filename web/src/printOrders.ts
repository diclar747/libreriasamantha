import QRCode from 'qrcode'
import { api } from './api'

// Impresión de pedidos en línea: etiqueta de envío (A6, para pegar en el paquete) y ficha A4 (para preparar el pedido).
// Se arma en una ventana aparte para que el diseño de impresión no dependa del resto de la aplicación.

export type PrintFormat = 'label' | 'sheet'

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const gs = (n: unknown) => 'Gs. ' + Number(n ?? 0).toLocaleString('es-PY')
const when = (v: string) => new Date(v).toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' })
const PAY_LABEL: Record<string, string> = { bancard: 'Tarjeta en línea', transfer: 'Transferencia bancaria', cod: 'Contra entrega' }
const PAY_STATE: Record<string, string> = { pending: 'Pago pendiente', in_review: 'Comprobante en revisión', approved: 'PAGADO', rejected: 'Pago rechazado', refunded: 'Reembolsado', partially_refunded: 'Reembolso parcial' }

function payBadge(o: any) {
  const due = Math.max(0, Number(o.total) - Number(o.paid_amount ?? 0))
  if (o.payment_method === 'cod' && o.payment_status !== 'approved') return { cls: 'cobrar', text: `COBRAR AL ENTREGAR ${gs(due || o.total)}` }
  if (o.payment_status === 'approved') return { cls: 'pagado', text: 'PAGADO' }
  return { cls: 'pend', text: PAY_STATE[o.payment_status] ?? o.payment_status }
}

function party(o: any) {
  const name = o.recipient_name || o.customer_name
  const phones = [o.recipient_phone, o.phone].filter(Boolean).filter((p, i, a) => a.indexOf(p) === i)
  const addr = [o.address, o.neighborhood && (/^barrio\b/i.test(o.neighborhood) ? o.neighborhood : `Barrio ${o.neighborhood}`)].filter(Boolean).join(' · ')
  const place = [o.city_name, o.department && o.department !== o.city_name ? o.department : null].filter(Boolean).join(' — ')
  return { name, phones, addr, place }
}

function label(o: any, shop: any, qr: string) {
  const p = party(o); const b = payBadge(o); const pickup = o.delivery_method === 'pickup'
  const units = o.items.reduce((s: number, i: any) => s + Number(i.qty), 0)
  return `<section class="page label">
    <header><div><b class="shop">${esc(shop.name)}</b><div class="small">${esc(shop.phone ?? '')}${shop.address ? ' · ' + esc(shop.address) : ''}</div></div><img src="${qr}" alt=""></header>
    <div class="num"><span>PEDIDO</span><b>${esc(o.number)}</b><span class="small">${esc(when(o.created_at))}</span></div>
    <div class="to"><div class="k">${pickup ? 'RETIRA EN EL LOCAL' : 'DESTINATARIO'}</div>
      <div class="name">${esc(p.name)}</div>
      <div class="phone">${p.phones.map((x) => '☎ ' + esc(x)).join('<br>')}</div>
      ${pickup ? '' : `<div class="addr">${esc(p.addr)}</div><div class="place">${esc(p.place)}</div>${o.address_reference ? `<div class="ref">Ref.: ${esc(o.address_reference)}</div>` : ''}`}
    </div>
    <div class="badge ${b.cls}">${esc(b.text)}</div>
    <div class="items"><div class="k">CONTENIDO · ${units} ${units === 1 ? 'unidad' : 'unidades'}</div>
      ${o.items.slice(0, 8).map((i: any) => `<div class="it"><b>${esc(i.qty)}×</b> ${esc(i.name)}</div>`).join('')}${o.items.length > 8 ? `<div class="it small">… y ${o.items.length - 8} más</div>` : ''}</div>
    ${o.customer_note || o.delivery_note ? `<div class="note"><b>Nota:</b> ${esc(o.customer_note || o.delivery_note)}</div>` : ''}
    ${o.carrier ? `<div class="small">Transporte: ${esc(o.carrier)}${o.tracking_number ? ' · ' + esc(o.tracking_number) : ''}</div>` : ''}
  </section>`
}

function sheet(o: any, shop: any, qr: string) {
  const p = party(o); const b = payBadge(o); const pickup = o.delivery_method === 'pickup'
  const fee = Number(o.delivery_fee ?? 0)
  return `<section class="page sheet">
    <header><div><b class="shop">${esc(shop.name)}</b><div class="small">${esc(shop.phone ?? '')}${shop.address ? ' · ' + esc(shop.address) : ''}</div></div>
      <div class="r"><div class="num"><span>PEDIDO</span><b>${esc(o.number)}</b></div><div class="small">${esc(when(o.created_at))}</div></div><img src="${qr}" alt=""></header>
    <div class="cols">
      <div class="box"><div class="k">${pickup ? 'CLIENTE · RETIRA EN EL LOCAL' : 'ENVIAR A'}</div>
        <div class="name">${esc(p.name)}</div>
        <div>${p.phones.map((x) => '☎ ' + esc(x)).join(' &nbsp; ')}</div>
        ${o.email ? `<div>✉ ${esc(o.email)}</div>` : ''}
        ${pickup ? '' : `<div class="addr">${esc(p.addr)}</div><div>${esc(p.place)}</div>${o.address_reference ? `<div>Ref.: ${esc(o.address_reference)}</div>` : ''}`}
        ${o.recipient_name && o.recipient_name !== o.customer_name ? `<div class="small">Pidió: ${esc(o.customer_name)} ${esc(o.phone ?? '')}</div>` : ''}</div>
      <div class="box"><div class="k">DATOS DEL CLIENTE Y FACTURA</div>
        <div><b>Cliente:</b> ${esc(o.customer_name)}</div>
        <div><b>Facturar a:</b> ${esc(o.billing_name || o.customer_name)}</div>
        <div><b>RUC / CI:</b> ${esc(o.billing_ruc || o.ruc || '—')}</div>
        <div><b>Pago:</b> ${esc(PAY_LABEL[o.payment_method] ?? o.payment_method)}</div>
        <div class="badge ${b.cls}">${esc(b.text)}</div></div>
    </div>
    <table><thead><tr><th>Cód.</th><th>Producto</th><th class="n">Cant.</th><th class="n">Precio</th><th class="n">Subtotal</th><th class="c">✓</th></tr></thead>
      <tbody>${o.items.map((i: any) => `<tr><td>${esc(i.code ?? '')}</td><td>${esc(i.name)}${i.location ? `<div class="small">Ubic.: ${esc(i.location)}</div>` : ''}</td><td class="n"><b>${esc(i.qty)}</b></td><td class="n">${gs(i.unit_price)}</td><td class="n">${gs(Number(i.qty) * Number(i.unit_price))}</td><td class="c">☐</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="n">Productos</td><td class="n">${gs(o.subtotal)}</td><td></td></tr>
        ${Number(o.discount) > 0 ? `<tr><td colspan="4" class="n">Descuento${o.coupon_code ? ' ' + esc(o.coupon_code) : ''}</td><td class="n">− ${gs(o.discount)}</td><td></td></tr>` : ''}
        ${pickup ? '' : `<tr><td colspan="4" class="n">Delivery${fee === 0 ? ' (gratis)' : ''}</td><td class="n">${gs(fee)}</td><td></td></tr>`}
        <tr class="tot"><td colspan="4" class="n">TOTAL</td><td class="n">${gs(o.total)}</td><td></td></tr></tfoot></table>
    ${o.customer_note || o.delivery_note ? `<div class="box"><div class="k">NOTAS DEL CLIENTE</div>${esc(o.customer_note)}${o.delivery_note ? '<br>' + esc(o.delivery_note) : ''}</div>` : ''}
    <div class="sign"><div>Preparado por: ______________________</div><div>Fecha: ____ / ____ / ______</div><div>${pickup ? 'Retirado por' : 'Recibido por'}: ______________________</div></div>
  </section>`
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font:12px/1.35 'Segoe UI',Arial,sans-serif;color:#111}
.page{page-break-after:always;overflow:hidden}.page:last-child{page-break-after:auto}
header{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}
header img{width:62px;height:62px}.shop{font-size:15px}.small{font-size:10px;color:#444}.k{font-size:9px;letter-spacing:.08em;color:#555;font-weight:700;margin-bottom:3px}
.num{display:flex;align-items:baseline;gap:8px}.num span{font-size:10px;color:#555;font-weight:700}.num b{font-size:20px}
.badge{border:2px solid #111;text-align:center;font-weight:800;padding:5px;margin:6px 0;border-radius:4px}.badge.cobrar{background:#111;color:#fff;font-size:15px}.badge.pagado{font-size:14px}.badge.pend{font-size:11px;border-style:dashed}
.label{width:105mm;height:148mm;padding:6mm}.label .to{border:2px solid #111;border-radius:6px;padding:8px;margin:6px 0}.label .name{font-size:19px;font-weight:800;line-height:1.15}
.label .phone{font-size:16px;font-weight:700;margin:3px 0}.label .addr{font-size:14px;font-weight:600}.label .place{font-size:15px;font-weight:800}.label .ref{font-size:11px;margin-top:2px}
.label .items{margin-top:4px}.label .it{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.label .note{border:1px dashed #555;padding:4px;margin-top:6px;font-size:10px}
.sheet{width:190mm;padding:0}.sheet header .r{text-align:right}.cols{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}.box{border:1px solid #888;border-radius:5px;padding:7px;margin-bottom:8px}.cols .box{margin:0}
.sheet .name{font-size:16px;font-weight:800}.sheet .addr{font-weight:600}table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border-bottom:1px solid #bbb;padding:4px 5px;text-align:left;vertical-align:top}th{font-size:10px;background:#eee}
.n{text-align:right}.c{text-align:center;width:24px}.tot td{font-weight:800;font-size:14px;border-top:2px solid #111}.sign{display:flex;justify-content:space-between;gap:10px;margin-top:22px;font-size:11px}
`

export async function printOrders(ids: number[], format: PrintFormat) {
  // La ventana se abre primero (con el clic del usuario) para que el navegador no la bloquee.
  const w = window.open('', '_blank')
  if (!w) throw new Error('El navegador bloqueó la ventana de impresión. Permití las ventanas emergentes para este sitio.')
  w.document.write('<p style="font:14px sans-serif;padding:20px">Preparando la impresión…</p>')
  try {
    const data = await api<{ shop: any; orders: any[] }>(`/orders/print?ids=${ids.join(',')}`)
    const qrs = await Promise.all(data.orders.map((o) => QRCode.toDataURL(o.number, { margin: 0, width: 160 })))
    const pages = data.orders.map((o, i) => (format === 'label' ? label(o, data.shop, qrs[i]) : sheet(o, data.shop, qrs[i]))).join('')
    const size = format === 'label' ? 'A6' : 'A4'
    w.document.open()
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${format === 'label' ? 'Etiquetas de envío' : 'Fichas de pedido'} (${data.orders.length})</title><style>@page{size:${size};margin:${format === 'label' ? '0' : '10mm'}}${CSS}</style></head><body>${pages}<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>`)
    w.document.close()
  } catch (e) { w.close(); throw e }
}
