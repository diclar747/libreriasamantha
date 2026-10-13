import 'dotenv/config'
import { lanAddresses, loadHttpsOptions } from './https.js'
import { buildApp } from './app.js'
import { createPool, migrate } from './db/client.js'
import { releaseExpiredReservations } from './orders.js'
import { flushOutbox } from './services.js'
import { ensureDefaultPrompts } from './ai.js'
import { flushPushes } from './notifications.js'
import { ensureInstallments } from './credit.js'
import { runRecurringExpenses } from './routes/treasury.js'

const url = process.env.DATABASE_URL
if (!url) throw new Error('Falta DATABASE_URL (ver server/.env.example)')
const db = createPool(url)
await migrate(db)
await ensureDefaultPrompts(db)
await ensureInstallments(db)
await runRecurringExpenses(db).catch(() => {})
const app = buildApp(db)
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' })
// HTTPS para usar la cámara del teléfono dentro de la red del local (HTTPS_PORT=0 lo desactiva).
const httpsPort = Number(process.env.HTTPS_PORT ?? 3443)
if (httpsPort > 0) {
  const secure = buildApp(db, { https: await loadHttpsOptions() })
  await secure.listen({ port: httpsPort, host: '0.0.0.0' })
  console.log('HTTPS listo en https://localhost:' + httpsPort + (lanAddresses().length ? ' · en la red: ' + lanAddresses().map((ip) => 'https://' + ip + ':' + httpsPort).join(' ') : ''))
}

// Tareas periódicas: liberar reservas vencidas y enviar mensajes pendientes (con reintentos).
setInterval(() => { runRecurringExpenses(db).catch((e) => app.log.error(e)) }, 6 * 3600_000)
setInterval(() => { flushPushes(db).catch((e) => app.log.error(e)) }, 5_000)
setInterval(() => { releaseExpiredReservations(db).catch((e) => app.log.error(e)); flushOutbox(db).catch((e) => app.log.error(e)) }, 60_000)
