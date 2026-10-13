// Datos de ejemplo: completa el catálogo con libros y útiles y les genera una imagen a cada producto que no tenga.
// Uso: npx tsx src/db/demo.ts   (es repetible: no duplica productos ni imágenes)
import 'dotenv/config'
import sharp from 'sharp'
import { createPool, migrate } from './client.js'

const db = createPool(process.env.DATABASE_URL!)
await migrate(db)

const PALETTES: [string, string][] = [['#1f3a8a', '#4f46e5'], ['#9f1239', '#e11d48'], ['#065f46', '#10b981'], ['#7c2d12', '#ea580c'], ['#4c1d95', '#8b5cf6'], ['#0f766e', '#14b8a6'], ['#1e293b', '#475569'], ['#92400e', '#f59e0b']]
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const wrap = (text: string, max: number) => {
  const out: string[] = []; let line = ''
  for (const w of text.split(' ')) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w } else line = (line + ' ' + w).trim() }
  if (line) out.push(line); return out.slice(0, 4)
}

function bookSvg(title: string, author: string | null, i: number) {
  const [a, b] = PALETTES[i % PALETTES.length]
  const lines = wrap(title, 14)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef2ff"/><stop offset="1" stop-color="#dbe4ff"/></linearGradient>
  <linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
  <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="14" dy="22" stdDeviation="18" flood-color="#0f172a" flood-opacity=".35"/></filter></defs>
  <rect width="800" height="800" fill="url(#bg)"/>
  <g filter="url(#s)"><rect x="230" y="110" width="360" height="560" rx="14" fill="url(#c)"/><rect x="230" y="110" width="30" height="560" rx="14" fill="#000" opacity=".22"/>
  <rect x="590" y="122" width="14" height="536" fill="#f8fafc"/><rect x="596" y="126" width="6" height="528" fill="#e2e8f0"/></g>
  <circle cx="440" cy="235" r="48" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="5"/><path d="M440 195v80M410 225h60" stroke="#fff" stroke-opacity=".9" stroke-width="7" stroke-linecap="round"/>
  ${lines.map((l, n) => `<text x="425" y="${350 + n * 52}" text-anchor="middle" font-family="Georgia,serif" font-size="44" font-weight="700" fill="#fff">${esc(l)}</text>`).join('')}
  <line x1="320" x2="530" y1="${360 + lines.length * 52}" y2="${360 + lines.length * 52}" stroke="#fff" stroke-opacity=".6" stroke-width="3"/>
  ${author ? `<text x="425" y="${405 + lines.length * 52}" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" fill="#fff" fill-opacity=".9">${esc(author)}</text>` : ''}
  <text x="425" y="640" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" letter-spacing="4" fill="#fff" fill-opacity=".7">SAMANTHA</text></svg>`
}

