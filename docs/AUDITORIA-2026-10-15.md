# Auditoría integral — Librería Samantha
Fecha: 15/10/2026 · Dominio: https://libreriasamantha.com.py · Versión auditada: commit `58488ca` + correcciones de esta auditoría

> **Conclusión honesta:** el sistema NO se declara "100 % listo para producción". Lo verificado con pruebas funciona y se corrigieron los defectos críticos hallados, pero hay **3 bloqueos que dependen de datos/credenciales del negocio** (tarjeta real, facturación electrónica real, cuenta bancaria real) y funciones que el plan pide y todavía no existen (valoraciones de clientes). Detalle en la sección 8.

---------------------------------------------------------------------------------------------------

## 1. Inventario de módulos
Base: Fastify + TypeScript (≈261 rutas), React 19 + Vite, PostgreSQL 18 (82 tablas, 14 MB), Docker Swarm/Dokploy, Cloudflare + Traefik.

| Módulo | Pantalla / API | Estado |
|---|---|---|
| Acceso y roles | Login, perfil, 8 roles (owner, admin, cashier, seller, buyer, warehouse, accountant, support) | Verificado |
| Productos | Productos e inventario, importación, imágenes, códigos de barras/QR/ISBN, ofertas | Verificado (alta, validaciones, duplicados) |
| Inventario | Ajustes, conteo con escáner, kardex | Verificado (ajuste, stock nunca negativo) |
| Tienda en línea | Catálogo, carrito, checkout, cuenta de cliente, seguimiento, listas escolares | Verificado |
| **Delivery (nuevo)** | Panel `/delivery`: 263 municipios, tarifa general Gs. 30.000, tarifa por ciudad/departamento, delivery gratis, plazos, historial, cobros por ciudad | Verificado (40 pruebas) |
| Pagos en línea | Tarjeta (Bancard), transferencia con comprobante, contra entrega | Tarjeta **simulada** (ver 8) |
| Punto de venta | Caja, ventas, pago mixto, crédito, descuentos con autorización, suspender, impresiones | Verificado |
| Caja | Apertura/cierre, arqueo, movimientos | Verificado (apertura/duplicada/cierre) |
| Compras y proveedores | Órdenes, recepción, facturas, pagos | Existe; cubierto parcialmente (ver 3) |
| Clientes y crédito | Saldo, límite, cuotas | Verificado (límite) |
| **Gastos** | `/gastos` (nuevo acceso directo): categorías (Luz, Agua, Teléfono e internet, Alquiler, Sueldos…), recurrentes, pago | Verificado visualmente; atajos agregados |
| Contabilidad | Plan de cuentas, asientos automáticos | Existe |
| Facturación electrónica | SIFEN | **Simulada** (ver 8) |
| Reportes | Ventas, finanzas, delivery por ciudad/período (+CSV) | Verificado (delivery) |
| Asistente IA | Chat con agente (catálogo, carrito, pedido, seguimiento) | Verificado en sesión previa |
| PWA | Instalable, offline parcial | Verificado en sesión previa |

## 2. Funciones faltantes o incompletas
| # | Falta | Prioridad |
|---|---|---|
| F1 | **Valoraciones/reseñas de clientes** (el plan las menciona): no existe el módulo | Media |
| F2 | Pago con tarjeta real (Bancard vPOS): solo modo simulado | **Bloqueante para cobrar con tarjeta** |
| F3 | Facturación SIFEN real (timbrado, certificado, habilitación DNIT) | **Bloqueante legal** |
| F4 | Cuenta bancaria real para transferencias (hoy hay una cuenta "Banco de Ejemplo (demo)" visible a clientes) | **Bloqueante** |
| F5 | Dirección, horarios y "retiro en el local" son datos de ejemplo (su Instagram dice que no hay tienda física) | Media |
| F6 | Monitoreo/alertas externas (uptime) | Media |
| F7 | Pruebas automáticas dentro del repositorio (hoy los scripts están fuera de él) | Baja |

## 3. Matriz de pruebas (entorno aislado: copia de la base de producción)
Total: **90 comprobaciones aprobadas, 0 fallidas** (40 de Delivery + 50 de auditoría general). Pasa = ✔.

