import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, gs, paymentMethodLabel, useApp } from '../api'
import { Field, fmtDate, qs } from '../ui'

const RANGES: [string, string][] = [['today', 'Hoy'], ['yesterday', 'Ayer'], ['week', 'Esta semana'], ['month', 'Este mes'], ['last30', 'Últimos 30 días'], ['year', 'Este año'], ['custom', 'Personalizado']]
const money = (n: number) => gs(n)

function Bars({ rows, value = (r: any) => r.value, name = (r: any) => r.name, fmt = money }: { rows: any[]; value?: (r: any) => number; name?: (r: any) => string; fmt?: (n: number) => string }) {
  const max = Math.max(...rows.map(value), 1)
  if (!rows.length) return <p className="muted">Sin datos en el período.</p>
  return <>{rows.map((r, i) => <div className="hbar" key={i}><span>{name(r)}</span><b className="num">{fmt(value(r))}</b><div className="track"><div className="fill" style={{ width: `${(Math.max(value(r), 0) / max) * 100}%` }} /></div></div>)}</>
}

function Series({ rows, a, b, labelA, labelB }: { rows: any[]; a: (r: any) => number; b?: (r: any) => number; labelA: string; labelB?: string }) {
  const max = Math.max(...rows.flatMap((r) => [a(r), b ? b(r) : 0]), 1)
  return (
    <>
      <div className="bars" role="img" aria-label={labelA} style={{ gap: b ? 3 : undefined }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-end', gap: 2, flex: 1, height: '100%' }}>
            <div className="bar" style={{ height: `${(a(r) / max) * 100}%`, flex: 1 }}><span>{fmtDate(r.day)} · {labelA}: {gs(a(r))}</span></div>
            {b && <div className="bar" style={{ height: `${(b(r) / max) * 100}%`, flex: 1, background: 'var(--margin)' }}><span>{fmtDate(r.day)} · {labelB}: {gs(b(r))}</span></div>}
          </div>
        ))}
      </div>
      <p className="muted" style={{ margin: '8px 0 0' }}>{labelA}{labelB ? ` (azul) y ${labelB} (naranja)` : ''} · máximo {gs(max)}</p>
    </>
  )
}

