# Plata — gastos personales vía chat, alimentado por Binance

Nombre provisional: **plata**. Un solo repo, un bot de Telegram que conversa conmigo, un panel móvil y Postgres con pgvector. La IA va por omniroute.

---

## 0. Lo que ya comprobé (esto cambia el diseño)

| Pregunta | Respuesta | Qué implica |
|---|---|---|
| ¿La API trae mis P2P? | Sí. `GET /sapi/v1/c2c/orderMatch/listUserOrderHistory`: `tradeType`, `fiat`, `totalPrice`, `unitPrice`, `payMethodName`, `orderStatus`, `counterPartNickName`, `commission`. Ventana máxima de 30 días por llamada, solo 6 meses hacia atrás, 100 filas por página. | `payMethodName` indica el banco (Mercantil/BDV), así que sé a qué cuenta entraron o de cuál salieron los Bs. El backfill tiene que ir en ventanas de 30 días. |
| ¿La API trae Binance Pay? | Sí. `GET /sapi/v1/pay/transactions`: `orderType` (PAY, PAY_REFUND, C2C, CRYPTO_BOX, PAYOUT, REMITTANCE…), `amount`, `currency`, `payerInfo`, `receiverInfo`, `fundsDetail`. Ventana de 90 días, 18 meses hacia atrás. | Directo. |
| ¿La API trae los consumos de la **Binance Card**? | **No, no hay endpoint** de transacciones de la tarjeta. | La tarjeta cobra del Funding wallet. Tomo **snapshots del Funding wallet** (`POST /sapi/v1/asset/get-funding-asset`) cada N minutos; una bajada que ningún P2P, Pay, retiro o transferencia explica = *probable consumo de tarjeta* → el bot pregunta. Mejora opcional: reenviar a un webhook los correos de notificación de la tarjeta (traen el comercio). |
| ¿Mercantil y BDV tienen API? | No, para una persona no. | El saldo bancario es un **libro contable estimado**: saldo inicial que yo declaro + entradas P2P + gastos registrados. El bot concilia de vez en cuando ("¿Mercantil tiene ~8.400 Bs?"). Si hay diferencia, es un gasto sin registrar y se pide justificarlo. Opcionales: captura de pantalla de la app del banco (visión) o reenvío de SMS/notificaciones (Pago Móvil). |
| ¿Omniroute sirve para chat? | Sí: endpoint compatible con OpenAI, 122 modelos (`antigravity/gemini-*`, `claude-sonnet-5`, `auto/*`). `stream:false` obligatorio (lección de clayground). | LLM resuelto. |
| ¿Omniroute sirve para embeddings? | El endpoint `/v1/embeddings` existe, pero hoy responde `No credentials for embedding provider: gemini`. | Hay que añadir una API key de Gemini en omniroute (`gemini-embedding-001`, tiene capa gratuita) **o** generar los embeddings localmente con `@huggingface/transformers` (`multilingual-e5-small`, 384 dimensiones, sin servicio extra). Se decide en la Fase 0. |
| ¿Omniroute transcribe voz? | No hay modelos whisper/audio en la lista. Gemini acepta audio como entrada, pero no he probado si omniroute lo deja pasar. | Spike de la Fase 0: mandar un `.ogg` como `input_audio` a `gemini-2.5-flash`. Si falla: un contenedor `faster-whisper` o Groq Whisper. |

---

## 1. Decisiones de arquitectura

### 1.1 Telegram, no WhatsApp
- La Bot API es gratis y no requiere verificación de Meta ni plantillas aprobadas.
- **Inline keyboards** (los botones que quieres), edición de mensajes ya enviados (confirmar → "✅ registrado" en el mismo mensaje) y las notas de voz llegan como `.ogg`.
- **Telegram Mini App**: el panel React se abre *dentro* de Telegram con un botón, y la autenticación sale gratis (`initData` firmado por Telegram, sin login). Es lo que más pesa: el chat y el panel quedan en el mismo sitio del teléfono.
- WhatsApp Cloud API obliga a usar plantillas para escribir primero pasadas 24 h, y los nudges justamente escriben primero. Descartado.

