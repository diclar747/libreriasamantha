import pg from 'pg'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { seedGeo } from './geo.js'

// BIGINT (int8) llega como string por defecto; los importes en guaraníes caben en number.
pg.types.setTypeParser(20, (v) => Number(v))
// NUMERIC (sumas, redondeos y porcentajes) también llega como texto: se convierte a número.
pg.types.setTypeParser(1700, (v) => Number(v))

export type Db = pg.Pool
export type Tx = pg.PoolClient

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url })
}

export async function migrate(db: Db) {
  for (const file of ['schema.sql', 'schema2.sql', 'schema4.sql', 'chart.sql', 'chart2.sql', 'schema5.sql', 'chart3.sql', 'schema6.sql', 'schema7.sql']) {
    await db.query(readFileSync(fileURLToPath(new URL('./' + file, import.meta.url)), 'utf8'))
  }
  await seedGeo(db)
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    const out = await fn(tx)
    await tx.query('COMMIT')
    return out
  } catch (e) {
    await tx.query('ROLLBACK')
    throw e
  } finally {
    tx.release()
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}