const ICONS: Record<string, string> = {
  notebook: '<rect x="270" y="130" width="260" height="360" rx="22" fill="#fff"/><rect x="270" y="130" width="46" height="360" rx="22" fill="#4f46e5"/><g stroke="#cbd5e1" stroke-width="5">' + Array.from({ length: 9 }, (_, i) => `<line x1="345" x2="505" y1="${190 + i * 34}" y2="${190 + i * 34}"/>`).join('') + '</g>' + Array.from({ length: 8 }, (_, i) => `<circle cx="293" cy="${165 + i * 42}" r="8" fill="#fff"/>`).join(''),
  pencil: '<g transform="rotate(-35 400 330)"><rect x="330" y="90" width="80" height="360" rx="8" fill="#facc15"/><rect x="330" y="90" width="80" height="48" rx="8" fill="#f472b6"/><rect x="330" y="138" width="80" height="22" fill="#cbd5e1"/><polygon points="330,450 410,450 370,540" fill="#fcd9a8"/><polygon points="352,495 388,495 370,540" fill="#334155"/></g>',
  pen: '<g transform="rotate(35 400 330)"><rect x="350" y="90" width="64" height="330" rx="32" fill="#2563eb"/><rect x="350" y="150" width="64" height="26" fill="#1e3a8a"/><polygon points="355,420 409,420 382,500" fill="#cbd5e1"/><rect x="418" y="110" width="9" height="150" rx="4" fill="#1e3a8a"/></g>',
  paper: '<g><rect x="250" y="170" width="300" height="300" rx="10" fill="#e2e8f0"/><rect x="265" y="150" width="300" height="300" rx="10" fill="#f1f5f9"/><rect x="280" y="130" width="300" height="300" rx="10" fill="#fff"/><g stroke="#cbd5e1" stroke-width="6">' + Array.from({ length: 6 }, (_, i) => `<line x1="320" x2="540" y1="${185 + i * 36}" y2="${185 + i * 36}"/>`).join('') + '</g></g>',
  printer: '<rect x="270" y="150" width="260" height="120" rx="8" fill="#fff"/><rect x="220" y="260" width="360" height="190" rx="26" fill="#334155"/><rect x="270" y="370" width="260" height="140" rx="8" fill="#fff"/><g stroke="#94a3b8" stroke-width="6"><line x1="300" x2="500" y1="410" y2="410"/><line x1="300" x2="470" y1="440" y2="440"/></g><circle cx="530" cy="300" r="12" fill="#22c55e"/>',
  truck: '<rect x="200" y="260" width="260" height="170" rx="14" fill="#fff"/><path d="M460 310h90l50 60v60H460z" fill="#4f46e5"/><circle cx="300" cy="450" r="44" fill="#1e293b"/><circle cx="300" cy="450" r="18" fill="#cbd5e1"/><circle cx="540" cy="450" r="44" fill="#1e293b"/><circle cx="540" cy="450" r="18" fill="#cbd5e1"/>',
  box: '<polygon points="400,170 600,260 400,350 200,260" fill="#fbbf24"/><polygon points="200,260 400,350 400,570 200,480" fill="#d97706"/><polygon points="600,260 400,350 400,570 600,480" fill="#f59e0b"/>',
}
function iconSvg(kind: string, i: number) {
  const [a, b] = PALETTES[i % PALETTES.length]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
  <filter id="s"><feDropShadow dx="0" dy="16" stdDeviation="14" flood-color="#000" flood-opacity=".3"/></filter></defs><rect width="800" height="800" fill="url(#g)"/><circle cx="660" cy="130" r="150" fill="#fff" fill-opacity=".08"/><circle cx="110" cy="700" r="200" fill="#fff" fill-opacity=".07"/>
  <g filter="url(#s)">${ICONS[kind] ?? ICONS.box}</g></svg>`
}

// Catálogo de ejemplo adicional (se crea solo si el código no existe)
const BOOKS: [string, string, string, number, number][] = [
  ['LIB-BIB-NVI', 'Santa Biblia Nueva Versión Internacional', 'Sociedad Bíblica', 145000, 85000],
  ['LIB-001', 'El Peregrino', 'John Bunyan', 68000, 38000],
  ['LIB-002', 'Mero Cristianismo', 'C. S. Lewis', 79000, 45000],
  ['LIB-003', 'Cartas del Diablo a su Sobrino', 'C. S. Lewis', 72000, 41000],
  ['LIB-004', 'Un Propósito Divino', 'Rick Warren', 85000, 50000],
  ['LIB-005', 'Devocional Diario', 'Charles Spurgeon', 59000, 33000],
  ['LIB-006', 'La Cabaña', 'William P. Young', 92000, 54000],
  ['LIB-007', 'Los Cinco Lenguajes del Amor', 'Gary Chapman', 76000, 43000],
]
const STATIONERY: [string, string, string, number, number][] = [
  ['ESC-CAR-A4', 'Carpeta oficio con elástico', 'Útiles escolares', 18000, 9000],
  ['ESC-MAR-12', 'Marcadores de colores x12', 'Útiles escolares', 32000, 18000],
  ['ESC-GOM', 'Goma de borrar blanca', 'Útiles escolares', 3500, 1500],
]
for (const [code, name, author, price, cost] of BOOKS) {
  await db.query(`INSERT INTO products (code, name, category, subcategory, author, price, cost, tax_rate, min_stock, stock, online_visible, language) VALUES ($1,$2,'Libros','Cristianos',$3,$4,$5,5,3,15,true,'Español') ON CONFLICT (code) DO NOTHING`, [code, name, author, price, cost])
}
for (const [code, name, cat, price, cost] of STATIONERY) {
  await db.query(`INSERT INTO products (code, name, category, price, cost, tax_rate, min_stock, stock, online_visible) VALUES ($1,$2,$3,$4,$5,10,5,40,true) ON CONFLICT (code) DO NOTHING`, [code, name, cat, price, cost])
}
// el stock inicial de lo recién creado queda registrado como movimiento
await db.query(`INSERT INTO stock_movements (product_id, type, qty, reason, stock_before, stock_after)
  SELECT p.id, 'opening', p.stock, 'Stock inicial de ejemplo', 0, p.stock FROM products p WHERE p.stock > 0 AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id)`)

const { rows } = await db.query(`SELECT p.id, p.name, p.author, p.category, p.kind FROM products p WHERE NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id) ORDER BY p.id`)
let n = 0
for (const [idx, p] of rows.entries()) {
  const lower = p.name.toLowerCase()
  const svg = p.category === 'Libros' ? bookSvg(p.name, p.author, idx)
    : iconSvg(/cuaderno|carpeta/.test(lower) ? 'notebook' : /l[aá]piz|marcador|goma/.test(lower) ? 'pencil' : /bol[ií]grafo/.test(lower) ? 'pen' : /resma|papel/.test(lower) ? 'paper' : /impres/.test(lower) ? 'printer' : /env[ií]o/.test(lower) ? 'truck' : 'box', idx)
  const { data, info } = await sharp(Buffer.from(svg)).resize(1000, 1000).webp({ quality: 82 }).toBuffer({ resolveWithObject: true })
  const { rows: im } = await db.query(`INSERT INTO product_images (product_id, position, mime, data, width, height, size, source_url) VALUES ($1,0,'image/webp',$2,$3,$4,$5,'demo') RETURNING id`, [p.id, data, info.width, info.height, data.length])
  await db.query('UPDATE products SET image_url = $2 WHERE id = $1', [p.id, `/api/shop/img/${im[0].id}?s=md`])
  n++
}
console.log(`Imágenes de ejemplo creadas: ${n}`)
await db.end()