### 1.2 El bot vive **dentro** del backend NestJS (no es otro servicio)
Separarlo implica duplicar el acceso a la DB, el cliente LLM y la lógica de dominio, o montar una API interna entre los dos. Para un solo usuario no hace falta. Quedan un contenedor `api` (NestJS + bot grammY en modo webhook + cron), un `web` (Vite React estático detrás de nginx/Caddy) y `db` (Postgres + pgvector).
Si algún día el bot necesita escalar por su cuenta, se saca a otro servicio; los módulos ya quedan separados.

### 1.3 Frontend: Vite + React, no Next
Es un panel privado de un usuario: no hay SEO ni SSR que justifiquen Next. Vite genera estáticos, sirve igual como Mini App o como PWA en el navegador y se despliega en un contenedor de nginx de 20 MB.

### 1.4 Librerías (las mínimas)
| Pieza | Elección | Por qué |
|---|---|---|
| Bot | **grammY** + `@grammyjs/conversations` + `@grammyjs/menu` | TypeScript nativo, la mejor DX para inline keyboards y flujos. |
| ORM | **Prisma 7** (adapter-pg) | Elección de Randy. pgvector vía `Unsupported("vector(384)")` + `$queryRaw`. |
| Cron / jobs | `@nestjs/schedule` + una tabla `jobs` en Postgres | Sin Redis ni BullMQ. Los nudges son pocos por día. |
| Binance | `fetch` + HMAC-SHA256 con `node:crypto` | Son 4 endpoints; un SDK no aporta nada. |
| LLM | `fetch` al endpoint de omniroute | Ídem. |
| Gráficas | Recharts | Suficiente para móvil. |
| UI | Tailwind + componentes a mano (o shadcn si molesta) | — |

### 1.5 Estructura del repo
```
plata/
  docker-compose.yml          # db, api, web (+ whisper opcional)
  .env.example
  api/                        # NestJS
    Dockerfile
    src/
      binance/                # cliente firmado + sync (p2p, pay, funding snapshots, spot)
      ledger/                 # cuentas, movimientos, transacciones, conciliación
      fx/                     # tasas: BCV + P2P implícita
      ai/                     # omniroute: parse, clasificar, embed, transcribir, ask
      bot/                    # grammY: handlers, keyboards, nudges
      insights/               # queries del panel + resúmenes
      db/                     # prisma.service (schema en api/prisma)
  web/                        # Vite React
    Dockerfile
    src/pages/ …
```

---

## 2. Modelo de dinero (la parte que hay que hacer bien)

### 2.1 Idea central: **mover dinero ≠ gastarlo**
Todo registro es de uno de estos tipos:
- **transfer**: el dinero cambia de cuenta propia a cuenta propia (P2P USDT→Bs en Mercantil, Spot→Funding, Mercantil→BDV). *No es gasto.*
- **expense**: el dinero sale de mi patrimonio (tarjeta, pago móvil a un comercio, Binance Pay a una tienda, efectivo).
- **income**: el dinero entra (sueldo, pago de un cliente, Pay recibido).
- **fee**: comisiones (P2P, retiros, spread). Es gasto, pero con su propia categoría.
- **fx_loss/gain**: opcional, más adelante.

### 2.2 Cuentas
```
binance_spot (USDT…)  binance_funding (USDT, alimenta la tarjeta)
mercantil (VES)       bdv (VES)
cash_usd              cash_ves       (opcional)
```
Cada cuenta tiene `currency`, `kind` (`synced`, sincronizada por API, o `ledger`, estimada) y `last_reconciled_at`/`last_reconciled_balance`.

### 2.3 Cómo se traduce cada fuente
| Evento de Binance | Registro |
|---|---|
| P2P **SELL** USDT, COMPLETED, pay method Mercantil | transfer: binance_funding −X USDT → mercantil +`totalPrice` VES. Queda la tasa implícita `unitPrice`. Se abre una **"bolsa"** (ver 2.4). |
| P2P **BUY** USDT pagando desde BDV | transfer: bdv −VES → binance_funding +USDT |
| Pay PAY enviado | expense *candidato* (¿comercio o persona?). El bot pregunta si es gasto, préstamo o transferencia a otra cuenta propia. |
| Pay recibido | income candidato |
| Bajada del Funding sin explicar | expense candidato "💳 tarjeta" con el monto; el bot pide comercio y categoría |
| Comisión P2P | fee |

