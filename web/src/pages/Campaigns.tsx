import { useState } from 'react'
import { api, gs, useApp } from '../api'
import { Field, fileToBase64, fmtDateTime, Modal, useAsk, useQuery } from '../ui'
import { Icon } from '../components/Icons'
import { ProductPicker } from '../components/ProductPicker'

interface Campaign {
  id: number; name: string; title: string; body: string; image_url: string | null; link: string | null
  product_id: number | null; product: { id: number; name: string; price: number | null; list_price: number | null } | null
  send_push: boolean; show_popup: boolean; starts_at: string | null; ends_at: string | null; priority: number
  status: string; sent_at: string | null; sent_count: number; fail_count: number
}

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Borrador', cls: 'warn' }, scheduled: { label: 'Programada', cls: 'warn' },
  active: { label: 'Activa', cls: 'ok' }, sent: { label: 'Enviada', cls: 'ok' }, archived: { label: 'Archivada', cls: 'bad' },
}

// <input type="datetime-local"> trabaja en hora local; el servidor guarda en UTC.
const toLocal = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null)

const blank = (): Partial<Campaign> => ({ name: '', title: '', body: '', image_url: null, link: null, product_id: null, product: null, send_push: true, show_popup: true, starts_at: null, ends_at: null, priority: 0, status: 'draft' })

