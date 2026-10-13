# Librería Samantha

Plataforma integrada: POS, inventario, compras, crédito, caja, contabilidad, facturación, tienda en línea, pagos, chatbot y mensajería.
Stack: Node + TypeScript, Fastify, PostgreSQL (`pg`), React + Vite.

## Puesta en marcha

1. PostgreSQL local con la base `libreria_samantha` (copiar `server/.env.example` a `server/.env`).
2. `npm install`
3. `npm run seed -w server` — esquema + datos de demostración (usuarios de desarrollo `admin`, `caja`, `compras`, `deposito`; contraseñas en la salida del comando).
4. `npm run dev:server` (API :3001) y `npm run dev:web` (UI :5173).
5. `npm test` — 18 pruebas de flujos críticos (bases `libreria_samantha_test*`, se recrean solas).

- Inicio y tienda pública: http://localhost:5173 (redirige a `/tienda`) · Acceso de usuarios y administradores: http://localhost:5173/admin

## Qué incluye

| Área | Estado |
|---|---|
| Productos, inventario (físico/reservado/disponible), importación CSV, etiquetas, historial de precios | Listo |
| Compras con recepción parcial, costo promedio y cuentas por pagar | Listo |
| POS: pagos combinados, vuelto, crédito con límite, suspendidas, presupuestos, anulaciones, cajas con cierre | Listo |
| Clientes, estado de cuenta y cobranzas | Listo |
| Contabilidad: asientos automáticos, diario, mayor, balance de sumas, resultados, balance general, asientos manuales | Listo (plan de cuentas base a validar con el contador) |
| Facturación y notas de crédito con numeración, estados y reintentos | Listo en **modo simulado**; SIFEN real requiere timbrado, certificado y habilitación DNIT |
| Tienda en línea, carrito, delivery/retiro, reservas con vencimiento, seguimiento, SEO básico (sitemap, robots, títulos) | Listo |
| Pagos en línea (Bancard vPOS): firma de confirmación, idempotencia, pago tardío, reembolso | Listo en **modo simulado**; falta conectar credenciales y verificar contra la documentación de Bancard |
| Mensajería (Winsap): cola con reintentos y webhook de entrada | Listo en **modo simulado**; falta confirmar la API de Winsap |
| Chatbot (web y WhatsApp): buscar, carrito, listas escolares, pedido + enlace de pago, estado, presupuesto de impresión | Listo con reglas; el punto de enchufe `chatReply` permite usar un modelo de IA |
| Reposición con aprobación, sin avisos repetidos | Listo |
| Órdenes de trabajo de impresión con anticipo | Listo |
| Listas escolares | Listo |

## App instalable, notificaciones y asistente con IA
- **PWA:** la administración (`/admin`) y la tienda (`/tienda`) se instalan como app (manifest propio para cada una, íconos, funciona sin conexión para mirar lo ya cargado). Para probar la instalación y el modo sin red, usá el build servido por la API: `npm run build` y abrí http://localhost:3001.
- **Diseño responsive:** escritorio con barra lateral, tablet con rail de íconos y teléfono con barra inferior, hoja "Más" y tablas convertidas en tarjetas.
- **Perfil** (`/profile`): foto, datos de contacto, cambio de contraseña y preferencias de avisos.
- **Notificaciones:** campana en la barra superior + **push nativo** (Web Push con claves VAPID, librería `web-push` de Node). Avisan de consultas en la tienda/WhatsApp, pedidos nuevos y pagados, pagos con excepción, impresiones, stock bajo y facturas rechazadas. Cada usuario elige qué recibir y en qué dispositivo. En iPhone, primero hay que instalar la app en la pantalla de inicio.
- **Asistente con IA:** proveedor elegible en *Configuración*: **Niro IA** (`https://niro.cnid.com.py`, formato OpenAI, `Authorization: Bearer niro_…`, el modelo lo elige el Router de Niro) o Claude de Anthropic. La clave se carga ahí (se guarda cifrada y no vuelve a mostrarse); en *Asistente con IA* se cargan los prompts (identidad, reglas y conocimiento del negocio), se ve el texto final que recibe el modelo y se prueba. Con la IA apagada o sin clave, el chat responde con reglas y con lo cargado en los prompts.

## Compras, finanzas, tienda y escaneo
- **Productos**: ficha completa, precio/IVA con calculadora de margen, ofertas con vigencia por canal, imágenes optimizadas, historial antes/después, sugerencias de precio al cambiar el costo, baja segura (se desactiva si tiene movimientos).
- **Compras**: orden (borrador → aprobación → emitida) → recepción (solo lo aceptado entra al stock) → factura (una factura puede cubrir varias órdenes; compra directa) → cuentas por pagar con cuotas, pagos parciales, anticipos, devoluciones y notas de crédito.
- **Dinero**: caja con arqueo y cierre, movimientos unificados, gastos recurrentes, liquidaciones de tarjetas/cheques, reportes con exportación a Excel/PDF/CSV.
- **Tienda**: solo muestra disponibilidad (nunca cantidades), entrega por ciudad (tarifa base Gs. 30.000 configurable), pago con tarjeta o transferencia con comprobante revisado por el local.
- **Escaneo**: cámara (EAN-13/8, UPC, Code 128, QR), lector USB, celular vinculado por QR temporal, conteo físico y etiquetas PDF. La cámara necesita HTTPS: el servidor abre https://localhost:3443 (certificado autofirmado; aceptarlo una vez en el celular). Variables: HTTPS_PORT, HTTPS_KEY, HTTPS_CERT.

- **Portal del cliente**: cuenta con correo verificado, direcciones, datos de facturación, favoritos, pedidos con línea de progreso, devoluciones y notificaciones; el personal gestiona estados, envíos, notas internas y devoluciones desde Pedidos de la tienda. Clientes de ejemplo: `npx tsx src/db/demo-customers.ts` (ana@cliente.test, luis@cliente.test, maria@cliente.test · Cliente123).

## Variables de entorno
`DATABASE_URL`, `PORT`, `PUBLIC_URL` (enlaces de pago), `BANCARD_MODE` / `BANCARD_PRIVATE_KEY`, `WINSAP_MODE` / `WINSAP_WEBHOOK_SECRET`.

## Pendiente antes de producción
Credenciales y contrato de Bancard y Winsap, habilitación SIFEN, validar plan de cuentas y cierres con el contador, modo sin conexión del POS (decisión de negocio), copias de seguridad, HTTPS/dominio, y cambiar las contraseñas de desarrollo.