### 2.4 "Bolsas" de conversión (seguimiento de lo que hice con cada cambio)
Cada P2P SELL crea una bolsa: *"12.000 Bs en Mercantil, 22/09 09:14, tasa 58,3"*.
- Los gastos que registro en Bs desde esa cuenta se descuentan de la bolsa más antigua que siga abierta (FIFO).
- Cada bolsa con saldo sin explicar dispara nudges (sección 4).
- Así respondo "¿en qué se me fueron los 12.000 Bs del lunes?" y cada gasto en Bs sabe **a qué tasa real** lo pagué: gasto en USD = Bs / tasa de su bolsa. Eso es más honesto que la tasa BCV del día.

### 2.5 Monedas y tasas
- Cada transacción guarda `amount`, `currency`, `amount_usd` (congelado al registrar) y `fx_rate` + `fx_source` (`bolsa`, `p2p_avg`, `bcv`, `manual`).
- Tabla `fx_rates(date, source, ves_per_usd)`: el BCV se scrapea una vez al día y el promedio P2P sale de mis propias órdenes. Tasa de mercado opcional: el endpoint público de anuncios P2P.
- El panel deja ver todo en USD o en VES.

### 2.6 Esquema (ver api/prisma/schema.prisma)
```sql
accounts(id, code, name, currency, kind, opening_balance, opening_at,
         last_reconciled_balance, last_reconciled_at)

raw_events(id, source, external_id, payload jsonb, occurred_at, ingested_at,
           UNIQUE(source, external_id))          -- idempotencia de los syncs

transactions(id, type, status,                    -- status: pending | confirmed | void
             occurred_at, amount, currency, amount_usd, fx_rate, fx_source,
             from_account_id, to_account_id,       -- transfer usa ambos
             category_id, merchant, note,
             justified boolean, justification,      -- "¿por qué?" (opcional, lo pediste)
             source,                                -- manual_text | manual_voice | p2p | pay | card_delta | reconcile
             raw_event_id, bag_id, confidence, created_at, updated_at)

transaction_versions(id, transaction_id, snapshot jsonb, reason, created_at)   -- editar/deshacer

bags(id, p2p_transaction_id, account_id, amount_ves, remaining_ves, rate, opened_at, closed_at)
bag_allocations(bag_id, transaction_id, amount_ves)

categories(id, name, parent_id, emoji, budget_monthly_usd)
merchant_rules(pattern, category_id, hits)          -- lo que aprende de mis correcciones

funding_snapshots(id, taken_at, balances jsonb)
fx_rates(date, source, ves_per_usd, PRIMARY KEY(date, source))

pending_prompts(id, kind, ref_id, payload jsonb, due_at, sent_at, answered_at,
                telegram_message_id, attempts)      -- motor de nudges

chat_turns(id, role, text, tx_ids int[], created_at)  -- solo para contexto corto
embeddings(id, owner_type, owner_id, content, embedding vector(384|768), created_at)
```
Nota: `embeddings` es una sola tabla polimórfica, así no hay columnas `vector` repartidas.

---

## 3. IA: qué hace y con qué contexto

