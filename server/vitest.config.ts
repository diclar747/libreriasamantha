import { defineConfig } from 'vitest/config'

// Cada archivo recrea su propia base de datos: se ejecutan de a uno para que Postgres
// no rechace CREATE DATABASE por usar la plantilla al mismo tiempo.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
})