| Área | Prueba | Resultado |
|---|---|---|
| Seguridad | 13 endpoints del panel sin sesión → 401/404 | ✔ |
| Seguridad | Token inventado → 401 | ✔ |
| Permisos | Cajera no ve usuarios, no cambia delivery, no ve costos, no anula, no cambia precio | ✔ |
| Permisos | Depósito no vende; comprador no abre caja; admin sí ve delivery | ✔ |
| Inyección | Búsqueda con `' OR 1=1; DROP TABLE…` no rompe | ✔ |
| Productos | Alta, precio negativo rechazado, código duplicado rechazado, stock inicial | ✔ |
| Caja | Abrir; segunda caja del mismo usuario rechazada | ✔ |
| POS | Venta sin pago / pago insuficiente rechazados | ✔ |
| POS | Vuelto solo en efectivo; venta con vuelto 30.000; pago registrado por el neto | ✔ |
| POS | Pago mixto efectivo + tarjeta (2 pagos registrados) | ✔ |
| POS | Crédito: exige cliente, respeta el límite, actualiza saldo | ✔ |
| POS | Descuento >10 % requiere autorización; precio no modificable por cajera | ✔ |
| **POS** | **Reintento con la misma clave NO duplica venta ni stock; 4 envíos simultáneos → 1 venta** | ✔ (tras corrección B3) |
| Stock | 4 compradores simultáneos (2 POS + 2 tienda) por 1 unidad → gana 1; stock nunca negativo | ✔ |
| Pedido online | Delivery 30.000 + productos = total correcto; pedido guarda copia del cargo | ✔ |
| Pagos | Confirmación con token falso → 403; con importe distinto → rechazada | ✔ |
| Pagos | 3 confirmaciones simultáneas → 1 sola venta/pago/descuento de stock | ✔ |
| Pagos | Pago rechazado → pedido "rejected", sin venta | ✔ |
| Anulación | Anular venta repone stock; no se puede anular dos veces; cajera no puede | ✔ |
| Delivery | 40 pruebas: catálogo, tarifa general, por ciudad, activar/desactivar, gratis por monto, ventana de promo, historial, bloqueo de manipulación del cliente, doble envío, reporte | ✔ |
| Interfaz | Delivery en teléfono/tableta/escritorio sin desborde; checkout con costo por ciudad; POS con popup; cambio de clave obligatorio; Gastos con atajos | ✔ (capturas) |
| Backup | Restauración del respaldo en base vacía: coincide en productos, ventas, pedidos, ciudades, usuarios | ✔ |

**No cubierto / pendiente de prueba:** compras y recepción de mercadería (flujo completo), reportes contables cruzados, cierre de caja con diferencias, escáner de cámara en dispositivos reales (la función existe y se probó antes de esta auditoría), carga con muchos usuarios simultáneos (prueba de estrés).