### 3.1 Pipeline de un mensaje
```
voz (.ogg) ──► transcribir ──┐
texto ───────────────────────┴─► INTENT + EXTRACCIÓN (1 llamada, JSON estricto)
                                   │
          ┌────────────┬───────────┼─────────────┬───────────────┐
      add_expense   edit/undo   answer_prompt   ask_question   set_balance
          │            │           │               │               │
    borrador +     aplica a     resuelve el    herramientas    conciliación
    botones        último tx    nudge          de consulta
```
Una sola llamada al LLM devuelve:
```json
{"intent":"add_expense",
 "items":[{"amount":350,"currency":"VES","account":"mercantil","merchant":"panadería",
           "category":"comida/panadería","occurred_at":"2026-09-22T08:30","note":null}],
 "confidence":0.86, "needs":[]}
```
- Si falta algo (`needs:["account"]`), **pregunta con botones**, no con texto libre: `[Mercantil] [BDV] [Efectivo] [Binance]`.
- Un mismo mensaje puede traer varios gastos ("gasté 350 en pan y 1200 en gasolina").
- El modelo de parseo es barato y rápido (`gemini-2.5-flash` / `gemini-3.1-flash-lite`). El de preguntas y resúmenes es mejor (`claude-sonnet-5` o `gemini-3.1-pro`). Cada uno se configura con su variable de entorno, como en clayground.
- Clasificación: primero `merchant_rules` (gratis y determinista), si no hay regla, el LLM con la lista de categorías en el prompt. Cuando corrijo una categoría se crea o refuerza una regla.

### 3.2 Contexto: corto y a propósito (lo que pediste)
No se manda el historial del chat. Cada llamada lleva:
1. Fecha y hora actuales (America/Caracas), cuentas con su saldo estimado y las categorías.
2. **Últimos 4–6 turnos** de `chat_turns` (para "no, eran 500").
3. **Últimos 5 tx** que creé o toqué, con IDs, para resolver "el último", "el de la gasolina" o "borra eso".
4. El **prompt pendiente** si lo que escribo parece responder un nudge.
5. Solo en `ask_question`: lo que devuelven las herramientas y, si hace falta, los top-k de pgvector.

Los `chat_turns` de más de 7 días se pueden borrar: la verdad está en `transactions`.

### 3.3 Preguntas en lenguaje natural: **herramientas, no SQL libre**
"¿Cuánto gasté esta semana?", "¿en qué gasté el martes?" o "¿comida vs. mes pasado?" se resuelven con **tool-calling** sobre un puñado de funciones tipadas:
```
spend_summary(from, to, group_by: category|account|merchant|day, currency)
list_transactions(from, to, category?, account?, merchant?, min?, max?, text?)
compare_periods(a_from, a_to, b_from, b_to, group_by)
bag_status(bag_id? | open_only)
balances(as_of?)
semantic_search(query, k)          -- pgvector
```
Así las cifras son exactas (las calcula SQL, no el LLM) y seguras. Fallback solo si hace falta: text-to-SQL contra **vistas** con un rol Postgres de solo lectura y `statement_timeout`.

### 3.4 pgvector: dónde sí aporta
Aporta en búsqueda difusa: "el almuerzo con María", "lo que pagué del carro", "eso raro de Binance Pay en agosto". Se vectoriza `merchant + categoría + nota + justificación + fecha legible` de cada transacción, y también los resúmenes semanales generados. **No** sirve para sumar: sumar lo hace SQL (3.3). Índice HNSW desde el principio, que con miles de filas cuesta nada.

---

## 4. El bot: conversación, botones y nudges

### 4.1 Registrar un gasto
```
Yo:   gasté 350 en la panadería
Bot:  🥖 Panadería · 350 Bs (≈ $6,00 · tasa 58,3 de tu cambio del lunes)
      Cuenta: Mercantil   Categoría: Comida › Panadería
      [✅ Ok] [✏️ Editar] [🏦 Cuenta] [🏷️ Categoría] [❌ Cancelar]
```
- Si la confianza pasa de 0,9 y hay regla del comercio: se registra solo y queda `[↩️ Deshacer]` 2 minutos.
- ✏️ Editar abre el mismo mensaje en modo edición, con botones por campo; para el monto se escribe el número.

### 4.2 Corregir y deshacer
- Cada confirmación trae `[↩️ Deshacer]`.
- `/ultimos` lista los últimos 10 y cada uno tiene `[✏️] [🗑️]`.
- En lenguaje natural: "no, eran 500", "cámbialo a BDV" o "borra el de la gasolina" se resuelven con el contexto de 3.2 (punto 3).
- Cada cambio guarda un snapshot en `transaction_versions`, así que `/deshacer` puede ir varios pasos atrás.
- Nada se borra de verdad: `status = void`.

