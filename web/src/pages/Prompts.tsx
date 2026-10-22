import { useEffect, useState } from 'react'
import { NumInput } from '../ui'
import { Link } from 'react-router-dom'
import { api, useApp } from '../api'

const KIND: Record<string, string> = { system: 'Identidad', rules: 'Reglas', knowledge: 'Conocimiento' }
const EMPTY = { slug: '', title: '', kind: 'knowledge', content: '', active: true, sort: 100 }

export default function Prompts() {
  const { toast } = useApp()
  const [rows, setRows] = useState<any[]>([])
  const [form, setForm] = useState<any>(null)
  const [status, setStatus] = useState<any>(null)
  const [preview, setPreview] = useState<any>(null)
  const [test, setTest] = useState({ message: '', busy: false, out: null as any })

  const load = () => api('/prompts').then(setRows).catch((e) => toast(e.message, true))
  const loadStatus = () => api('/ai/status').then(setStatus).catch(() => {})
  useEffect(() => { load(); loadStatus() }, [])

  async function save() {
    try {
      if (form.id) await api('/prompts/' + form.id, { method: 'PUT', body: { title: form.title, kind: form.kind, content: form.content, active: form.active, sort: Number(form.sort) } })
      else await api('/prompts', { body: { ...form, sort: Number(form.sort) } })
      toast('Prompt guardado'); setForm(null); load()
    } catch (e: any) { toast(e.message, true) }
  }
  async function toggle(p: any) { await api('/prompts/' + p.id, { method: 'PUT', body: { active: !p.active } }).catch((e) => toast(e.message, true)); load() }
  async function remove(p: any) {
    if (!confirm(`¿Eliminar "${p.title}"?`)) return
    await api('/prompts/' + p.id, { method: 'DELETE' }).catch((e) => toast(e.message, true)); load()
  }
  async function saveAi(patch: any) {
    try { await api('/settings/ai', { method: 'PUT', body: patch }); toast('Configuración de IA guardada'); loadStatus() } catch (e: any) { toast(e.message, true) }
  }
  async function runTest() {
    setTest({ ...test, busy: true })
    try { setTest({ message: test.message, busy: false, out: await api('/prompts/test', { body: { message: test.message } }) }) }
    catch (e: any) { toast(e.message, true); setTest({ ...test, busy: false }) }
  }
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value })
  const cfg = status?.settings

  return (
    <>
      <div className="head"><div><h1>Asistente con IA</h1><span className="muted">Lo que cargues acá es lo que el asistente sabe y cómo se comporta en la tienda y en WhatsApp.</span></div>
        <button className="primary" onClick={() => setForm({ ...EMPTY })}>Nuevo prompt</button></div>

      <div className="grid cols-2">
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <h2>Conexión con la IA</h2>
          {status && <>
            <p>Clave de la API: {status.keyPresent ? <span className="pill ok">Cargada · termina en {status.last4}</span> : <span className="pill bad">Sin clave</span>}</p>
            {!status.keyPresent && <p className="muted">Cargá la clave en <Link to="/settings">Configuración</Link>. Se guarda cifrada y no se vuelve a mostrar.</p>}
            <label className="row" style={{ flexDirection: 'row' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!cfg.enabled} onChange={(e) => saveAi({ enabled: e.target.checked })} /> Responder con IA (si se apaga, el chat usa solo reglas)</label>
            {cfg.provider === 'niro' && <p className="muted" style={{ margin: 0 }}>Proveedor: Niro IA. El modelo lo elige Niro automáticamente (con respaldo si uno falla) y se descuenta de los créditos de tu wallet de Niro.</p>}
            {cfg.provider !== 'niro' && <div className="form">
              <label>Modelo<input defaultValue={cfg.model} onBlur={(e) => e.target.value !== cfg.model && saveAi({ model: e.target.value })} /></label>
              <label>Esfuerzo de razonamiento<select value={cfg.effort} onChange={(e) => saveAi({ effort: e.target.value })}><option value="low">Bajo (rápido y barato)</option><option value="medium">Medio</option><option value="high">Alto</option></select></label>
              <label>Máx. de tokens por respuesta<input type="number" defaultValue={cfg.maxTokens} onBlur={(e) => Number(e.target.value) !== cfg.maxTokens && saveAi({ maxTokens: Number(e.target.value) })} /></label>
            </div>}
          </>}
        </div>
        <div className="card" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <h2>Probar el asistente</h2>
          <div className="row"><input placeholder="Escribí como un cliente: ¿cuánto sale el delivery?" value={test.message} onChange={(e) => setTest({ ...test, message: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && test.message && runTest()} />
            <button className="primary" disabled={!test.message || test.busy} onClick={runTest}>{test.busy ? 'Pensando…' : 'Probar'}</button></div>
          {test.out && <div className="callout">
            <span className={'pill ' + (test.out.source === 'ai' ? 'ok' : 'warn')}>{test.out.source === 'ai' ? `Respondió la IA · ${test.out.model}` : 'Respondieron las reglas'}</span>
            {test.out.why && <div className="muted" style={{ marginTop: 4 }}>{test.out.why}</div>}
            <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{test.out.reply}</p>
            {test.out.usage && <div className="muted">Tokens: {test.out.usage.input} de entrada, {test.out.usage.output} de salida</div>}
          </div>}
        </div>
      </div>

      {form && (
        <div className="card" style={{ marginTop: 16, display: 'grid', gap: 12 }}>
          <h2>{form.id ? 'Editar prompt' : 'Nuevo prompt'}</h2>
          <div className="form">
            <label>Título<input value={form.title} onChange={set('title')} /></label>
            <label>Identificador<input value={form.slug} onChange={set('slug')} disabled={!!form.id} placeholder="envios, promociones…" /></label>
            <label>Tipo<select value={form.kind} onChange={set('kind')}><option value="system">Identidad y tono</option><option value="rules">Reglas</option><option value="knowledge">Conocimiento del negocio</option></select></label>
            <label>Orden<NumInput value={form.sort} onChange={set('sort')} /></label>
          </div>
          <label>Contenido<textarea rows={9} value={form.content} onChange={set('content')} style={{ resize: 'vertical' }} placeholder="Escribí en lenguaje natural. Ej.: El delivery llega en 24 horas hábiles…" /></label>
          <label className="row" style={{ flexDirection: 'row' }}><input type="checkbox" style={{ width: 'auto' }} checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activo</label>
          <div className="row"><button className="primary" onClick={save}>Guardar</button><button onClick={() => setForm(null)}>Cancelar</button></div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Prompts cargados</h2>
          <button onClick={async () => setPreview(preview ? null : await api('/prompts/preview'))}>{preview ? 'Ocultar texto final' : 'Ver el texto final que recibe la IA'}</button>
        </div>
        {preview && <><p className="muted">{preview.characters.toLocaleString('es-PY')} caracteres · ≈ {preview.approxTokens.toLocaleString('es-PY')} tokens. Incluye los datos vivos (zonas, tarifas, horarios) y las reglas fijas del sistema.</p>
          <pre className="prompt-preview">{preview.system}</pre></>}
        <table style={{ marginTop: 10 }}><thead><tr><th>Título</th><th>Tipo</th><th>Contenido</th><th>Estado</th><th /></tr></thead><tbody>
          {rows.map((p) => (
            <tr key={p.id}><td><b>{p.title}</b><div className="muted mono">{p.slug}</div></td><td><span className="pill">{KIND[p.kind]}</span></td>
              <td className="clip">{p.content.slice(0, 140)}{p.content.length > 140 && '…'}</td>
              <td><span className={'pill ' + (p.active ? 'ok' : '')}>{p.active ? 'Activo' : 'Pausado'}</span></td>
              <td className="row" style={{ justifyContent: 'flex-end' }}><button onClick={() => setForm({ ...p })}>Editar</button><button onClick={() => toggle(p)}>{p.active ? 'Pausar' : 'Activar'}</button><button className="danger" onClick={() => remove(p)}>Eliminar</button></td></tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="muted">Todavía no hay prompts. Creá uno para enseñarle algo al asistente.</td></tr>}
        </tbody></table>
      </div>
    </>
  )
}
