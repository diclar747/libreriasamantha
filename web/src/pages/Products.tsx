import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, gs, useApp } from '../api'
import { Scanner } from '../components/Scanner'
import { EmptyRow, Field, fileToBase64, fmtDate, fmtDateTime, Modal, Money, openAuthed, Pager, qs, Status, Tabs, useAsk, useDebounced, useQuery, NumInput } from '../ui'

const CSV_COLS = ['code', 'name', 'category', 'subcategory', 'brand', 'barcode', 'isbn', 'cost', 'price', 'tax_rate', 'min_stock', 'purchase_unit', 'units_per_purchase', 'kind']
const NUMERIC = ['cost', 'price', 'tax_rate', 'min_stock', 'units_per_purchase']
function parseCsv(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const split = (l: string) => l.split(new RegExp(`${sep}(?=(?:[^"]*"[^"]*")*[^"]*$)`)).map((c) => c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'))
  const head = split(lines[0]).map((h) => h.toLowerCase())
  return lines.slice(1).map((l) => {
    const cells = split(l); const row: Record<string, any> = {}
    head.forEach((h, i) => { if (!CSV_COLS.includes(h) || cells[i] === undefined || cells[i] === '') return; row[h] = NUMERIC.includes(h) ? Number(cells[i].replace(/\./g, '').replace(',', '.')) : cells[i] })
    return row
  })
}

const EMPTY = {
  code: '', barcode: '', isbn: '', qr_code: '', name: '', short_description: '', description: '', category: 'Varios', subcategory: '', brand: '', author: '', publisher: '', edition: '', language: '', kind: 'product',
  sale_unit: 'unidad', purchase_unit: 'unidad', units_per_purchase: 1, cost: 0, cost_includes_vat: false, markup_pct: null, price: 0, price_includes_vat: true, wholesale_price: null, tax_rate: 10, min_stock: 0, location: '',
  online_visible: true, active: true, offer_enabled: false, offer_price: null, offer_pct: null, offer_start: '', offer_end: '', offer_channel: 'both', offer_label: '', initial_stock: 0, supplierIds: [] as number[], preferredSupplierId: null as number | null,
}
const STOCK_LABEL: Record<string, string> = { low: 'Stock bajo', out: 'Agotados', ok: 'Con stock normal' }

function ProductForm({ id, onClose, onSaved, canCost, canPrice }: { id: number | null; onClose: () => void; onSaved: () => void; canCost: boolean; canPrice: boolean }) {
  const { toast } = useApp()
  const [tab, setTab] = useState<'datos' | 'precios' | 'oferta' | 'imagenes' | 'proveedores' | 'historial'>('datos')
  const [f, setF] = useState<any>(null)
  const [errs, setErrs] = useState<string | null>(null)
  const [needConfirm, setNeedConfirm] = useState(false)
  const [scan, setScan] = useState<'barcode' | 'isbn' | 'qr_code' | null>(null)
  const [url, setUrl] = useState('')
  const [pending, setPending] = useState<File[]>([]) // fotos elegidas antes de guardar un producto nuevo
  const [calc, setCalc] = useState<any>(null)
  const facets = useQuery<any>('/products/facets')
  const suppliers = useQuery<any[]>('/suppliers')
  const hist = useQuery<any>(id && tab === 'historial' ? `/products/${id}/history` : null)
  const detail = useQuery<any>(id ? `/products/${id}` : null)

  useEffect(() => {
    if (!id) { setF({ ...EMPTY }); return }
    if (detail.data) setF({ ...EMPTY, ...Object.fromEntries(Object.entries(detail.data).map(([k, v]) => [k, v ?? (typeof (EMPTY as any)[k] === 'string' ? '' : v)])), supplierIds: detail.data.suppliers?.map((s: any) => s.supplier_id) ?? [], preferredSupplierId: detail.data.suppliers?.find((s: any) => s.preferred)?.supplier_id ?? null })
  }, [id, detail.data])
  // calculadora: costo / margen / precio con desglose de IVA
  useEffect(() => {
    if (!f || !canCost) return
    const t = setTimeout(() => api('/products/price-calc', { body: { cost: f.cost, cost_includes_vat: f.cost_includes_vat, tax_rate: f.tax_rate, price: f.price || undefined, markup_pct: f.price ? undefined : f.markup_pct ?? undefined } }).then(setCalc).catch(() => setCalc(null)), 250)
    return () => clearTimeout(t)
  }, [f?.cost, f?.cost_includes_vat, f?.tax_rate, f?.price, f?.markup_pct])
  if (!f) return <Modal title="Producto" onClose={onClose}><p className="muted">Cargando…</p></Modal>

  const set = (k: string, v?: any) => (e: any) => setF({ ...f, [k]: v !== undefined ? v : e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const applyMarkup = (m: number | null) => { if (m == null) { setF({ ...f, markup_pct: null }); return } api('/products/price-calc', { body: { cost: f.cost, cost_includes_vat: f.cost_includes_vat, tax_rate: f.tax_rate, markup_pct: m } }).then((r) => setF({ ...f, markup_pct: m, price: r.price })).catch(() => {}) }

  async function save(confirmBelowCost = false) {
    setErrs(null)
    if (!f.name.trim()) { setTab('datos'); setErrs('Escribí el nombre del producto.'); toast('Falta el nombre del producto', true); return }
    if (f.kind === 'product' && !(Number(f.price) > 0)) { setTab('datos'); setErrs('Cargá el precio de venta: está en esta pestaña, al lado del nombre.'); toast('Falta el precio de venta', true); return }
    const body: any = { ...f, confirmBelowCost }
    for (const k of ['code', 'barcode', 'isbn', 'qr_code', 'subcategory', 'brand', 'author', 'publisher', 'edition', 'language', 'location', 'short_description', 'description', 'offer_label', 'offer_start', 'offer_end']) if (body[k] === '') body[k] = null
    for (const k of ['id', 'images', 'suppliers', 'available', 'sell_price', 'on_offer', 'offer_label_now', 'online_price', 'online_on_offer', 'price_net', 'price_vat', 'markup', 'margin', 'stock_value', 'low', 'out', 'stock', 'reserved', 'created_at', 'updated_at', 'image_url', 'image_count', 'low_alert_active']) delete body[k]
    if (id) delete body.initial_stock
    if (!canCost) for (const k of ['cost', 'cost_includes_vat', 'markup_pct']) delete body[k]
    try {
      let failed = 0
      if (id) await api('/products/' + id, { method: 'PUT', body })
      else {
        const created = await api('/products', { body })
        for (const file of pending) { try { await api(`/products/${created.id}/images`, { body: { data: await fileToBase64(file) } }) } catch { failed++ } }
      }
      if (failed) toast(`Producto guardado, pero ${failed} foto(s) no se pudieron subir: abrilo y agregalas de nuevo`, true); else toast(pending.length ? 'Producto guardado con sus fotos' : 'Producto guardado')
      onSaved()
    } catch (e: any) {
      if (/por debajo del costo/.test(e.message) && /Confirmá/.test(e.message)) setNeedConfirm(true); else setErrs(e.message)
    }
  }
  async function addImage(file: File | null, fromUrl?: string) {
    if (!id) { toast('Guardá el producto primero para agregarle imágenes', true); return }
    try { await api(`/products/${id}/images`, { body: fromUrl ? { url: fromUrl } : { data: await fileToBase64(file!) } }); toast('Imagen agregada'); detail.reload(); setUrl('') } catch (e: any) { toast(e.message, true) }
  }
  const imgs: any[] = detail.data?.images ?? []
  const move = async (i: number, d: number) => { const ids = imgs.map((x) => x.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await api(`/products/${id}/images/order`, { method: 'PUT', body: { ids } }); detail.reload() }
  const delImg = async (iid: number) => { await api(`/products/${id}/images/${iid}`, { method: 'DELETE' }); detail.reload() }
  const offerPreview = f.offer_enabled ? (f.offer_price ?? (f.offer_pct ? Math.round(f.price * (1 - f.offer_pct / 100)) : null)) : null
  const catList = facets.data?.categories ?? []

  return (
    <Modal title={id ? `Editar: ${f.name || 'producto'}` : 'Nuevo producto'} onClose={onClose} wide="xl" footer={<><button onClick={onClose}>Cancelar</button><button className="primary" onClick={() => save(false)}>Guardar</button></>}>
      <Tabs value={tab} onChange={setTab} tabs={[['datos', 'Datos'], ['precios', 'Precios e IVA'], ['oferta', 'Oferta'], ['imagenes', 'Imágenes', (id ? imgs.length : pending.length) || undefined], ['proveedores', 'Proveedores'], ...(id ? [['historial', 'Historial'] as ['historial', string]] : [])]} />
      {errs && <div className="errbox">{errs}</div>}
      {needConfirm && <div className="warnbox">El precio (o la oferta) queda <b>por debajo del costo</b>. <button className="small" onClick={() => { setNeedConfirm(false); save(true) }}>Guardar igual</button></div>}

      {tab === 'datos' && <div className="fsecs">
        <section className="fsec">
          <h3>Lo esencial</h3>
          <div className="form fgrid">
            <Field label="Nombre *" span={2}><input value={f.name} onChange={set('name')} autoFocus placeholder="Como lo va a ver el cliente" /></Field>
            <Field label="Precio de venta (IVA incluido) *"><Money value={f.price} onChange={(n) => setF({ ...f, price: n })} /></Field>
            <Field label="Tipo"><select value={f.kind} onChange={set('kind')}><option value="product">Producto</option><option value="service">Servicio</option></select></Field>
            <Field label="Categoría" span={2}><input list="cats" value={f.category} onChange={set('category')} /></Field><datalist id="cats">{catList.map((c: string) => <option key={c} value={c} />)}</datalist>
            <Field label="Subcategoría" span={2}><input value={f.subcategory} onChange={set('subcategory')} list="subs" /></Field><datalist id="subs">{(facets.data?.subcategories ?? []).filter((s: any) => s.category === f.category).map((s: any) => <option key={s.v} value={s.v} />)}</datalist>
          </div>
        </section>

        <section className="fsec">
          <h3>Códigos</h3>
          <div className="form fgrid">
            <Field label="Código interno" hint={id ? undefined : 'Si lo dejás vacío se genera solo'}><input value={f.code} onChange={set('code')} /></Field>
            {(['barcode', 'qr_code'] as const).map((k) => (
              <Field key={k} label={{ barcode: 'Código de barras', qr_code: 'Código QR' }[k]}>
                <div className="with-btn"><input value={f[k]} onChange={set(k)} inputMode={k === 'qr_code' ? 'text' : 'numeric'} /><button type="button" title="Escanear con la cámara" aria-label="Escanear con la cámara" onClick={() => setScan(k)}>📷</button></div>
              </Field>
            ))}
            {id && !f.barcode && <div className="fgrid-action"><button type="button" onClick={async () => { try { const r = await api(`/products/${id}/generate-barcode`, { method: 'POST', body: {} }); setF({ ...f, barcode: r.barcode }); toast('Código interno generado') } catch (e: any) { toast(e.message, true) } }}>Generar código de barras</button></div>}
          </div>
        </section>

        <section className="fsec">
          <h3>Detalle</h3>
          <div className="form fgrid">
            <Field label="Marca"><input value={f.brand} onChange={set('brand')} list="brands" /></Field><datalist id="brands">{(facets.data?.brands ?? []).map((b: string) => <option key={b} value={b} />)}</datalist>
            <Field label="Autor"><input value={f.author} onChange={set('author')} /></Field>
            <Field label="Editorial"><input value={f.publisher} onChange={set('publisher')} /></Field>
            <Field label="Edición"><input value={f.edition} onChange={set('edition')} /></Field>
            <Field label="Descripción corta" span={4}><input value={f.short_description} onChange={set('short_description')} maxLength={200} placeholder="Una línea para el listado de la tienda" /></Field>
            <Field label="Descripción completa" span={4}><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
          </div>
        </section>

        <section className="fsec">
          <h3>Unidades y ubicación</h3>
          <div className="form fgrid">
            <Field label="Unidad de venta"><input value={f.sale_unit} onChange={set('sale_unit')} list="units" /></Field>
            <Field label="Unidad de compra"><input value={f.purchase_unit} onChange={set('purchase_unit')} list="units" /></Field><datalist id="units">{(facets.data?.units ?? ['unidad', 'caja', 'paquete', 'resma']).map((u: string) => <option key={u} value={u} />)}</datalist>
            <Field label="Unidades por compra" hint="Cuántas unidades de venta trae una de compra"><NumInput min={1} value={f.units_per_purchase} onChange={(e) => setF({ ...f, units_per_purchase: Math.max(1, Number(e.target.value)) })} /></Field>
            <Field label="Ubicación"><input value={f.location} onChange={set('location')} placeholder="Estante, pasillo…" /></Field>
          </div>
        </section>

        <section className="fsec">
          <h3>Estado</h3>
          <div className="fchecks">
            <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={set('active')} /> Producto activo</label>
            <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.online_visible} onChange={set('online_visible')} /> Visible en la tienda online</label>
          </div>
        </section>
      </div>}

      {tab === 'precios' && <div className="stack">
        <div className="form wide">
          {canCost && <>
            <Field label="Costo (sin IVA salvo que marques)"><Money value={f.cost} onChange={(n) => setF({ ...f, cost: n })} /></Field>
            <label className="inline" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.cost_includes_vat} onChange={set('cost_includes_vat')} /> El costo ya incluye IVA</label>
            <Field label="Margen sobre costo (%)"><NumInput min={0} step="0.5" value={f.markup_pct ?? ''} onChange={(e) => applyMarkup(e.target.value === '' ? null : Number(e.target.value))} /></Field>
          </>}
          <Field label="IVA"><select value={f.tax_rate} onChange={(e) => setF({ ...f, tax_rate: Number(e.target.value) })}><option value={10}>10%</option><option value={5}>5%</option><option value={0}>Exento</option></select></Field>
          <Field label="Precio de venta (IVA incluido) *"><Money value={f.price} onChange={(n) => setF({ ...f, price: n })} /></Field>
          <Field label="Precio mayorista"><Money value={f.wholesale_price} onChange={(n) => setF({ ...f, wholesale_price: n || null })} /></Field>
          <Field label="Stock mínimo" hint="Avisa cuando el disponible llega a este número"><NumInput min={0} value={f.min_stock} onChange={(e) => setF({ ...f, min_stock: Number(e.target.value) })} /></Field>
          {!id && f.kind === 'product' && <Field label="Stock inicial"><NumInput min={0} value={f.initial_stock} onChange={(e) => setF({ ...f, initial_stock: Number(e.target.value) })} /></Field>}
        </div>
        <div className="calc">
          <span>Precio sin IVA: <b>{gs(f.price - Math.round(f.tax_rate === 10 ? f.price / 11 : f.tax_rate === 5 ? f.price / 21 : 0))}</b> · IVA incluido: <b>{gs(f.tax_rate === 10 ? Math.round(f.price / 11) : f.tax_rate === 5 ? Math.round(f.price / 21) : 0)}</b></span>
          {canCost && calc && f.cost > 0 && <span>Costo sin IVA: <b>{gs(calc.cost_net)}</b> · Margen sobre costo: <b>{calc.markup_pct ?? '—'}%</b> · Ganancia sobre venta: <b>{calc.margin_pct ?? '—'}%</b></span>}
          {canCost && calc && f.cost > 0 && f.price > 0 && f.price - (f.tax_rate === 10 ? Math.round(f.price / 11) : f.tax_rate === 5 ? Math.round(f.price / 21) : 0) < calc.cost_net && <b style={{ color: 'var(--danger)' }}>⚠ El precio de venta está por debajo del costo.</b>}
        </div>
        {!canPrice && <div className="warnbox">No tenés permiso para cambiar precios.</div>}
      </div>}

      {tab === 'oferta' && <div className="stack">
        <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={f.offer_enabled} onChange={set('offer_enabled')} /> Oferta activa</label>
        {f.offer_enabled && <div className="form wide">
          <Field label="Precio de oferta"><Money value={f.offer_price} onChange={(n) => setF({ ...f, offer_price: n || null, offer_pct: n ? null : f.offer_pct })} /></Field>
          <Field label="o descuento (%)"><NumInput min={0} max={99} value={f.offer_pct ?? ''} onChange={(e) => setF({ ...f, offer_pct: e.target.value ? Number(e.target.value) : null, offer_price: e.target.value ? null : f.offer_price })} /></Field>
          <Field label="Desde"><input type="date" value={f.offer_start ?? ''} onChange={set('offer_start')} /></Field><Field label="Hasta"><input type="date" value={f.offer_end ?? ''} onChange={set('offer_end')} /></Field>
          <Field label="Dónde aplica"><select value={f.offer_channel} onChange={set('offer_channel')}><option value="both">Local y tienda online</option><option value="local">Solo en el local</option><option value="online">Solo en la tienda online</option></select></Field>
          <Field label="Etiqueta"><input value={f.offer_label} onChange={set('offer_label')} placeholder="Vuelta a clases" maxLength={40} /></Field>
        </div>}
        {offerPreview != null && <div className="calc">Precio normal <s>{gs(f.price)}</s> → oferta <b>{gs(offerPreview)}</b> ({Math.round((1 - offerPreview / f.price) * 100)}% menos){f.offer_end ? ` hasta el ${fmtDate(f.offer_end)}` : ' sin fecha de fin'}</div>}
      </div>}

      {tab === 'imagenes' && <div className="stack">
        {!id && <>
          <div className="gallery">{pending.map((file, i) => <figure key={i}><img src={URL.createObjectURL(file)} alt="" />{i === 0 && <span className="pill ok" style={{ position: 'absolute', top: 6, left: 6 }}>Principal</span>}
            <figcaption><button className="small danger" onClick={() => setPending(pending.filter((_, j) => j !== i))}>✕</button></figcaption></figure>)}</div>
          <label className="drop">📷 Sacá una foto o elegí imágenes (se suben solas al guardar el producto · máximo 8)<input type="file" accept="image/*" multiple hidden onChange={(e) => { setPending([...pending, ...[...(e.target.files ?? [])]].slice(0, 8)); e.target.value = '' }} /></label>
        </>}
        {id && <>
          <div className="gallery">{imgs.map((im, i) => <figure key={im.id}><img src={im.thumb} alt="" />{i === 0 && <span className="pill ok" style={{ position: 'absolute', top: 6, left: 6 }}>Principal</span>}
            <figcaption><button className="small" onClick={() => move(i, -1)} disabled={i === 0}>←</button><button className="small danger" onClick={() => delImg(im.id)}>✕</button><button className="small" onClick={() => move(i, 1)} disabled={i === imgs.length - 1}>→</button></figcaption></figure>)}</div>
          <label className="drop">📷 Sacá una foto o elegí imágenes (JPG, PNG, WebP · se reducen solas · máximo 8)<input type="file" accept="image/*" multiple hidden onChange={async (e) => { for (const file of [...(e.target.files ?? [])]) await addImage(file); e.target.value = '' }} /></label>
          <div className="row"><input style={{ flex: 1 }} placeholder="o pegá la dirección (URL) de una imagen" value={url} onChange={(e) => setUrl(e.target.value)} /><button disabled={!url} onClick={() => addImage(null, url)}>Agregar desde la URL</button></div>
          <p className="muted">La primera imagen es la principal. Se optimizan solas para que la tienda cargue rápido.</p>
        </>}
      </div>}

      {tab === 'proveedores' && <div className="stack">
        <p className="muted">Proveedores que te venden este producto. El preferido se sugiere al reponer.</p>
        <table><tbody>{(suppliers.data ?? []).map((s) => {
          const on = f.supplierIds.includes(s.id)
          return <tr key={s.id}><td style={{ width: 40 }}><input type="checkbox" style={{ width: 'auto' }} checked={on} onChange={(e) => setF({ ...f, supplierIds: e.target.checked ? [...f.supplierIds, s.id] : f.supplierIds.filter((x: number) => x !== s.id), preferredSupplierId: !e.target.checked && f.preferredSupplierId === s.id ? null : f.preferredSupplierId })} /></td>
            <td>{s.name}</td><td>{on && <label className="inline"><input type="radio" style={{ width: 'auto' }} checked={f.preferredSupplierId === s.id} onChange={() => setF({ ...f, preferredSupplierId: s.id })} /> Preferido</label>}</td>
            <td className="num">{canCost && detail.data?.suppliers?.find((x: any) => x.supplier_id === s.id)?.last_cost ? 'Último costo ' + gs(detail.data.suppliers.find((x: any) => x.supplier_id === s.id).last_cost) : ''}</td></tr>
        })}{!suppliers.data?.length && <EmptyRow cols={4} text="Todavía no cargaste proveedores" />}</tbody></table>
      </div>}

      {tab === 'historial' && <div className="stack">
        {canCost && <><h3>Cambios de precio y costo</h3><table><thead><tr><th>Fecha</th><th>Dato</th><th className="num">Antes</th><th className="num">Después</th><th>Usuario</th></tr></thead>
          <tbody>{(hist.data?.prices ?? []).map((p: any) => <tr key={p.id}><td>{fmtDateTime(p.at)}</td><td>{{ cost: 'Costo', price: 'Precio', wholesale_price: 'Mayorista' }[p.field as string] ?? p.field}</td><td className="num">{gs(p.old_value)}</td><td className="num">{gs(p.new_value)}</td><td>{p.user_name}</td></tr>)}{!hist.data?.prices?.length && <EmptyRow cols={5} text="Sin cambios" />}</tbody></table></>}
        <h3>Modificaciones</h3><table><tbody>{(hist.data?.changes ?? []).map((c: any) => <tr key={c.id}><td>{fmtDateTime(c.at)}</td><td>{c.user_name}</td><td>{c.action.replace('product.', '')}</td><td>{Object.entries(c.detail?.changes ?? {}).map(([k, v]: any) => <div key={k}><b>{k}:</b> {String(v[0] ?? '—')} → {String(v[1] ?? '—')}</div>)}</td></tr>)}{!hist.data?.changes?.length && <EmptyRow cols={4} text="Sin modificaciones registradas" />}</tbody></table>
        <h3>Movimientos de stock</h3><table><thead><tr><th>Fecha</th><th>Tipo</th><th className="num">Cantidad</th><th className="num">Antes</th><th className="num">Después</th><th>Motivo</th><th>Usuario</th></tr></thead>
          <tbody>{(hist.data?.movements ?? []).map((m: any) => <tr key={m.id}><td>{fmtDateTime(m.at)}</td><td>{m.type}</td><td className="num">{m.qty > 0 ? '+' : ''}{m.qty}</td><td className="num">{m.stock_before ?? '—'}</td><td className="num">{m.stock_after ?? '—'}</td><td>{m.reason ?? (m.ref_type ? `${m.ref_type} #${m.ref_id}` : '')}</td><td>{m.user_name}</td></tr>)}{!hist.data?.movements?.length && <EmptyRow cols={7} text="Sin movimientos" />}</tbody></table>
      </div>}

      {scan && <Modal title="Escanear código" onClose={() => setScan(null)}><Scanner hint="Apuntá al código del producto" onScan={(r) => { setF((cur: any) => ({ ...cur, [scan]: r.code })); setScan(null); api('/products/lookup?code=' + encodeURIComponent(r.code)).then((p) => { if (p.id !== id) toast(`Atención: ese código ya pertenece a "${p.name}"`, true) }).catch(() => {}) }} onClose={() => setScan(null)} /></Modal>}
    </Modal>
  )
}

export default function Products() {
  const { user, toast } = useApp()
  const ask = useAsk()
  const [sp, setSp] = useSearchParams()
  const staff = ['owner', 'admin'].includes(user!.role)
  const canAdjust = staff || user!.role === 'warehouse'
  const [f, setF] = useState<any>({ q: '', category: sp.get('category') ?? '', brand: '', status: 'active', stock: sp.get('stock') ?? '', offer: '', online: '', noImage: '', supplierId: '', sort: 'name', dir: 'asc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(30)
  const q = useDebounced(f.q)
  const data = useQuery<any>('/products?' + qs({ ...f, q, page, pageSize }))
  const facets = useQuery<any>('/products/facets')
  const suppliers = useQuery<any[]>('/suppliers')
  const suggestions = useQuery<any[]>(staff ? '/price-suggestions' : null)
  const [editing, setEditing] = useState<{ id: number | null } | null>(sp.get('open') ? { id: Number(sp.get('open')) } : null)
  const [adj, setAdj] = useState<any>(null)
  const [scan, setScan] = useState(false)
  const [sel, setSel] = useState<number[]>([])
  const [importing, setImporting] = useState(false)
  const items: any[] = data.data?.items ?? []
  const showCost = items[0] ? 'cost' in items[0] : false
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setPage(1) }
  const sort = (k: string) => setF({ ...f, sort: k, dir: f.sort === k && f.dir === 'asc' ? 'desc' : 'asc' })
  const arrow = (k: string) => (f.sort === k ? (f.dir === 'asc' ? ' ▲' : ' ▼') : '')

  const reloadAll = () => { data.reload(); suggestions.reload(); facets.reload() }
  async function adjust() {
    try { await api('/stock/adjust', { body: { productId: adj.id, delta: Number(adj.delta), reason: adj.reason, initial: !!adj.initial } }); toast('Stock ajustado'); setAdj(null); reloadAll() } catch (e: any) { toast(e.message, true) }
  }
  async function remove(p: any) {
    const ok = await ask({ title: `Eliminar "${p.name}"`, confirm: 'Eliminar o desactivar', danger: true })
    if (!ok) return
    try { const r = await api('/products/' + p.id, { method: 'DELETE' }); toast(r.deleted ? 'Producto eliminado' : r.message); reloadAll() } catch (e: any) { toast(e.message, true) }
  }
  async function onFile(file: File) {
    setImporting(true)
    try { const r = await api('/products/import', { body: { rows: parseCsv(await file.text()) } }); toast(`Importación lista: ${r.created} nuevos, ${r.updated} actualizados`); reloadAll() } catch (e: any) { toast('No se pudo importar: ' + e.message, true) } finally { setImporting(false) }
  }
  const template = () => {
    const blob = new Blob(['﻿' + CSV_COLS.join(';') + '\nCUA-100;Cuaderno 100 hojas;Útiles escolares;Cuadernos;Rivadavia;7790001000099;;6000;10000;10;20;caja;12;product\n'], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'plantilla-productos.csv'; a.click()
  }
  const kpis = useMemo(() => ({ low: items.filter((p) => p.low).length, out: items.filter((p) => p.out).length, offer: items.filter((p) => p.on_offer).length }), [items])

  return (
    <>
      <div className="head"><div><h1>Productos e inventario</h1><span className="muted">{data.data ? `${data.data.total} productos` : 'Cargando…'}</span></div>
        <div className="row">
          {staff && <>
            <label className="btn" style={{ cursor: 'pointer' }}>{importing ? 'Importando…' : 'Importar CSV'}<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>
            <button onClick={template}>Plantilla</button>
            <button disabled={!sel.length} onClick={() => openAuthed(`/products/labels?ids=${sel.join(',')}&copies=1`).catch((e) => toast(e.message, true))}>Etiquetas ({sel.length})</button>
            <button className="primary" onClick={() => setEditing({ id: null })}>Nuevo producto</button></>}
        </div>
      </div>

      {!!suggestions.data?.length && <div className="card warnbox" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Sugerencias de precio por cambio de costo ({suggestions.data.length})</h3>
        <table><tbody>{suggestions.data.slice(0, 6).map((s) => <tr key={s.id}><td><b>{s.name}</b></td><td>Costo {gs(s.cost_before)} → {gs(s.cost_after)}</td><td>Precio {gs(s.price_before)} → <b>{gs(s.price_suggested)}</b></td>
          <td className="row" style={{ justifyContent: 'flex-end' }}><button className="small primary" onClick={async () => { await api(`/price-suggestions/${s.id}/apply`, { body: {} }); toast('Precio actualizado'); reloadAll() }}>Aplicar</button><button className="small" onClick={async () => { await api(`/price-suggestions/${s.id}/dismiss`, { body: {} }); reloadAll() }}>Descartar</button></td></tr>)}</tbody></table></div>}

      <div className="card">
        <div className="toolbar">
          <Field label="Buscar"><div className="row" style={{ flexWrap: 'nowrap' }}><input autoFocus value={f.q} onChange={set('q')} placeholder="Nombre, código, autor, ISBN…" /><button title="Escanear" onClick={() => setScan(true)}>📷</button></div></Field>
          <Field label="Categoría"><select value={f.category} onChange={set('category')}><option value="">Todas</option>{(facets.data?.categories ?? []).map((c: string) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Marca"><select value={f.brand} onChange={set('brand')}><option value="">Todas</option>{(facets.data?.brands ?? []).map((c: string) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Existencias"><select value={f.stock} onChange={set('stock')}><option value="">Todas</option>{Object.entries(STOCK_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Estado"><select value={f.status} onChange={set('status')}><option value="active">Activos</option><option value="inactive">Inactivos</option><option value="all">Todos</option></select></Field>
          <Field label="Oferta"><select value={f.offer} onChange={set('offer')}><option value="">Todos</option><option value="1">En oferta</option></select></Field>
          <Field label="Tienda"><select value={f.online} onChange={set('online')}><option value="">Todos</option><option value="1">Visibles</option><option value="0">Ocultos</option></select></Field>
          <Field label="Proveedor"><select value={f.supplierId} onChange={set('supplierId')}><option value="">Todos</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={!!f.noImage} onChange={(e) => { setF({ ...f, noImage: e.target.checked ? '1' : '' }); setPage(1) }} /> Sin imagen</label>
        </div>
        <div className="chips" style={{ marginBottom: 12 }}><span className="chip">En esta página: {kpis.out} agotados · {kpis.low} con stock bajo · {kpis.offer} en oferta</span></div>
        <div className="table-wrap"><table>
          <thead><tr>{staff && <th><input type="checkbox" style={{ width: 'auto' }} checked={items.length > 0 && sel.length === items.length} onChange={(e) => setSel(e.target.checked ? items.map((p) => p.id) : [])} /></th>}
            <th /><th><button className="link" onClick={() => sort('name')}>Producto{arrow('name')}</button></th><th><button className="link" onClick={() => sort('category')}>Categoría{arrow('category')}</button></th>
            {showCost && <th className="num"><button className="link" onClick={() => sort('cost')}>Costo{arrow('cost')}</button></th>}<th className="num"><button className="link" onClick={() => sort('price')}>Precio{arrow('price')}</button></th>
            {showCost && <th className="num">Margen</th>}<th className="num"><button className="link" onClick={() => sort('stock')}>Físico{arrow('stock')}</button></th><th className="num">Reservado</th><th className="num">Disponible</th><th /></tr></thead>
          <tbody>{items.map((p) => (
            <tr key={p.id} style={p.active ? undefined : { opacity: .55 }}>
              {staff && <td><input type="checkbox" style={{ width: 'auto' }} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} /></td>}
              <td>{p.image_url ? <img className="thumb" src={p.image_url.replace('s=md', 's=thumb')} alt="" loading="lazy" /> : <div className="thumb">{p.name.slice(0, 1)}</div>}</td>
              <td><button className="link" onClick={() => staff && setEditing({ id: p.id })}>{p.name}</button><div className="muted">{p.code}{p.barcode ? ' · ' + p.barcode : ''}{p.brand ? ' · ' + p.brand : ''}{!p.active ? ' · inactivo' : ''}{!p.online_visible ? ' · oculto en tienda' : ''}</div></td>
              <td>{p.category}{p.subcategory ? <div className="muted">{p.subcategory}</div> : null}</td>
              {showCost && <td className="num">{gs(p.cost)}</td>}
              <td className="num">{p.on_offer ? <><s className="muted">{gs(p.price)}</s><br /><b>{gs(p.sell_price)}</b> <span className="pill ok">{p.offer_label_now}</span></> : gs(p.price)}</td>
              {showCost && <td className="num">{p.margin == null ? '—' : <span className={'pill ' + (p.margin < 10 ? 'bad' : p.margin < 25 ? 'warn' : 'ok')}>{p.margin}%</span>}</td>}
              <td className="num">{p.kind === 'service' ? '—' : p.stock}</td><td className="num">{p.kind === 'service' ? '—' : p.reserved}</td>
              <td className="num">{p.kind === 'service' ? '—' : <Status value={p.out ? 'out' : p.low ? 'low' : 'available'} label={String(p.available)} />}</td>
              <td className="row" style={{ justifyContent: 'flex-end' }}>
                {canAdjust && p.kind === 'product' && <button className="small" onClick={() => setAdj({ id: p.id, name: p.name, delta: '', reason: '' })}>Ajustar</button>}
                {staff && <button className="small" onClick={() => setEditing({ id: p.id })}>Editar</button>}
                {staff && <button className="small danger" onClick={() => remove(p)}>✕</button>}
              </td></tr>))}
            {!items.length && <EmptyRow cols={11} text="No hay productos con esos filtros" />}</tbody></table></div>
        {data.data && <Pager page={data.data.page} pages={data.data.pages} total={data.data.total} pageSize={pageSize} onPage={setPage} onSize={(s) => { setPageSize(s); setPage(1) }} />}
      </div>

      {editing && <ProductForm id={editing.id} canCost={showCost || staff} canPrice={staff} onClose={() => { setEditing(null); if (sp.get('open')) setSp({}) }} onSaved={() => { setEditing(null); reloadAll() }} />}
      {adj && <Modal title={`Ajustar stock de ${adj.name}`} onClose={() => setAdj(null)} footer={<><button onClick={() => setAdj(null)}>Cancelar</button><button className="primary" disabled={!Number(adj.delta) || adj.reason.length < 3} onClick={adjust}>Aplicar</button></>}>
        <div className="form"><Field label="Cantidad (+ entra / − sale)"><NumInput autoFocus value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} /></Field>
          <Field label="Motivo"><input value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="Inventario físico, dañado…" /></Field></div>
        <label className="inline"><input type="checkbox" style={{ width: 'auto' }} checked={!!adj.initial} onChange={(e) => setAdj({ ...adj, initial: e.target.checked })} /> Es inventario inicial (carga de apertura)</label>
      </Modal>}
      {scan && <Modal title="Escanear producto" onClose={() => setScan(false)}><Scanner onScan={(r) => { setF({ ...f, q: r.code }); setPage(1); setScan(false) }} onClose={() => setScan(false)} /></Modal>}
    </>
  )
}