### 4.3 Nudges tras un P2P (lo inteligente)
Cuando detecto un P2P SELL completado (sync cada 2–5 min):
1. **Enseguida**: `💱 Cambiaste 200 USDT → 11.660 Bs a Mercantil (58,3). ¿Es para algo concreto?` `[Gastos del día] [Pagar algo puntual…] [Solo ahorro en Bs] [Pasarlo a BDV]`
2. **Mediodía / tarde / noche** (horas configurables, p. ej. 13:30 y 20:30), solo si la bolsa sigue con saldo sin explicar:
   `Del cambio de esta mañana quedan ~11.660 Bs sin movimientos registrados. ¿Gastaste algo?`
   `[Sí, registrar] [Nada todavía] [Ya lo gasté todo en…] [Recordar mañana]`
3. **Al día siguiente**, si sigue abierta: una conciliación.
   `Mercantil debería tener ~9.300 Bs. ¿Es así?` `[✅ Sí] [No, tengo…]` → si digo 7.800, la diferencia de 1.500 queda como gasto pendiente de justificar: `[Comida] [Transporte] [No sé] [Otro…]`

Reglas del motor, para que no fastidie:
- Máximo N nudges al día, silencio nocturno configurable, y se agrupan: si hay 3 bolsas abiertas va un solo mensaje.
- Si ya registré gastos contra la bolsa, el tono cambia: "Registraste 2 gastos (3.200 Bs). ¿Algo más?"
- `[Recordar mañana]` y `[No preguntes por este]` existen.
- Todo nudge es una fila en `pending_prompts`, así que sobrevive a reinicios y se puede responder tarde.

### 4.4 Otros nudges
- Consumo de tarjeta detectado: `💳 Salieron 23,40 USDT del Funding a las 14:02, probablemente tarjeta. ¿Dónde fue?` y botones con los comercios frecuentes.
- Binance Pay enviado a una persona: `[Gasto] [Le presté] [Es mío (otra cuenta)]`
- **Resumen diario** opcional a las 21:00: total del día, top 3, cosas por justificar.
- **Resumen semanal** los domingos: comparación, anomalías ("gastaste 2,3× más en delivery"), y va a `embeddings`.

### 4.5 Comandos
`/saldo` `/hoy` `/semana` `/mes` `/ultimos` `/deshacer` `/pendientes` `/conciliar` `/panel` (abre la Mini App) `/ajustes`. Todo lo demás, en lenguaje natural.

### 4.6 Voz
Una nota de voz se transcribe y sigue el mismo pipeline. El bot muestra la transcripción en una línea gris (`🎙️ "gasté trescientos cincuenta en pan"`) para ver si entendió mal.

### 4.7 Foto
Una foto de factura o de captura del banco va a un modelo de visión (`gemini` vía omniroute): de una factura saca el gasto, de una captura del banco saca el saldo y concilia. Es barata de añadir porque omniroute ya maneja visión.

---

## 5. Panel (móvil primero, Mini App + PWA)

Navegación inferior de 5 tabs y todo pensado para una mano:

1. **Inicio**: patrimonio total en USD (Binance + bancos estimados), gastado hoy / semana / mes contra el mes pasado, tasa P2P y BCV, un chip de "⚠️ 4 por justificar" y el sparkline de 30 días.
2. **Movimientos**: timeline infinito agrupado por día, filtros (cuenta, categoría, tipo, rango, texto), swipe para editar o anular y badge si viene de voz, P2P, tarjeta, etc.
3. **Análisis**: barras apiladas por categoría y semana, top comercios, heatmap día×hora, gasto por cuenta, "mis bolsas" (cada cambio P2P y en qué se fue), evolución de mi tasa P2P contra el BCV y comisiones pagadas.
4. **Cuentas**: saldo de cada una con la marca "sincronizado" o "estimado · conciliado hace 2 d", y botón de conciliar.
5. **Preguntar**: caja de chat sobre los datos (mismo backend que 3.3) que puede devolver una mini tabla o gráfica.

