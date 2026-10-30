import { useEffect, useState } from 'react'
import { NumInput } from '../ui'
import { Link } from 'react-router-dom'
import { api, gs, useApp } from '../api'

export default function Settings() {
  const { toast } = useApp()
  const [shop, setShop] = useState<any>(null)
  const [invoice, setInvoice] = useState<any>(null)
  const [zones, setZones] = useState<any[]>([])
  const [zone, setZone] = useState({ name: '', fee: '' })
  const [ai, setAi] = useState<any>(null)
  const [aiKey, setAiKey] = useState('')
  const [check, setCheck] = useState<string>('')
  const [invStatus, setInvStatus] = useState<any>(null)
  const [invKey, setInvKey] = useState('')
  const [invCheck, setInvCheck] = useState('')
  const loadInvStatus = () => api('/invoice/status').then(setInvStatus).catch(() => {})
  const saveInvKey = async () => { try { await api('/invoice/api-key', { method: 'PUT', body: { apiKey: invKey } }); setInvKey(''); toast('Clave de facturación guardada (cifrada)'); loadInvStatus() } catch (e: any) { toast(e.message, true) } }
  const removeInvKey = async () => { if (!confirm('¿Quitar la clave de la API de facturación?')) return; await api('/invoice/api-key', { method: 'DELETE' }).catch((e) => toast(e.message, true)); loadInvStatus() }
  const testInvoice = async () => { setInvCheck('Probando…'); try { const r = await api('/invoice/test', { method: 'POST' }); setInvCheck(r.message) } catch (e: any) { setInvCheck(''); toast(e.message, true) } }
  const setProvider = async (provider: string) => { try { await api('/settings/ai', { method: 'PUT', body: { provider } }); setCheck(''); loadAi() } catch (e: any) { toast(e.message, true) } }
  const testNiro = async () => { setCheck('Probando…'); try { const r = await api('/ai/models'); const n = (r.models ?? []).filter((m: any) => m.category === 'CHAT').length; setCheck(`Conexión correcta: ${n} modelos de chat disponibles en Niro.`) } catch (e: any) { setCheck(''); toast(e.message, true) } }
  const loadAi = () => api('/ai/status').then(setAi).catch(() => {})
  const saveKey = async () => { try { await api('/ai/key', { method: 'PUT', body: { apiKey: aiKey, provider: ai.provider } }); setAiKey(''); toast('Clave guardada (cifrada en el servidor)'); loadAi() } catch (e: any) { toast(e.message, true) } }
  const removeKey = async () => { if (!confirm('¿Quitar la clave de la API? El asistente volverá a responder solo con reglas.')) return; await api('/ai/key?provider=' + ai.provider, { method: 'DELETE' }).catch((e) => toast(e.message, true)); loadAi() }

  const loadZones = () => api('/delivery-zones').then(setZones).catch(() => {})
  useEffect(() => {
    api('/settings/shop').then(setShop).catch((e) => toast(e.message, true))
    api('/settings/invoice').then(setInvoice).catch(() => {})
    loadZones(); loadAi(); loadInvStatus()
  }, [])
  const save = async (key: string, v: any) => { try { await api('/settings/' + key, { method: 'PUT', body: v }); toast('Guardado') } catch (e: any) { toast(e.message, true) } }
  if (!shop || !invoice) return <p className="muted">Cargando…</p>
  const s = (k: string) => (e: any) => setShop({ ...shop, [k]: e.target.value })
  const i = (k: string) => (e: any) => setInvoice({ ...invoice, [k]: e.target.value })

  return (
    <>
      <div className="head"><h1>Configuración</h1></div>
      <div className="grid cols-2">
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <h2>Datos del local y la tienda</h2>
          <label>Nombre<input value={shop.name ?? ''} onChange={s('name')} /></label>
          <label>Dirección<input value={shop.address ?? ''} onChange={s('address')} /></label>
          <label>Horarios<input value={shop.hours ?? ''} onChange={s('hours')} /></label>
          <label>WhatsApp del negocio<input value={shop.whatsapp ?? ''} onChange={s('whatsapp')} /></label>
          <label>WhatsApp del encargado (alertas)<input value={shop.managerPhone ?? ''} onChange={s('managerPhone')} /></label>
          <label>Minutos de reserva de stock en pedidos<NumInput value={shop.reserveMinutes ?? 30} onChange={(e) => setShop({ ...shop, reserveMinutes: Number(e.target.value) })} /></label>
          <button className="primary" onClick={() => save('shop', shop)}>Guardar</button>
        </div>
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <h2>Facturación electrónica</h2>
          <label>Modo<select value={invoice.mode ?? 'mock'} onChange={i('mode')}>
            <option value="mock">Simulado (pruebas internas)</option>
            <option value="oietema">OñeTema (electrónica real)</option>
          </select></label>
          <div className="grid cols-2" style={{ gap: 10 }}>
            <label>Establecimiento<input value={invoice.establishment ?? ''} onChange={i('establishment')} placeholder="001" /></label>
            <label>Punto de expedición<input value={invoice.point ?? ''} onChange={i('point')} placeholder="001" /></label>
          </div>
          {invoice.mode === 'oietema' && <>
            <label>Tenant (OñeTema)<input value={invoice.tenant ?? ''} onChange={i('tenant')} placeholder="paolaramona" /></label>
            <label>Formato del comprobante<select value={invoice.format ?? 'A4'} onChange={i('format')}><option value="A4">Hoja A4</option><option value="TICKET">Ticket 80mm</option></select></label>
          </>}
          <label>Timbrado (referencia)<input value={invoice.stamp ?? ''} onChange={i('stamp')} /></label>
          <label className="row" style={{ flexDirection: 'row' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!invoice.enabled} onChange={(e) => setInvoice({ ...invoice, enabled: e.target.checked })} /> Emitir factura en cada venta</label>
          <button className="primary" onClick={() => save('invoice', invoice)}>Guardar</button>
          {invoice.mode === 'oietema' && invStatus && <>
            <hr style={{ width: '100%', border: 0, borderTop: '1px solid var(--border)' }} />
            <p style={{ margin: 0 }}>Clave de la API: {invStatus.apiKeyPresent ? <span className="pill ok">Cargada · termina en {invStatus.last4}</span> : <span className="pill bad">Sin clave</span>}</p>
            <label>{invStatus.apiKeyPresent ? 'Reemplazar la clave' : 'Pegá la clave de la API de OñeTema'}<input type="password" value={invKey} onChange={(e) => setInvKey(e.target.value)} autoComplete="off" placeholder="API key" /></label>
            <div className="row"><button className="primary" onClick={saveInvKey} disabled={invKey.trim().length < 8}>Guardar clave</button>
              {invStatus.apiKeyPresent && <button className="danger" onClick={removeInvKey}>Quitar</button>}
              <button onClick={testInvoice}>Probar conexión</button></div>
            {invCheck && <p className="callout" style={{ margin: 0 }}>{invCheck}</p>}
            <p className="muted" style={{ margin: 0 }}>La clave se guarda cifrada. En modo <b>OñeTema</b> cada venta emite la factura electrónica real contra SET.</p>
          </>}
        </div>
        <div className="card" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <h2>Asistente con IA — conexión</h2>
          {ai && <>
            <label>Proveedor de IA<select value={ai.provider} onChange={(e) => setProvider(e.target.value)}><option value="niro">Niro IA (niro.cnid.com.py)</option><option value="anthropic">Claude (Anthropic)</option></select></label>
            <p style={{ margin: 0 }}>Clave de la API: {ai.keyPresent
              ? <span className="pill ok">Cargada ({ai.source === 'database' ? 'desde acá' : 'variable de entorno'}) · termina en {ai.last4}</span>
              : <span className="pill bad">Sin clave</span>}</p>
            <label>{ai.keyPresent ? 'Reemplazar la clave' : 'Pegá la clave de la API'}
              <input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} autoComplete="off" placeholder={ai.provider === 'niro' ? 'niro_…' : 'sk-ant-…'} /></label>
            <div className="row"><button className="primary" onClick={saveKey} disabled={aiKey.trim().length < 20}>Guardar clave</button>
              {ai.source === 'database' && <button className="danger" onClick={removeKey}>Quitar clave</button>}
              {ai.provider === 'niro' && ai.keyPresent && <button onClick={testNiro}>Probar conexión</button>}</div>
            {check && <p className="callout" style={{ margin: 0 }}>{check}</p>}
            <p className="muted" style={{ margin: 0 }}>La clave se guarda cifrada en el servidor y no se vuelve a mostrar. Después activá la IA y cargá lo que debe saber en <Link to="/prompts">Asistente con IA</Link>.</p>
          </>}
        </div>
        <div className="card">
          <h2>Delivery</h2>
          <p className="muted" style={{ margin: 0 }}>La tarifa general (Gs. 30.000 por defecto), el precio de cada departamento y ciudad, el delivery gratis y los plazos se configuran en el módulo <Link to="/delivery">Delivery</Link>.</p>
        </div>
      </div>
    </>
  )
}
