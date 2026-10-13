import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, gs, useApp } from '../api'
import { Icon, type IconName } from '../components/Icons'
import QRCode from 'qrcode'
import { Scanner, useKeyboardScanner } from '../components/Scanner'
import { Field, Modal, Money } from '../ui'

interface Line { id: number; name: string; price: number; qty: number; discount: number; available: number | null; service: boolean; image_url?: string | null; list?: number; promo?: string | null; reason?: string }
const METHODS: { key: string; label: string; icon: IconName; detail: string }[] = [
  { key: 'cash', label: 'Efectivo', icon: 'wallet', detail: 'Billetes y monedas' },
  { key: 'card', label: 'Tarjeta', icon: 'card', detail: 'Débito o crédito' },
  { key: 'transfer', label: 'Transferencia', icon: 'transfer', detail: 'Pago bancario' },
  { key: 'check', label: 'Cheque', icon: 'check', detail: 'Pago con cheque' },
]
const productIcon = (name: string, service: boolean): IconName => service ? 'print' : /libro|biblia|quijote|lectura/i.test(name) ? 'book' : 'box'

export default function Pos() {
  const { toast, user } = useApp()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [cart, setCart] = useState<Line[]>([])
  const [pays, setPays] = useState<Record<string, string>>({})
  const [customers, setCustomers] = useState<any[]>([])
  const [customerId, setCustomerId] = useState('')
  const [onCredit, setOnCredit] = useState(false)
  const [cashOpen, setCashOpen] = useState<boolean | null>(null)
  const [last, setLast] = useState<any>(null)
  const [held, setHeld] = useState<any[]>([])
  const [wo, setWo] = useState<any>(null)
  const [ready, setReady] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [activeHeldId, setActiveHeldId] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [cam, setCam] = useState<'off' | 'single' | 'continuous'>('off')
  const [phone, setPhone] = useState<{ id: number; token: string; qr: string; status: string } | null>(null)
  const [disc, setDisc] = useState<any>(null)
  const [auth, setAuth] = useState<any>(null)
  const [approval, setApproval] = useState<string | null>(null)
  const [saleReason, setSaleReason] = useState('')
  const [globalDisc, setGlobalDisc] = useState(0)
  const cancelTrigger = useRef<HTMLButtonElement>(null)
  const cancelBack = useRef<HTMLButtonElement>(null)

  const loadHeld = () => api('/held').then(setHeld).catch(() => {})
  useEffect(() => {
    api('/cash/current').then((c) => setCashOpen(!!c.session)).catch(() => setCashOpen(false))
    api('/customers').then(setCustomers).catch(() => {})
    loadHeld()
    api('/workorders?status=ready').then(setReady).catch(() => {})
  }, [])
  useEffect(() => {
    const t = setTimeout(() => api('/products?q=' + encodeURIComponent(q)).then(setResults).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    if (!confirmCancel) return
    cancelBack.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setConfirmCancel(false); cancelTrigger.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmCancel])

  const subtotal = useMemo(() => cart.reduce((s, l) => s + l.price * l.qty - l.discount, 0), [cart])
  const total = Math.max(0, subtotal - globalDisc)
  const tendered = Object.values(pays).reduce((s, v) => s + (Number(v) || 0), 0)
  const due = Math.max(0, total - Number(wo?.deposit ?? 0))
  const diff = tendered - due
  const creditAmount = Math.max(0, -diff)
  const change = Math.max(0, diff)
  const cashGiven = Number(pays.cash) || 0
  const invalidOverpayment = change > cashGiven
  const selectedCustomer = customers.find((c) => String(c.id) === customerId)
  const needsCustomer = onCredit && creditAmount > 0 && !customerId
  const availableCredit = selectedCustomer ? Math.max(0, Number(selectedCustomer.credit_limit) - Number(selectedCustomer.balance)) : 0
  const creditExceedsLimit = onCredit && creditAmount > availableCredit && !!selectedCustomer
  const canCharge = cart.length > 0 && !busy && !invalidOverpayment && (diff >= 0 || onCredit) && !needsCustomer && !creditExceedsLimit

  function add(p: any) {
    if (wo) { toast('Terminá el cobro de la impresión antes de agregar otros productos', true); return }
    setCart((c) => {
      const i = c.findIndex((l) => l.id === p.id)
      if (i >= 0) return c.map((l, j) => j === i && (l.service || l.available === null || l.qty < l.available) ? { ...l, qty: l.qty + 1 } : l)
      return [...c, { id: p.id, name: p.name, price: Number(p.sell_price ?? p.price), qty: 1, discount: 0, available: p.available ?? null, service: p.kind === 'service', image_url: p.image_url, list: Number(p.price), promo: p.on_offer ? p.offer_label_now : null }]
    })
  }
  function changeQty(id: number, by: number) {
    setCart((current) => current.flatMap((line) => {
      if (line.id !== id) return [line]
      const qty = line.qty + by
      if (qty < 1) return []
      if (!line.service && line.available !== null && qty > line.available) return [line]
      return [{ ...line, qty }]
    }))
  }
  function togglePayment(method: string) {
    setPays((current) => {
      if (method in current) { const next = { ...current }; delete next[method]; return next }
      return { ...current, [method]: String(Math.max(0, due - tendered)) }
    })
  }
  function setPaymentAmount(method: string, raw: string) {
    const amount = raw === '' ? '' : String(Math.max(0, Math.trunc(Number(raw) || 0)))
    setPays((current) => ({ ...current, [method]: amount }))
  }
  function onEnter() {
    // Lector de códigos de barras: coincidencia exacta agrega directo
    const exact = results.find((r) => r.barcode === q || r.isbn === q || r.code === q) ?? (results.length === 1 ? results[0] : null)
    if (exact) { add(exact); setQ('') }
  }
  const addByCode = async (code: string, source = 'lector') => {
    try { const p = await api('/products/lookup?code=' + encodeURIComponent(code)); if (!p.active) { toast(`"${p.name}" está inactivo`, true); return } if (p.kind === 'product' && p.available <= 0) { toast(`"${p.name}" está agotado`, true); return } add(p); toast(`+1 ${p.name}`) } catch { toast(`No existe un producto con el código ${code} (${source})`, true) }
  }
  useKeyboardScanner((code) => addByCode(code, 'lector USB'), cashOpen === true && !wo)
  async function linkPhone() {
    try {
      const l = await api('/scan/links', { body: { purpose: 'sale' } })
      const url = location.origin.replace(/^http:/, location.hostname === 'localhost' ? 'http:' : 'https:') + l.path
      setPhone({ id: l.id, token: l.token, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }), status: 'pending' })
    } catch (e: any) { toast(e.message, true) }
  }
  useEffect(() => {
    if (!phone) return
    const t = setInterval(async () => {
      try {
        const st = await api('/scan/links/' + phone.id)
        if (st.status !== phone.status) setPhone((p) => (p ? { ...p, status: st.status } : p))
        if (st.status === 'expired' || st.status === 'closed') { setPhone(null); toast('El celular se desvinculó (venció el enlace)', true); return }
        for (const ev of await api(`/scan/links/${phone.id}/events`)) await addByCode(ev.code, 'celular')
      } catch { /* sin conexión: reintenta */ }
    }, 1500)
    return () => clearInterval(t)
  }, [phone?.id])
  useEffect(() => () => { if (phone) api('/scan/links/' + phone.id, { method: 'DELETE' }).catch(() => {}) }, [])

  async function loadWorkOrder(w: any) {
    const [svc] = await api('/products?q=IMP-SERV')
    setWo(w); setCart([{ id: svc.id, name: `${w.number} · ${w.description}`, price: Number(w.price), qty: 1, discount: 0, available: 1, service: true }])
  }
  const reset = () => { setGlobalDisc(0); setSaleReason(''); setApproval(null); setWo(null); setCart([]); setPays({}); setCustomerId(''); setOnCredit(false); setActiveHeldId(null); setConfirmCancel(false); input.current?.focus() }

  async function charge() {
    if (!canCharge) return
    setBusy(true)
    try {
      const payments = Object.entries(pays).filter(([, v]) => Number(v) > 0).map(([method, v]) => ({ method, amount: Number(v) }))
      const s = await api('/sales', {
        body: {
          customerId: customerId ? Number(customerId) : null, onCredit, workOrderId: wo?.id,
          items: cart.map((l) => ({ productId: l.id, qty: l.qty, discount: l.discount })), payments, discount: globalDisc, discountReason: saleReason || cart.map((l) => l.reason).find(Boolean) || undefined, approvalToken: approval ?? undefined,
        },
      })
      let heldCleanupFailed = false
      if (activeHeldId) await api('/held/' + activeHeldId, { method: 'DELETE' }).catch(() => { heldCleanupFailed = true })
      setLast(s); reset(); loadHeld()
      toast(heldCleanupFailed ? `Venta ${s.number} registrada; revisá la lista de suspendidas` : `Venta ${s.number} registrada`, heldCleanupFailed)
      api('/products?q=' + encodeURIComponent(q)).then(setResults).catch(() => {})
    } catch (e: any) {
      // un responsable puede autorizar descuentos grandes o ventas bajo costo con su clave
      if (/autorizaci|por debajo del costo|autorizaste|motivo del descuento/i.test(e.message)) setAuth({ message: e.message, username: '', password: '' }); else toast(e.message, true)
    } finally { setBusy(false) }
  }
  async function hold(kind: 'hold' | 'quote') {
    if (!cart.length || busy) return
    setBusy(true)
    try {
      await api('/held', { body: { kind, label: cart.map((l) => l.name).slice(0, 2).join(', '), cart } })
      let heldCleanupFailed = false
      if (activeHeldId) await api('/held/' + activeHeldId, { method: 'DELETE' }).catch(() => { heldCleanupFailed = true })
      toast(heldCleanupFailed ? 'Guardado, pero el registro anterior sigue en la lista' : kind === 'hold' ? 'Venta suspendida' : 'Presupuesto guardado', heldCleanupFailed); reset(); loadHeld()
    } catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }
  async function resume(h: any) {
    if (cart.length) { toast('Terminá o cancelá la venta actual antes de retomar otra', true); return }
    setCart(h.cart); setActiveHeldId(h.id); setPays({}); setOnCredit(false); setCustomerId('')
  }
  function removeLine(id: number) {
    if (wo && cart.some((line) => line.id === id)) { reset(); return }
    setCart((current) => current.filter((line) => line.id !== id))
  }

  const units = cart.reduce((s, l) => s + l.qty, 0)
  if (cashOpen === false) return <div className="card"><h1>Caja cerrada</h1><p className="muted">Abrí la caja en la sección <b>Caja</b> para empezar a vender.</p></div>

  return (
    <>
      <div className="head pos-page-head"><div><span className="pos-kicker">CAJA Y VENTAS</span><h1>Punto de venta</h1><p className="muted">Agregá productos, elegí cómo pagar y confirmá la venta.</p></div>{last && <div className="pos-last"><span className="pill ok">Última venta {last.number} · {gs(last.total)}{last.change_given > 0 && ` · vuelto ${gs(last.change_given)}`}</span><Link to="/sales">{['owner', 'admin'].includes(user?.role ?? '') ? 'Ver o anular venta' : 'Ver venta'}</Link></div>}</div>
      <div className="pos pos-modern">
        <div className="pos-left">
          <section className="card pos-catalog" aria-label="Catálogo de productos">
            <div className="pos-section-heading"><div><span className="pos-kicker">SELECCIONÁ PRODUCTOS</span><h2>Catálogo</h2></div><span className="pos-catalog-count">{results.length} disponibles para elegir</span></div>
            <div className="pos-search"><Icon name="search" size={19} /><input ref={input} autoFocus aria-label="Buscar productos" placeholder="Buscar por nombre, código o escanear código de barras…" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onEnter()} /><button type="button" className="small" onClick={() => setCam('single')} title="Escanear con la cámara de esta pantalla" aria-label="Escanear con la cámara">📷</button><button type="button" className="small" onClick={() => setCam('continuous')} title="Escanear varios productos seguidos" aria-label="Escaneo continuo">📷 Varios</button><button type="button" className="small" onClick={linkPhone} title="Usar el celular como lector" aria-label="Usar el celular como lector">📱</button></div>
            <div className="results pos-results">
              {results.map((p) => (
                <button key={p.id} className="tile pos-product" onClick={() => add(p)} disabled={p.kind === 'product' && p.available <= 0} aria-label={`${p.name}, ${gs(p.sell_price ?? p.price)}. Agregar al carrito`}>
                  <span className="pos-product-visual">{p.image_url ? <img src={p.image_url} alt="" loading="lazy" /> : <Icon name={productIcon(p.name, p.kind === 'service')} size={29} />}</span>
                  <span className="pos-product-body"><span className="pos-product-name">{p.name}</span><span className="pos-product-code">{p.code}</span><span className="pos-product-bottom"><strong>{gs(p.sell_price ?? p.price)}{p.on_offer && <s className="muted" style={{ marginLeft: 6, fontWeight: 400, fontSize: 12 }}>{gs(p.price)}</s>}</strong>{p.kind === 'product' && <small className={p.available <= p.min_stock ? 'low' : ''}>{p.available} disp.</small>}</span></span>
                  <span className="pos-product-add" aria-hidden="true"><Icon name="plus" size={16} /></span>
                </button>
              ))}
            </div>
            {!results.length && <p className="pos-no-results muted">No hay productos con esa búsqueda.</p>}
          </section>
          {ready.length > 0 && !wo && (
            <div className="card pos-extra">
              <h2>Trabajos de impresión listos para entregar</h2>
              {ready.map((w) => <div key={w.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span><b>{w.number}</b> {w.customer_name} · {w.description} · {gs(w.price)}{Number(w.deposit) > 0 && <span className="pill ok" style={{ marginLeft: 6 }}>anticipo {gs(w.deposit)}</span>}</span>
                <button onClick={() => loadWorkOrder(w)} disabled={!!cart.length || busy}>Cobrar</button></div>)}
            </div>
          )}
          {held.length > 0 && (
            <div className="card pos-extra">
              <h2>Suspendidas y presupuestos</h2>
              {held.map((h) => <div key={h.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span><span className="pill">{h.kind === 'quote' ? 'Presupuesto' : 'Suspendida'}</span> {h.label}</span>
                <button onClick={() => resume(h)} disabled={!!cart.length || busy}>Retomar</button></div>)}
            </div>
          )}
        </div>
        <section className="card pos-cart" id="cart" aria-label="Venta actual">
          <div className="pos-cart-head"><div className="pos-cart-icon"><Icon name="bag" size={22} /></div><div><span className="pos-kicker">VENTA ACTUAL</span><h2>Carrito <span>{units}</span></h2></div><button ref={cancelTrigger} className="pos-clear" onClick={() => setConfirmCancel(true)} disabled={!cart.length || busy}><Icon name="trash" size={16} /> Cancelar venta</button></div>
          <div className="pos-cart-items">
            {cart.map((line) => (
              <div className="pos-cart-line" key={line.id}>
                <span className="pos-cart-thumb">{line.image_url ? <img src={line.image_url} alt="" /> : <Icon name={productIcon(line.name, line.service)} size={21} />}</span>
                <div className="pos-line-main"><b>{line.name}</b><small>{gs(line.price)} por unidad{line.promo && <span className="pill ok" style={{ marginLeft: 6 }}>{line.promo}</span>}{line.discount > 0 && <span className="pill warn" style={{ marginLeft: 6 }}>desc. {gs(line.discount)}</span>}</small><div className="pos-stepper"><button onClick={() => changeQty(line.id, -1)} disabled={!!wo} aria-label={`Restar una unidad de ${line.name}`}><Icon name="minus" size={14} /></button><span aria-label={`${line.qty} unidades`}>{line.qty}</span><button onClick={() => changeQty(line.id, 1)} disabled={!!wo || (!line.service && line.available !== null && line.qty >= line.available)} aria-label={`Sumar una unidad de ${line.name}`}><Icon name="plus" size={14} /></button></div></div>
                <div className="pos-line-end"><strong>{gs(line.price * line.qty - line.discount)}</strong><button onClick={() => setDisc({ id: line.id, name: line.name, base: line.price * line.qty, kind: 'pct', value: line.discount ? Math.round((line.discount / (line.price * line.qty)) * 100) : 0, reason: line.reason ?? '' })} aria-label={`Descuento a ${line.name}`} title="Descuento" disabled={!!wo}>%</button><button onClick={() => removeLine(line.id)} aria-label={`Quitar ${line.name}`} title="Quitar producto"><Icon name="trash" size={15} /></button></div>
              </div>
            ))}
            {!cart.length && <div className="pos-empty"><span><Icon name="bag" size={34} /></span><b>Tu carrito está vacío</b><p>Elegí un producto del catálogo para empezar una venta.</p></div>}
          </div>
          {globalDisc > 0 && <div className="pos-deposit"><span>Descuento general</span><b>− {gs(globalDisc)}</b><span>{saleReason}</span><button className="small" onClick={() => { setGlobalDisc(0); setSaleReason('') }}>Quitar</button></div>}
          <div className="pos-cart-total"><span>{units} {units === 1 ? 'producto' : 'productos'}{cart.length > 0 && !wo && <button className="small" style={{ marginLeft: 8 }} onClick={() => setDisc({ id: 0, name: 'toda la venta', base: subtotal, kind: 'pct', value: 0, reason: saleReason })}>Descuento general</button>}</span><div><small>Total de la venta</small><strong>{gs(total)}</strong></div></div>
          {wo && Number(wo.deposit) > 0 && <div className="pos-deposit"><span>Anticipo ya cobrado</span><b>− {gs(wo.deposit)}</b><span>Saldo pendiente</span><b>{gs(due)}</b></div>}
          <div className="pos-payment">
            <div className="pos-payment-heading"><div><span className="pos-kicker">COBRO</span><h3>Forma de pago</h3></div><span>Podés combinar medios</span></div>
            <label className="pos-customer">Cliente<select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Consumidor final</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <div className="pos-pay-label">Pago al contado</div>
            <div className="pos-methods">{METHODS.map(({ key, label, icon, detail }) => <button key={key} type="button" className={'pos-method' + (key in pays ? ' selected' : '')} aria-pressed={key in pays} onClick={() => togglePayment(key)} disabled={!cart.length}><Icon name={icon} size={21} /><span><b>{label}</b><small>{detail}</small></span></button>)}</div>
            {METHODS.filter(({ key }) => key in pays).map(({ key, label, icon }) => <label className="pos-pay-input" key={key}><span><Icon name={icon} size={17} /> {label}</span><div><small>Gs.</small><input type="number" min={0} step={1} inputMode="numeric" aria-label={`Monto en ${label.toLowerCase()}`} value={pays[key]} onChange={(e) => setPaymentAmount(key, e.target.value)} /></div></label>)}
            <button type="button" className={'pos-credit' + (onCredit ? ' selected' : '')} aria-pressed={onCredit} onClick={() => setOnCredit((current) => !current)} disabled={!cart.length}><Icon name="credit" size={22} /><span><b>Venta a crédito</b><small>Dejar el saldo pendiente al cliente</small></span><span className="pos-credit-check">{onCredit ? '✓' : ''}</span></button>
            {onCredit && <div className="pos-credit-info">{creditAmount > 0 ? <><span>Saldo a crédito</span><b>{gs(creditAmount)}</b></> : <span>El pago seleccionado cubre el total.</span>}{selectedCustomer && <small>Cupo disponible: {gs(availableCredit)}</small>}</div>}
            {needsCustomer && <p className="pos-payment-warning">Elegí un cliente para registrar el saldo a crédito.</p>}
            {creditExceedsLimit && <p className="pos-payment-warning">El saldo supera el cupo disponible del cliente.</p>}
            {invalidOverpayment && <p className="pos-payment-warning">El vuelto solo puede salir del efectivo recibido. Revisá los importes.</p>}
            {!onCredit && creditAmount > 0 && cart.length > 0 && <p className="pos-payment-hint">Faltan {gs(creditAmount)} para completar el pago.</p>}
            {change > 0 && !invalidOverpayment && <div className="pos-change"><span>Vuelto en efectivo</span><b>{gs(change)}</b></div>}
          </div>
          <button className="primary pos-charge" disabled={!canCharge} onClick={charge}><Icon name="tick" size={20} />{busy ? 'Procesando…' : onCredit && creditAmount > 0 ? 'Confirmar venta a crédito' : 'Cobrar venta'}</button>
          <div className="pos-secondary-actions"><button disabled={!cart.length || busy || !!wo} onClick={() => hold('hold')}><Icon name="pause" size={16} /> Suspender</button><button disabled={!cart.length || busy || !!wo} onClick={() => hold('quote')}><Icon name="receipt" size={16} /> Presupuesto</button></div>
        </section>
      </div>
      {cam !== 'off' && <Modal title={cam === 'continuous' ? 'Escaneo continuo' : 'Escanear producto'} onClose={() => setCam('off')} footer={<button className="primary" onClick={() => setCam('off')}>Listo</button>}>
        <Scanner continuous={cam === 'continuous'} onClose={() => setCam('off')} onScan={(r) => addByCode(r.code, 'cámara')} hint={cam === 'continuous' ? 'Cada lectura suma 1 al carrito' : undefined} />
        <p className="muted">{cart.reduce((a, l) => a + l.qty, 0)} unidades en el carrito · {gs(total)}</p></Modal>}
      {phone && <Modal title="Celular como lector" onClose={() => { api('/scan/links/' + phone.id, { method: 'DELETE' }).catch(() => {}); setPhone(null) }} footer={<button onClick={() => { api('/scan/links/' + phone.id, { method: 'DELETE' }).catch(() => {}); setPhone(null) }}>Desvincular</button>}>
        <div style={{ textAlign: 'center' }}><img src={phone.qr} alt="Código QR para vincular el celular" width={240} height={240} />
          <p><span className={'pill ' + (phone.status === 'linked' ? 'ok' : 'warn')}>{phone.status === 'linked' ? 'Celular vinculado' : 'Esperando al celular'}</span></p>
          <p className="muted">Escaneá este QR con el celular. Cada código que lea con su cámara se suma a este carrito. El enlace vence a los 15 minutos. Podés dejar esta ventana abierta y seguir vendiendo.</p></div></Modal>}
      {disc && <Modal title={'Descuento a ' + disc.name} onClose={() => setDisc(null)} footer={<><button onClick={() => setDisc(null)}>Cancelar</button><button className="primary" disabled={!disc.value} onClick={() => {
        const amount = disc.kind === 'pct' ? Math.round(disc.base * Math.min(disc.value, 100) / 100) : Math.min(disc.value, disc.base)
        if (disc.id === 0) { setGlobalDisc(amount); setSaleReason(disc.reason) } else setCart((c) => c.map((l) => (l.id === disc.id ? { ...l, discount: amount, reason: disc.reason } : l)))
        setDisc(null) }}>Aplicar</button></>}>
        <div className="form"><Field label="Tipo"><select value={disc.kind} onChange={(e) => setDisc({ ...disc, kind: e.target.value, value: 0 })}><option value="pct">Porcentaje</option><option value="amt">Monto en Gs.</option></select></Field>
          <Field label={disc.kind === 'pct' ? 'Porcentaje' : 'Monto'}>{disc.kind === 'pct' ? <input type="number" min={0} max={100} value={disc.value} onChange={(e) => setDisc({ ...disc, value: Number(e.target.value) })} /> : <Money value={disc.value} onChange={(n) => setDisc({ ...disc, value: n })} />}</Field>
          <Field label="Motivo" span={2}><input value={disc.reason} onChange={(e) => setDisc({ ...disc, reason: e.target.value })} placeholder="Cliente frecuente, envase dañado…" /></Field></div>
        <p className="muted">Descuento: <b>{gs(disc.kind === 'pct' ? Math.round(disc.base * Math.min(disc.value, 100) / 100) : Math.min(disc.value, disc.base))}</b> sobre {gs(disc.base)}. Hasta el 10% lo aplica el cajero; más requiere la clave de un responsable.</p></Modal>}
      {auth && <Modal title="Requiere autorización" onClose={() => setAuth(null)} footer={<><button onClick={() => setAuth(null)}>Cancelar</button><button className="primary" disabled={!auth.username || !auth.password} onClick={async () => {
        try { const r = await api('/sales/authorize', { body: { username: auth.username, password: auth.password } }); setApproval(r.token); if (!saleReason) setSaleReason(cart.find((l) => l.reason)?.reason ?? 'Autorizado por ' + r.approver); toast('Autorizado por ' + r.approver + ': volvé a cobrar'); setAuth(null) } catch (e: any) { toast(e.message, true) } }}>Autorizar</button></>}>
        <div className="warnbox">{auth.message}</div><p className="muted">Un responsable (administrador) ingresa su usuario y contraseña. Queda registrado quién autorizó y por qué.</p>
        <div className="form"><Field label="Usuario del responsable"><input autoFocus value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} /></Field><Field label="Contraseña"><input type="password" value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} /></Field>
          <Field label="Motivo" span={2}><input value={saleReason} onChange={(e) => setSaleReason(e.target.value)} placeholder="Motivo del descuento" /></Field></div></Modal>}
      {confirmCancel && <div className="pos-dialog-backdrop"><div className="pos-dialog card" role="dialog" aria-modal="true" aria-labelledby="pos-cancel-title"><span className="pos-dialog-icon"><Icon name="trash" size={23} /></span><h2 id="pos-cancel-title">¿Cancelar esta venta?</h2><p>Se quitarán los {units} {units === 1 ? 'producto' : 'productos'} del carrito y los importes cargados. La venta todavía no fue registrada.</p><div><button ref={cancelBack} onClick={() => { setConfirmCancel(false); cancelTrigger.current?.focus() }}>Seguir vendiendo</button><button className="danger" onClick={() => { reset(); toast('Venta actual cancelada') }}>Sí, cancelar venta</button></div></div></div>}
      {cart.length > 0 && <a href="#cart" className="pos-bar"><span>{units} {units === 1 ? 'artículo' : 'artículos'}</span><b>{gs(total)}</b><span>Ver carrito ›</span></a>}
    </>
  )
}