export default function Dashboard() {
  const { user, toast } = useApp()
  const nav = useNavigate()
  const [range, setRange] = useState('month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [d, setD] = useState<any>(null)
  const params = useMemo(() => (range === 'custom' ? { from, to } : { range }), [range, from, to])
  useEffect(() => {
    if (range === 'custom' && (!from || !to)) return
    const load = () => api('/reports/overview?' + qs(params)).then(setD).catch((e) => toast(e.message, true))
    load(); const t = setInterval(load, 60000); return () => clearInterval(t)
  }, [JSON.stringify(params)])
  if (!d) return <p className="muted">Cargando el panel…</p>

  const kpi = (key: string) => d.kpis.find((k: any) => k.key === key)
  const drill = (k: any) => nav(`/reports/${k.drill.path.replace('/reports/', '')}?${qs({ ...k.drill.params, ...(range !== 'custom' ? { range } : {}) })}`.replace(/(&|\?)from=[^&]*/g, '$1').replace(/(&|\?)to=[^&]*/g, '$1'))
  const Delta = ({ k }: { k: any }) => k.delta == null || k.previous === 0 ? <span className="muted">sin período anterior</span> : (() => {
    const good = (k.delta >= 0) === (k.good === 'up')
    return <span style={{ color: good ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>{k.delta >= 0 ? '▲' : '▼'} {Math.abs(k.delta)}%<span className="muted" style={{ fontWeight: 400 }}> vs. anterior</span></span>
  })()
  const Card = ({ k, hero }: { k: any; hero?: boolean }) => (
    <button className={'card kpi' + (hero ? ' hero' : '')} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => drill(k)} title="Ver el detalle">
      <div className="label">{k.label}</div>
      <div className="value">{k.kind === 'int' ? Number(k.value).toLocaleString('es-PY') : gs(k.value)}</div>
      <div className="sub">{k.hint && <span>{k.hint} · </span>}{k.previous !== 0 || k.delta != null ? <Delta k={k} /> : null}</div>
    </button>
  )
  const main = ['net', 'pos', 'web', 'gross_profit', 'result', 'collected']
  const money2 = ['sales', 'ticket', 'discount', 'returns', 'expense', 'income', 'expenses', 'purchases', 'payables', 'receivable', 'overdue', 'credit_sales', 'installments']
  const stock = d.stock
  const o = d.online

  return (
    <>
      <div className="head"><div><h1>Hola, {user!.name.split(' ')[0]}</h1><span className="muted">Del {fmtDate(d.period.from)} al {fmtDate(d.period.to)} · comparado con {fmtDate(d.previous.from)} – {fmtDate(d.previous.to)}</span></div>
        <div className="row">
          <Field label="Período"><select value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {range === 'custom' && <><Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>}
        </div>
      </div>

      <div className="kpis">{main.map((k, i) => kpi(k) && <Card key={k} k={kpi(k)} hero={i === 0} />)}</div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Cuentas y cajas</h2>
        <div className="grid cols-4">{d.accounts.map((a: any) => <Link key={a.id} to="/finanzas?tab=cuentas" className="card kpi" style={{ textDecoration: 'none', color: 'inherit' }}><div className="label">{a.kind === 'cash' ? 'Caja' : 'Banco'} · {a.name}</div><div className="value">{gs(a.balance)}</div></Link>)}</div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Para hacer ahora</h2>
        <div className="todo">
          <Link to="/orders?tab=proofs" className={o.in_review ? 'hot' : ''}><b>{o.in_review}</b><span className="muted">Comprobantes por revisar</span></Link>
          <Link to="/orders?todo=1" className={o.to_prepare ? 'hot' : ''}><b>{o.to_prepare}</b><span className="muted">Pedidos por preparar</span></Link>
          <Link to="/orders?todo=1"><b>{o.to_deliver}</b><span className="muted">Por entregar</span></Link>
          <Link to="/products?stock=low" className={stock.low_stock + stock.out_of_stock ? 'hot' : ''}><b>{stock.low_stock + stock.out_of_stock}</b><span className="muted">Productos con stock bajo o agotado</span></Link>
          <Link to="/purchases"><b>{d.purchaseOrders.orders}</b><span className="muted">Órdenes de compra por recibir</span></Link>
          <Link to="/reports/payables"><b>{gs(kpi('payables').value)}</b><span className="muted">Deuda con proveedores</span></Link>
          <Link to="/reports/receivables?view=detail"><b>{kpi('overdue').hint}</b><span className="muted">Cuotas de clientes vencidas</span></Link>
        </div>
      </div>

      <h2 style={{ marginTop: 24 }}>Más indicadores</h2>
      <div className="kpis">{money2.map((k) => kpi(k) && <Card key={k} k={kpi(k)} />)}</div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card chart-card"><h2>Ventas netas por día</h2><Series rows={d.series.daily} a={(r) => r.net} labelA="Ventas netas" /></div>
        <div className="card chart-card"><h2>Ingresos y egresos de dinero</h2><Series rows={d.series.flow} a={(r) => r.income} b={(r) => r.expense} labelA="Ingresos" labelB="Egresos" /></div>
        <div className="card"><h2>Productos más vendidos</h2><Bars rows={d.series.topProducts} name={(r) => r.grp} value={(r) => Number(r.net)} /></div>
        <div className="card"><h2>Ventas por canal</h2><Bars rows={d.series.channels} name={(r) => r.grp} value={(r) => Number(r.net)} /></div>
        <div className="card"><h2>Cobros por medio de pago</h2><Bars rows={d.series.paymentsByMethod} name={(r) => paymentMethodLabel(r.grp) || r.grp} value={(r) => Number(r.collected)} /></div>
        <div className="card"><h2>Gastos por categoría</h2><Bars rows={d.series.expensesByCategory} name={(r) => r.grp} value={(r) => Number(r.amount)} /></div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Alertas de inventario</h2>
        <p className="muted">{stock.out_of_stock} agotados · {stock.low_stock} con stock bajo · inventario al costo {gs(stock.inventory_cost)} · a precio de venta {gs(stock.inventory_potential)}</p>
        <table><thead><tr><th>Producto</th><th className="num">Disponible</th><th className="num">Mínimo</th></tr></thead>
          <tbody>{stock.alerts.map((a: any) => <tr key={a.id}><td><Link to={`/products?open=${a.id}`}>{a.name}</Link></td><td className="num"><span className={'pill ' + (a.available <= 0 ? 'bad' : 'warn')}>{a.available}</span></td><td className="num">{a.min_stock}</td></tr>)}
            {!stock.alerts.length && <tr><td colSpan={3} className="muted">Todo en orden</td></tr>}</tbody></table>
      </div>
    </>
  )
}