function CampaignForm({ initial, onClose, onSaved }: { initial: Partial<Campaign>; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const ask = useAsk()
  const [f, setF] = useState<Partial<Campaign>>(initial)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof Campaign, v: any) => setF((s) => ({ ...s, [k]: v }))
  const editing = !!f.id

  async function pickImage(file?: File) {
    if (!file) return
    try { set('image_url', await fileToBase64(file, 1200)) } catch { toast('No se pudo leer la imagen', true) }
  }

  async function save(): Promise<number | null> {
    if (!f.name?.trim() || !f.title?.trim()) { toast('Poné al menos un nombre y un título', true); return null }
    const payload = {
      name: f.name, title: f.title, body: f.body ?? '', imageUrl: f.image_url ?? null, link: f.link || null,
      productId: f.product_id ?? null, sendPush: !!f.send_push, showPopup: !!f.show_popup,
      startsAt: f.starts_at ?? null, endsAt: f.ends_at ?? null, priority: Number(f.priority) || 0, status: f.status ?? 'draft',
    }
    const r: Campaign = editing ? await api(`/campaigns/${f.id}`, { method: 'PUT', body: payload }) : await api('/campaigns', { body: payload })
    setF(r); return r.id
  }

  async function onSave() { setBusy(true); try { if (await save()) { toast('Campaña guardada'); onSaved() } } catch (e: any) { toast(e.message, true) } finally { setBusy(false) } }

  async function onSend() {
    const ok = await ask({ title: 'Enviar la notificación a todos los clientes suscritos', confirm: 'Enviar ahora' })
    if (!ok) return
    setBusy(true)
    try { const id = await save(); if (!id) return; const r = await api(`/campaigns/${id}/send`, { body: {} }); toast(`Enviada a ${r.sent} de ${r.audience} dispositivos${r.failed ? ` (${r.failed} fallaron)` : ''}`); onSaved() }
    catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }

  async function onTest() {
    setBusy(true)
    try { const id = await save(); if (!id) return; const r = await api(`/campaigns/${id}/test`, { body: {} }); toast(`Prueba enviada a ${r.sent} de tus ${r.devices} dispositivos`) }
    catch (e: any) { toast(e.message, true) } finally { setBusy(false) }
  }

  return (
    <Modal title={editing ? 'Editar campaña' : 'Nueva campaña'} onClose={onClose} wide="xl" footer={<>
      <button onClick={onClose}>Cancelar</button>
      <button onClick={onTest} disabled={busy}>Probar en mi celular</button>
      <button className="primary" onClick={onSave} disabled={busy}>Guardar</button>
      <button className="primary" onClick={onSend} disabled={busy}>Guardar y enviar</button>
    </>}>
      <div className="form">
        <Field label="Nombre de la campaña" span={2} hint="Interno, para encontrarla (ej.: Día de la Madre)"><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="Día de la Madre" /></Field>
        <Field label="Título" span={2} hint="Lo que se ve grande en la notificación y el pop-up"><input value={f.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="¡20% en regalos para mamá!" /></Field>
        <Field label="Descripción" span={2}><textarea rows={2} value={f.body ?? ''} onChange={(e) => set('body', e.target.value)} placeholder="Solo esta semana. Envíos a todo el país." /></Field>

        <Field label="Imagen" span={2} hint="Se ve en la notificación y en el pop-up (horizontal, hasta 11 MB)">
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            {f.image_url && <img src={f.image_url} alt="" style={{ width: 92, height: 60, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />}
            <input type="file" accept="image/*" onChange={(e) => pickImage(e.target.files?.[0])} />
            {f.image_url && <button type="button" onClick={() => set('image_url', null)}>Quitar</button>}
          </div>
        </Field>

        <Field label="Producto en oferta (opcional)" span={2} hint="Si elegís uno, el pop-up muestra su precio y lleva a su página">
          {f.product ? (
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px' }}>
              <span><b>{f.product.name}</b>{f.product.price != null && <> · {gs(f.product.price)}</>}</span>
              <button type="button" onClick={() => { set('product', null); set('product_id', null) }}>Quitar</button>
            </div>
          ) : <ProductPicker onPick={(p) => { set('product_id', p.id); set('product', { id: p.id, name: p.name, price: Number(p.sell_price ?? p.price), list_price: Number(p.price) }) }} placeholder="Buscar el producto en oferta…" />}
        </Field>

        <Field label="Enlace del clic (opcional)" span={2} hint="A dónde lleva al tocar. Vacío = la tienda o el producto elegido"><input value={f.link ?? ''} onChange={(e) => set('link', e.target.value)} placeholder="/tienda?oferta=1" /></Field>

        <Field label="Mostrar desde"><input type="datetime-local" value={toLocal(f.starts_at ?? null)} onChange={(e) => set('starts_at', fromLocal(e.target.value))} /></Field>
        <Field label="Mostrar hasta"><input type="datetime-local" value={toLocal(f.ends_at ?? null)} onChange={(e) => set('ends_at', fromLocal(e.target.value))} /></Field>

        <Field label="Prioridad" hint="Mayor = aparece primero en el pop-up"><input type="number" min={0} value={f.priority ?? 0} onChange={(e) => set('priority', e.target.value)} /></Field>
        <Field label="Estado">
          <select value={f.status ?? 'draft'} onChange={(e) => set('status', e.target.value)}>
            <option value="draft">Borrador</option><option value="active">Activa</option><option value="scheduled">Programada</option><option value="archived">Archivada</option>
          </select>
        </Field>

        <label className="inline" style={{ gridColumn: 'span 2' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f.send_push} onChange={(e) => set('send_push', e.target.checked)} /> Enviar notificación push al disparar la campaña</label>
        <label className="inline" style={{ gridColumn: 'span 2' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f.show_popup} onChange={(e) => set('show_popup', e.target.checked)} /> Mostrar como pop-up al abrir la tienda (mientras esté vigente)</label>
      </div>
    </Modal>
  )
}

export default function Campaigns() {
  const { toast } = useApp()
  const ask = useAsk()
  const q = useQuery<{ audience: number; items: Campaign[] }>('/campaigns')
  const [edit, setEdit] = useState<Partial<Campaign> | null>(null)
  const items = q.data?.items ?? []

  async function remove(c: Campaign) {
    if (!(await ask({ title: `Borrar "${c.name}"`, confirm: 'Borrar', danger: true }))) return
    try { await api(`/campaigns/${c.id}`, { method: 'DELETE' }); toast('Campaña borrada'); q.reload() } catch (e: any) { toast(e.message, true) }
  }

  return (
    <>
      <div className="head"><div><h1>Campañas push</h1><span className="muted">Notificaciones de ofertas y pop-ups para los clientes de la tienda</span></div>
        <button className="primary" onClick={() => setEdit(blank())}><Icon name="plus" size={18} /> Nueva campaña</button></div>

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="card kpi"><div className="label">Clientes suscritos</div><div className="value">{q.data?.audience ?? '—'}</div><div className="sub">reciben las notificaciones</div></div>
        <div className="card kpi"><div className="label">Campañas</div><div className="value">{items.length}</div><div className="sub">{items.filter((c) => c.status === 'active' || c.status === 'sent').length} activas o enviadas</div></div>
        <div className="card kpi"><div className="label">Último envío</div><div className="value" style={{ fontSize: 20 }}>{items.find((c) => c.sent_at) ? fmtDateTime(items.find((c) => c.sent_at)!.sent_at) : '—'}</div><div className="sub">{items.find((c) => c.sent_at)?.sent_count ?? 0} dispositivos</div></div>
      </div>

      <div className="card">
        <div className="table-wrap"><table><thead><tr><th>Campaña</th><th>Tipo</th><th>Vigencia</th><th className="num">Enviados</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {items.map((c) => <tr key={c.id} className="clickable" onClick={() => setEdit(c)}>
              <td><b>{c.title}</b><div className="muted">{c.name}{c.product ? ` · ${c.product.name}` : ''}</div></td>
              <td>{c.send_push && <span className="pill" title="Notificación push"><Icon name="bell" size={13} /> Push</span>} {c.show_popup && <span className="pill" title="Pop-up en la tienda">🪟 Pop-up</span>}</td>
              <td className="muted">{c.starts_at || c.ends_at ? `${c.starts_at ? fmtDateTime(c.starts_at) : '—'} → ${c.ends_at ? fmtDateTime(c.ends_at) : '—'}` : 'Siempre'}</td>
              <td className="num">{c.sent_at ? `${c.sent_count}${c.fail_count ? ` / ${c.fail_count}✗` : ''}` : '—'}</td>
              <td><span className={'pill ' + (STATUS[c.status]?.cls ?? '')}>{STATUS[c.status]?.label ?? c.status}</span></td>
              <td onClick={(e) => e.stopPropagation()}><button className="small danger" onClick={() => remove(c)}>Borrar</button></td>
            </tr>)}
            {!items.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 28 }}>Todavía no hay campañas. Creá la primera para avisar de una oferta.</td></tr>}
          </tbody></table></div>
      </div>

      {edit && <CampaignForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload() }} />}
    </>
  )
}
