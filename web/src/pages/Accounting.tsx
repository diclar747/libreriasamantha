import { useEffect, useState } from 'react'
import { NumInput } from '../ui'
import { api, gs, useApp } from '../api'

type Tab = 'journal' | 'ledger' | 'trial' | 'income' | 'balance' | 'entry'
const TABS: [Tab, string][] = [['journal', 'Libro diario'], ['ledger', 'Mayor'], ['trial', 'Balance de sumas y saldos'], ['income', 'Estado de resultados'], ['balance', 'Balance general'], ['entry', 'Asiento manual']]

const csv = (rows: (string | number)[][], name: string) => {
  const blob = new Blob(['﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click()
}

export default function Accounting() {
  const { toast } = useApp()
  const [tab, setTab] = useState<Tab>('trial')
  const [range, setRange] = useState({ from: '', to: '' })
  const [data, setData] = useState<any>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [code, setCode] = useState('1.1.01')
  const [entry, setEntry] = useState({ description: '', lines: [{ code: '1.1.01', debit: '', credit: '' }, { code: '3.1.01', debit: '', credit: '' }] })

  const qs = `?from=${range.from}&to=${range.to}`
  useEffect(() => { api('/accounting/accounts').then(setAccounts).catch(() => {}) }, [])
  useEffect(() => {
    setData(null)
    const url = { journal: '/accounting/journal' + qs, ledger: `/accounting/ledger/${code}` + qs, trial: '/accounting/trial-balance' + qs, income: '/accounting/income-statement' + qs, balance: `/accounting/balance-sheet?to=${range.to}`, entry: '' }[tab]
    if (url) api(url).then(setData).catch((e) => toast(e.message, true))
  }, [tab, range.from, range.to, code])

  async function saveEntry() {
    try {
      await api('/accounting/entries', { body: { description: entry.description, lines: entry.lines.map((l) => ({ code: l.code, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })) } })
      toast('Asiento registrado'); setEntry({ ...entry, description: '' })
    } catch (e: any) { toast(e.message, true) }
  }
  const Section = ({ title, rows, total }: { title: string; rows: any[]; total: number }) => (
    <>
      <tr><th colSpan={2}>{title}</th></tr>
      {rows.map((r) => <tr key={r.code}><td>{r.code} · {r.name}</td><td className="num">{gs(r.balance)}</td></tr>)}
      <tr><td><b>Total {title.toLowerCase()}</b></td><td className="num"><b>{gs(total)}</b></td></tr>
    </>
  )

  return (
    <>
      <div className="head"><div><h1>Contabilidad</h1><span className="muted">Asientos automáticos desde ventas, compras, cobros y pagos. Plan de cuentas base a validar con el contador.</span></div>
        <div className="row">
          <input type="date" style={{ width: 150 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input type="date" style={{ width: 150 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div></div>
      <div className="row" style={{ marginBottom: 14 }}>{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'primary' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'journal' && data && (
        <div className="card">{data.map((e: any) => (
          <div key={e.id} style={{ marginBottom: 14 }}>
            <b>#{e.id} · {String(e.date).slice(0, 10)} · {e.description}</b>
            <table><tbody>{e.lines.map((l: any, i: number) => <tr key={i}><td style={{ paddingLeft: l.credit > 0 ? 36 : 10 }}>{l.code} {l.name}</td><td className="num">{l.debit > 0 ? gs(l.debit) : ''}</td><td className="num">{l.credit > 0 ? gs(l.credit) : ''}</td></tr>)}</tbody></table>
          </div>))}{!data.length && <p className="muted">Sin asientos</p>}</div>
      )}
      {tab === 'ledger' && (
        <div className="card">
          <select style={{ maxWidth: 360, marginBottom: 12 }} value={code} onChange={(e) => setCode(e.target.value)}>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select>
          {data && <table><thead><tr><th>Fecha</th><th>Detalle</th><th className="num">Debe</th><th className="num">Haber</th><th className="num">Saldo</th></tr></thead><tbody>
            {data.lines.map((l: any, i: number) => <tr key={i}><td>{String(l.date).slice(0, 10)}</td><td>{l.description}</td><td className="num">{l.debit ? gs(l.debit) : ''}</td><td className="num">{l.credit ? gs(l.credit) : ''}</td><td className="num">{gs(l.balance)}</td></tr>)}
          </tbody></table>}
        </div>
      )}
      {tab === 'trial' && data && (
        <div className="card">
          <table><thead><tr><th>Cuenta</th><th className="num">Debe</th><th className="num">Haber</th><th className="num">Saldo</th></tr></thead><tbody>
            {data.rows.map((r: any) => <tr key={r.code}><td>{r.code} · {r.name}</td><td className="num">{gs(r.debit)}</td><td className="num">{gs(r.credit)}</td><td className="num">{gs(r.balance)}</td></tr>)}
            <tr><td><b>Totales</b></td><td className="num"><b>{gs(data.totalDebit)}</b></td><td className="num"><b>{gs(data.totalCredit)}</b></td><td>{data.totalDebit === data.totalCredit ? <span className="pill ok">Cuadra</span> : <span className="pill bad">No cuadra</span>}</td></tr>
          </tbody></table>
          <button style={{ marginTop: 12 }} onClick={() => csv([['Cuenta', 'Nombre', 'Debe', 'Haber', 'Saldo'], ...data.rows.map((r: any) => [r.code, r.name, r.debit, r.credit, r.balance])], 'balance-de-sumas.csv')}>Exportar a Excel (CSV)</button>
        </div>
      )}
      {tab === 'income' && data && (
        <div className="card"><table><tbody>
          <Section title="Ingresos" rows={data.income} total={data.totalIncome} />
          <Section title="Egresos" rows={data.expenses} total={data.totalExpenses} />
          <tr><td>Ganancia bruta (ventas − costo)</td><td className="num">{gs(data.grossProfit)}</td></tr>
          <tr><td><b>Resultado del período</b></td><td className="num"><b>{gs(data.netIncome)}</b></td></tr>
        </tbody></table></div>
      )}
      {tab === 'balance' && data && (
        <div className="card"><table><tbody>
          <Section title="Activo" rows={data.assets} total={data.totalAssets} />
          <Section title="Pasivo" rows={data.liabilities} total={data.totalLiabilities} />
          <tr><th colSpan={2}>Patrimonio</th></tr>
          {data.equity.map((r: any) => <tr key={r.code}><td>{r.code} · {r.name}</td><td className="num">{gs(r.balance)}</td></tr>)}
          <tr><td>Resultado del período</td><td className="num">{gs(data.netIncome)}</td></tr>
          <tr><td><b>Total patrimonio</b></td><td className="num"><b>{gs(data.totalEquity)}</b></td></tr>
          <tr><td>Activo = Pasivo + Patrimonio</td><td className="num">{data.balanced ? <span className="pill ok">Cuadra</span> : <span className="pill bad">No cuadra</span>}</td></tr>
        </tbody></table></div>
      )}
      {tab === 'entry' && (
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <h2>Asiento manual (saldos iniciales, gastos, ajustes)</h2>
          <label>Descripción<input value={entry.description} onChange={(e) => setEntry({ ...entry, description: e.target.value })} /></label>
          {entry.lines.map((l, i) => (
            <div className="form" key={i}>
              <label>Cuenta<select value={l.code} onChange={(e) => setEntry({ ...entry, lines: entry.lines.map((x, j) => j === i ? { ...x, code: e.target.value } : x) })}>{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></label>
              <label>Debe<NumInput value={l.debit} onChange={(e) => setEntry({ ...entry, lines: entry.lines.map((x, j) => j === i ? { ...x, debit: e.target.value } : x) })} /></label>
              <label>Haber<NumInput value={l.credit} onChange={(e) => setEntry({ ...entry, lines: entry.lines.map((x, j) => j === i ? { ...x, credit: e.target.value } : x) })} /></label>
            </div>
          ))}
          <div className="row"><button onClick={() => setEntry({ ...entry, lines: [...entry.lines, { code: '1.1.01', debit: '', credit: '' }] })}>+ Línea</button><button className="primary" onClick={saveEntry}>Registrar asiento</button></div>
        </div>
      )}
    </>
  )
}