## 4. Bitácora de defectos
| ID | Sev. | Hallazgo (evidencia) | Estado |
|---|---|---|---|
| B1 | **Crítica** | Contraseñas de fábrica activas en producción: `admin/admin1234`, `caja/caja1234`, `compras/compras1234`, `deposito/deposito1234` (login 200 el 15/10) | **Corregido**: el sistema obliga a cambiarlas al ingresar (el servidor bloquea todo lo demás) y rechaza claves comunes. **Acción del dueño:** ingresar y elegir las claves. |
| B2 | **Crítica** | Sin límite de intentos de login: 12 intentos malos seguidos → todos 401 | **Corregido**: 6 intentos por usuario+IP / 40 por IP cada 15 min → 429 |
| B3 | Alta | Venta del POS sin protección de reintento: un corte de red/doble toque podía duplicar venta y descuento de stock | **Corregido**: clave de idempotencia + índice único; probado con 4 envíos simultáneos |
| B4 | **Crítica** | Tarjeta "simulada" activa en la tienda real: cualquier cliente podía "aprobar" su propio pago sin pagar | **Corregido**: en producción el pago con tarjeta queda deshabilitado mientras sea simulado (`ALLOW_MOCK_PAYMENTS=1` solo para demostración) |
| B5 | Alta | Faltaban cabeceras de seguridad (HSTS, nosniff, X-Frame-Options, Referrer/Permissions-Policy) y la API se podía cachear | **Corregido** |
| B6 | Media | La variable `PUBLIC_URL` en producción es `libreria.cnid.com.py` (dominio viejo, sin `https://`): los enlaces de pago, verificación de correo y recuperación de clave salían mal | **Mitigado** en código (agrega `https://`); **acción del dueño/infra:** cambiar la variable a `https://libreriasamantha.com.py` en Dokploy |
| B7 | Media | Invitado que enviaba el checkout dos veces creaba 2 pedidos (índice único no cubría cuenta nula) | **Corregido** (índice nuevo) y verificado |
| B8 | Media | `/delivery/cities` fallaba (500) por SQL en el filtro de departamentos y en el conteo | **Corregido** antes de publicar (detectado en pruebas de interfaz) |
| B9 | Media | Los gastos existían pero estaban escondidos dentro de una pestaña de "Dinero y gastos" | **Corregido**: pantalla propia **Gastos** en el menú con atajos Luz, Agua, Teléfono, Alquiler… |
| B10 | Media | El respaldo automático de la base de Samantha no existía (solo estaban las otras apps) | **Corregido**: agregado al respaldo nocturno 03:17, retención 14 días; restauración verificada |
| B11 | Media | Facturación SIFEN en modo simulado y habilitada (timbrado `00000000`): se emitían facturas sin validez | **Abierto** (requiere timbrado/certificado) |
| B12 | Media | Cuenta bancaria "demo" visible a clientes para transferir | **Abierto** (requiere datos reales) |
| B13 | Baja | POS: sin popup de confirmación antes de cobrar | **Corregido** (productos, cantidades, descuentos, total, medio, monto recibido, vuelto, cliente) |
| B14 | Baja | Dos desfases de dominio: el dominio `libreria.cnid.com.py` ya no enruta (404) | Informado |

## 5. Correcciones implementadas
Delivery completo (módulo, catálogo, checkout, agente IA), B1–B10 y B13 arriba. Migraciones idempotentes (`schema8.sql`, `schema9.sql`). Respaldo previo a cada despliegue en `/root/backups/`.

## 6. Resultados de integración / regresión
- Delivery: 40/40 tras cada cambio de servidor (re-ejecutadas 3 veces).
- Auditoría general: 50/50.
- Compilación TypeScript (servidor y web) sin errores.
- Producción tras el despliegue del 15/10: 263 ciudades en 18 departamentos, tarifa 30.000 en todas, endpoints del panel responden 401 sin sesión, 5 pedidos previos intactos, sin pedidos de prueba creados.

## 7. Seguridad, rendimiento y respaldos
- HTTPS obligatorio (301 desde http), Cloudflare + Traefik. HSTS y cabeceras agregadas.
- Autorización siempre en el servidor (probado con 4 roles + anónimo). Precios, delivery, descuentos y stock se calculan en el servidor.
- Consultas parametrizadas (prueba de inyección). React escapa la salida (sin `dangerouslySetInnerHTML` en pedidos).
- Rendimiento medido en producción: tienda 0,13 s; catálogo 0,31 s; cotización de delivery 0,27 s.
- Respaldos: nocturno 03:17 vía `/root/backups/pg-backup.sh` (14 días) + copia manual previa al despliegue. **Restauración probada.** Aún no hay copia fuera del servidor (recomendado).
- Reversión: `git revert 58488ca…` + redeploy; la base se restaura con `pg_restore` del respaldo `libreria_pre-delivery_*.dump`.

## 8. Estado final y bloqueos
**Se puede operar** la tienda con transferencia y pago contra entrega, y el POS, con las claves cambiadas. **Para decir "100 %" faltan:**
1. Credenciales Bancard (tarjeta real) — hasta entonces la tarjeta queda oculta en producción.
2. Timbrado/certificado SIFEN — hasta entonces las facturas no tienen validez fiscal.
3. Datos bancarios reales (y desactivar la cuenta demo), dirección/horarios reales y definir si hay retiro en local.
4. `PUBLIC_URL=https://libreriasamantha.com.py` en Dokploy.
5. Decidir si se desarrolla el módulo de valoraciones y completar pruebas de compras/reportes/estrés.
