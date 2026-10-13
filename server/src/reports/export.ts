import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Column, ReportResult, Section } from './core.js'

export interface ExportMeta { shopName: string; address?: string; user: string; generatedAt: Date; filtersText: string }

const LOGO = fileURLToPath(new URL('../../../web/public/icons/icon-192.png', import.meta.url))
const fmtDate = (d: unknown, withTime = false) => {
  if (!d) return ''
  const x = d instanceof Date ? d : new Date(String(d).length === 10 ? d + 'T00:00:00-03:00' : String(d))
  if (isNaN(x.getTime())) return String(d)
  const local = new Date(x.getTime() - 3 * 3600_000)
  const iso = local.toISOString()
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}${withTime ? ' ' + iso.slice(11, 16) : ''}`
}
const money = (n: unknown) => Number(n ?? 0).toLocaleString('es-PY')

function cellText(c: Column, v: unknown) {
  if (v === null || v === undefined || v === '') return ''
  switch (c.type) {
    case 'money': case 'int': return money(v)
    case 'percent': return `${Number(v).toLocaleString('es-PY', { maximumFractionDigits: 1 })}%`
    case 'date': return fmtDate(v)
    case 'datetime': return fmtDate(v, true)
    default: return String(v)
  }
}

// Mantiene solo las columnas elegidas (el orden lo define el reporte).
export function pickColumns(r: ReportResult, keys?: string[]): ReportResult {
  if (!keys?.length) return r
  const set = new Set(keys)
  return { ...r, columns: r.columns.filter((c) => set.has(c.key) || c === r.columns[0]) }
}

// ---------------------------------------------------------------- Excel
export async function buildXlsx(r: ReportResult, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = meta.user
  wb.created = meta.generatedAt
  const ws = wb.addWorksheet(r.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Reporte', { views: [{ state: 'frozen', ySplit: 8 }] })
  const ncols = Math.max(r.columns.length, 3)
  const head = (row: number, text: string, size = 11, bold = false) => {
    ws.mergeCells(row, 1, row, ncols)
    const c = ws.getCell(row, 1)
    c.value = text
    c.font = { size, bold }
  }
  head(1, meta.shopName, 16, true)
  head(2, r.title, 13, true)
  head(3, r.subtitle ?? '')
  head(4, meta.filtersText ? `Filtros: ${meta.filtersText}` : 'Sin filtros adicionales')
  head(5, `Generado el ${fmtDate(meta.generatedAt, true)} por ${meta.user}`)
  head(6, '')

  const writeTable = (startRow: number, cols: Column[], rows: Record<string, any>[], totals?: Record<string, any>, title?: string) => {
    let row = startRow
    if (title) { ws.mergeCells(row, 1, row, ncols); ws.getCell(row, 1).value = title; ws.getCell(row, 1).font = { bold: true, size: 12 }; row++ }
    const h = ws.getRow(row)
    cols.forEach((c, i) => {
      const cell = h.getCell(i + 1)
      cell.value = c.label
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2330B8' } }
      cell.alignment = { vertical: 'middle', horizontal: ['money', 'int', 'percent'].includes(c.type) ? 'right' : 'left', wrapText: true }
    })
    const headerRow = row
    row++
    for (const data of rows) {
      const wr = ws.getRow(row++)
      cols.forEach((c, i) => {
        const cell = wr.getCell(i + 1)
        const v = data[c.key]
        if (v === null || v === undefined || v === '') return
        if (c.type === 'money' || c.type === 'int') { cell.value = Number(v); cell.numFmt = c.type === 'money' ? '#,##0;[Red]-#,##0' : '#,##0' }
        else if (c.type === 'percent') { cell.value = Number(v) / 100; cell.numFmt = '0.0%' }
        else if (c.type === 'date' || c.type === 'datetime') {
          const d = v instanceof Date ? v : new Date(String(v).length === 10 ? v + 'T12:00:00-03:00' : String(v))
          if (!isNaN(d.getTime())) { cell.value = d; cell.numFmt = c.type === 'date' ? 'dd/mm/yyyy' : 'dd/mm/yyyy hh:mm' } else cell.value = String(v)
        } else cell.value = String(v)
        if (c.key === 'label' && typeof data.level === 'number') cell.alignment = { indent: data.level * 2 }
        if (data.bold) cell.font = { bold: true }
      })
    }
    if (totals) {
      const tr = ws.getRow(row++)
      cols.forEach((c, i) => {
        const cell = tr.getCell(i + 1)
        const v = totals[c.key]
        if (v !== undefined && v !== null && v !== '') {
          if (c.type === 'money' || c.type === 'int') { cell.value = Number(v); cell.numFmt = c.type === 'money' ? '#,##0;[Red]-#,##0' : '#,##0' }
          else if (c.type === 'percent') { cell.value = Number(v) / 100; cell.numFmt = '0.0%' } else cell.value = String(v)
        }
        cell.font = { bold: true }
        cell.border = { top: { style: 'thin' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1F9' } }
      })
    }
    return { headerRow, next: row + 1 }
  }

  const main = writeTable(7, r.columns, r.rows, r.totals)
  ws.autoFilter = { from: { row: main.headerRow, column: 1 }, to: { row: main.headerRow, column: r.columns.length } }
  ws.views = [{ state: 'frozen', ySplit: main.headerRow }]
  let next = main.next
  for (const s of r.sections ?? []) next = writeTable(next + 1, s.columns, s.rows, s.totals, s.title).next
  r.columns.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...r.rows.slice(0, 200).map((row) => cellText(c, row[c.key]).length))
    ws.getColumn(i + 1).width = Math.min(Math.max(c.type === 'money' ? 16 : 10, longest + 2), c.type === 'text' ? 48 : 22)
  })
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ---------------------------------------------------------------- CSV
export function buildCsv(r: ReportResult): Buffer {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [r.columns.map((c) => esc(c.label)).join(';')]
  for (const row of r.rows) lines.push(r.columns.map((c) => (c.type === 'money' || c.type === 'int' || c.type === 'percent' ? String(row[c.key] ?? '') : esc(row[c.key] instanceof Date ? row[c.key].toISOString() : row[c.key]))).join(';'))
  if (r.totals) lines.push(r.columns.map((c) => (c.type === 'money' || c.type === 'int' || c.type === 'percent' ? String(r.totals![c.key] ?? '') : esc(r.totals![c.key]))).join(';'))
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8')
}

// ---------------------------------------------------------------- PDF
const WEIGHT: Record<string, number> = { text: 1.7, money: 1.1, int: 0.6, date: 0.9, datetime: 1.2, percent: 0.7, status: 1.1 }
const pdfSafe = (s: string) => s.replace(/[→]/g, '->').replace(/[←]/g, '<-').replace(/[^\x00-\xFF–—‘’“”•€…›]/g, '?')

export function buildPdf(r: ReportResult, meta: ExportMeta, opts: { charts?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = r.columns.length > 6
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 32, bufferPages: true, info: { Title: r.title, Author: meta.user } })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    const left = doc.page.margins.left
    const width = doc.page.width - left - doc.page.margins.right
    const bottom = () => doc.page.height - doc.page.margins.bottom - 18

    const header = () => {
      let y = doc.page.margins.top
      if (existsSync(LOGO)) doc.image(LOGO, left, y, { width: 34, height: 34 })
      doc.fillColor('#1d2030').font('Helvetica-Bold').fontSize(15).text(pdfSafe(meta.shopName), left + 44, y + 2, { width: width - 44 })
      doc.font('Helvetica').fontSize(8.5).fillColor('#687090').text(pdfSafe([meta.address, `Generado el ${fmtDate(meta.generatedAt, true)} por ${meta.user}`].filter(Boolean).join(' · ')), left + 44, y + 20, { width: width - 44 })
      y += 44
      doc.fillColor('#1d2030').font('Helvetica-Bold').fontSize(13).text(pdfSafe(r.title), left, y, { width })
      y = doc.y + 1
      if (r.subtitle) { doc.font('Helvetica').fontSize(9).fillColor('#3a4060').text(pdfSafe(r.subtitle), left, y, { width }); y = doc.y }
      doc.font('Helvetica').fontSize(8).fillColor('#687090').text(pdfSafe(meta.filtersText ? `Filtros: ${meta.filtersText}` : 'Sin filtros adicionales'), left, y + 1, { width })
      doc.y += 8
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#e1e6f3').stroke()
      doc.y += 8
    }
    header()

    // Gráfico de barras opcional (reportes agrupados)
    if (opts.charts && r.groupBy && r.rows.length && r.rows.length <= 24) {
      const vc = r.columns.find((c) => c.type === 'money' && ['net', 'amount', 'collected', 'income', 'total'].includes(c.key)) ?? r.columns.find((c) => c.type === 'money')
      if (vc) {
        const max = Math.max(...r.rows.map((x) => Math.abs(Number(x[vc.key] ?? 0))), 1)
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#1d2030').text(pdfSafe(vc.label), left, doc.y)
        doc.y += 3
        for (const row of r.rows) {
          if (doc.y > bottom() - 14) { doc.addPage(); header() }
          const y = doc.y
          doc.font('Helvetica').fontSize(7.5).fillColor('#3a4060').text(pdfSafe(String(row[r.columns[0].key] ?? '')), left, y + 1, { width: 120, ellipsis: true, lineBreak: false })
          const w = Math.max((Math.abs(Number(row[vc.key] ?? 0)) / max) * (width - 230), 1)
          doc.rect(left + 125, y, w, 9).fill('#2330b8')
          doc.fillColor('#1d2030').text(money(row[vc.key]), left + 130 + w, y + 1, { width: 100, lineBreak: false })
          doc.y = y + 12
        }
        doc.y += 8
      }
    }

    const table = (cols: Column[], rows: Record<string, any>[], totals?: Record<string, any>, title?: string) => {
      if (title) { if (doc.y > bottom() - 40) { doc.addPage(); header() } doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d2030').text(pdfSafe(title), left, doc.y + 4, { width }); doc.y += 4 }
      const total = cols.reduce((a, c) => a + (WEIGHT[c.type] ?? 1), 0)
      const widths = cols.map((c) => ((WEIGHT[c.type] ?? 1) / total) * width)
      const fs = cols.length > 9 ? 6.5 : cols.length > 6 ? 7.5 : 8.5
      const rowH = fs + 8
      const drawHead = () => {
        let x = left
        const y = doc.y
        doc.rect(left, y, width, rowH + 2).fill('#2330b8')
        cols.forEach((c, i) => {
          doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(fs).text(pdfSafe(c.label), x + 3, y + 4, { width: widths[i] - 6, align: ['money', 'int', 'percent'].includes(c.type) ? 'right' : 'left', ellipsis: true, lineBreak: false })
          x += widths[i]
        })
        doc.y = y + rowH + 2
      }
      drawHead()
      const drawRow = (data: Record<string, any>, bold: boolean, shade: boolean) => {
        if (doc.y + rowH > bottom()) { doc.addPage(); header(); drawHead() }
        const y = doc.y
        if (shade) doc.rect(left, y, width, rowH).fill('#f4f6fb')
        let x = left
        cols.forEach((c, i) => {
          const indent = c.key === 'label' && typeof data.level === 'number' ? data.level * 10 : 0
          doc.fillColor(bold || data.bold ? '#10122a' : '#1d2030').font(bold || data.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs)
            .text(pdfSafe(cellText(c, data[c.key])), x + 3 + indent, y + 4, { width: widths[i] - 6 - indent, align: ['money', 'int', 'percent'].includes(c.type) ? 'right' : 'left', ellipsis: true, lineBreak: false })
          x += widths[i]
        })
        doc.y = y + rowH
      }
      rows.forEach((row, i) => drawRow(row, false, i % 2 === 1))
      if (totals) { doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#1d2030').lineWidth(0.8).stroke(); drawRow(totals, true, true) }
      doc.y += 8
    }
    table(r.columns, r.rows, r.totals)
    for (const s of r.sections ?? []) table(s.columns, s.rows, s.totals, s.title)

    const pages = doc.bufferedPageRange()
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i)
      doc.font('Helvetica').fontSize(7.5).fillColor('#687090').text(`Página ${i + 1} de ${pages.count}`, left, doc.page.height - doc.page.margins.bottom + 2, { width, align: 'right', lineBreak: false })
    }
    doc.end()
  })
}

export const exportSections = (s: Section[] | undefined) => s ?? []