Detalles:
- Auth: dentro de Telegram, `initData` HMAC y allowlist de mi user id. Fuera, magic link por el bot ("/panel" genera un enlace firmado de 10 min que crea una cookie de sesión).
- Moneda conmutable USD/VES en toda la app. Modo oscuro por `prefers-color-scheme` y `Telegram.WebApp.themeParams`.
- Presupuestos por categoría (barra de progreso). Fase 4.

---

## 6. Sincronización con Binance

| Job | Frecuencia | Qué hace |
|---|---|---|
| `sync:p2p` | 2 min | Pide las órdenes de las últimas 48 h y hace upsert en `raw_events`. Con cada `COMPLETED` nuevo crea el transfer, la bolsa y el nudge. También registra las que cambian de estado. |
| `sync:pay` | 5 min | Igual con `/sapi/v1/pay/transactions`. |
| `snapshot:funding` | 5 min | `get-funding-asset`, compara con el snapshot anterior y **descuenta los movimientos conocidos** (P2P, Pay, transferencias internas vía `/sapi/v1/asset/transfer`, retiros/depósitos). Si la diferencia negativa no explicada supera un umbral, crea un tx candidato de tarjeta. |
| `snapshot:spot` | 1 h | Para el patrimonio y el panel. |
| `fx:bcv` | diario | Scrape del BCV. |
| `backfill` | manual, una vez | P2P de 6 meses en ventanas de 30 días y Pay de 18 meses en ventanas de 90 días. Todo entra como `confirmed` sin nudges; lo que sea ambiguo queda en `pending` para revisarlo por lotes desde el panel. |

Detalles importantes:
- Idempotencia con `UNIQUE(source, external_id)`, así que se puede resincronizar sin miedo.
- Respetar `X-MBX-USED-WEIGHT` y usar `recvWindow` de 10 s. Sincronizar el reloj con `/api/v3/time` si da error -1021.
- El match de `payMethodName` → cuenta es una tabla configurable (`"Mercantil"`, `"BancoMercantil"`, `"Banco de Venezuela"`, `"PagoMovil"`…). Si viene `PagoMovil` genérico se pregunta una vez de qué banco fue, y se puede recordar por contraparte.
- **Riesgo real** con la tarjeta: la inferencia por diferencia de saldo falla si coinciden varios movimientos en la misma ventana. Mitigación: ventana corta (5 min), mostrarlo siempre como "probable" y, a futuro, el parser de correos.

---

## 7. Seguridad (no negociable)

- API key de Binance **solo lectura** (nada de trading ni retiros) y **restringida a la IP del servidor**.
- Secretos en `.env` fuera del repo. Si el VPS se comparte, cifrar la key en reposo con una master key del entorno.
- Bot: se ignora cualquier `from.id` que no sea el mío (allowlist). Webhook con `secret_token` de Telegram.
- Panel: validar `initData` de Telegram (HMAC con el bot token) o la sesión del magic link. Todo detrás de HTTPS (Caddy/Coolify).
- Solo mandar al LLM lo mínimo: nunca keys ni payloads crudos de Binance con IDs de contraparte.
- Backups: `pg_dump` diario a un volumen o S3, lo que ya use Coolify.

---

## 8. Despliegue

```yaml
# docker-compose.yml (esqueleto)
services:
  db:
    image: pgvector/pgvector:pg17
    volumes: [pgdata:/var/lib/postgresql/data]
    environment: { POSTGRES_DB: plata, POSTGRES_PASSWORD: ${DB_PASSWORD} }
  api:
    build: ./api
    env_file: .env          # DATABASE_URL, BINANCE_KEY/SECRET, TG_TOKEN, TG_ALLOWED_ID, OMNI_*, TZ=America/Caracas
    depends_on: [db]
  web:
    build: ./web            # vite build → nginx
  # whisper:                # solo si omniroute no pasa audio
  #   image: fedirz/faster-whisper-server:latest-cpu
volumes: { pgdata: {} }
```
Un repo y tres imágenes; en Coolify cada una es su propio recurso o se usa el compose entero. Las migraciones de Prisma corren al arrancar `api`.

---

## 9. Fases

### Fase 0 — Spikes (1–2 días)
- [ ] API key de solo lectura, script que imprima mis últimos P2P, Pay y el Funding. **Anotar los valores reales de `payMethodName`.**
- [ ] Probar un consumo real con la tarjeta y ver cómo se refleja en `get-funding-asset` (¿baja al instante?, ¿aparece en algún otro endpoint, como el asset ledger?).
- [ ] Omniroute: ¿deja pasar audio (`input_audio`) a gemini? ¿Configuro la key de embeddings de Gemini o uso transformers.js local?
- [ ] Crear el bot con BotFather y probar una Mini App vacía.

### Fase 1 — Núcleo manual (MVP usable)
- [ ] Repo, compose, Postgres + pgvector, esquema Prisma, cuentas y saldos iniciales declarados.
- [ ] Bot: gasto por texto → borrador con botones → confirmar. Deshacer, `/ultimos`, editar.
- [ ] Clasificación LLM + `merchant_rules`.
- [ ] `/hoy`, `/semana`, `/saldo`.
- **Hecho cuando**: registro una semana de gastos solo por chat sin tocar el código.

### Fase 2 — Binance
- [ ] Syncs de P2P y Pay, transfers automáticos, bolsas y tasas.
- [ ] Snapshots del Funding → candidatos de tarjeta.
- [ ] Motor de nudges (`pending_prompts`) con los flujos de 4.3 y 4.4, silencio nocturno y agrupación.
- [ ] Conciliación de bancos.
- [ ] Backfill.
- **Hecho cuando**: hago un P2P y, sin escribir nada, el bot me lleva hasta tener la bolsa explicada.

### Fase 3 — Voz, preguntas y vectores
- [ ] Notas de voz.
- [ ] Tool-calling para preguntas (3.3).
- [ ] Embeddings + `semantic_search`.
- [ ] Fotos de facturas y capturas del banco.

### Fase 4 — Panel
- [ ] Vite React Mini App + PWA: las 5 tabs de la sección 5.
- [ ] Auth por initData y magic link.
- [ ] Resúmenes diario y semanal, presupuestos.

### Fase 5 — Extras (solo si hacen falta)
- Parser de correos de la tarjeta, reenvío de SMS del banco, préstamos y deudas ("le presté a X"), gastos recurrentes detectados, exportar CSV, multi-moneda más allá de USD/VES.

---

## 10. Preguntas abiertas (necesito tus respuestas)
1. ¿**Telegram** está bien? Todo el plan asume Telegram por los botones, la Mini App y porque puede escribirte primero gratis.
2. ¿Qué nombre exacto sale en `payMethodName` para Mercantil y BDV? (lo sacamos en la Fase 0)
3. ¿Usas **efectivo** (USD/Bs) lo suficiente como para que sea una cuenta?
4. ¿"Justificar" es obligatorio para todo gasto o solo para los que pasan de un monto o son de ciertas categorías? Propuesta: solo por encima de $X o si la categoría es "otros".
5. ¿Tasa de referencia para reportar en USD: la de tu bolsa (propuesta), el BCV o el promedio P2P?
6. ¿Dónde se despliega? ¿El mismo Coolify de omniroute y clay-supabase?
7. Horas de los nudges y horario de silencio.

---

## Referencias
- Binance C2C trade history: https://developers.binance.com/docs/c2c/rest-api/Get-C2C-Trade-History
- Binance Pay trade history: https://developers.binance.com/docs/pay/rest-api/Get-Pay-Trade-History
- Funding wallet (incluye saldo de la Card): `POST /sapi/v1/asset/get-funding-asset` (Wallet API)
- grammY (bot) y plugins conversations/menu: https://grammy.dev
- Telegram Mini Apps (initData): https://core.telegram.org/bots/webapps
- pgvector: https://github.com/pgvector/pgvector
- Omniroute en uso: `../clayground/server.mjs` (patrón `stream:false` + `unfence` del JSON)
