# Архитектура мониторинга DevGhost (Production-Grade)

## 1. Текущее состояние

### Что уже есть

| Компонент | Реализация | Ограничения |
|-----------|------------|-------------|
| **Логирование** | Pino → console + `.logs/server-*.log` (pino-roll, 14 дней) | На Vercel нет персистентной ФС — файлы не сохраняются |
| **Admin Monitoring** | `/api/admin/monitoring` + UI | Cache/clone stats не работают на Vercel (нет локальных директорий) |
| **Watchdog** | Vercel Cron каждые 5 мин | Reaper, retry, post-processing recovery |
| **Audit Log** | `AuditLog` в БД, fire-and-forget | Только бизнес-события, не технические ошибки |
| **Ollama health** | `checkOllamaHealth()` в pipeline-bridge | Только для локальной разработки |

### Инфраструктура

- **Vercel** — Next.js API routes, serverless, эфемерная среда
- **Modal** — Python worker для LLM-анализа (clone, extract, LLM calls)
- **Supabase** — PostgreSQL (pooled + direct)
- **Stripe** — billing webhooks

### Критические пробелы

1. **Нет клиентского мониторинга** — React errors, unhandled rejections, Core Web Vitals, SSE-обрывы
2. **Нет централизованных логов** — Vercel logs + Modal logs разрознены
3. **Нет трейсинга** — нельзя связать запрос → job → Modal call
4. **Нет метрик** — latency, error rate, throughput
5. **Нет алертинга** — сбои не эскалируются
6. **Нет health checks** — load balancer / uptime monitoring не могут проверить доступность
7. **Admin monitoring частично неработоспособен** на Vercel (cache/clone dirs)

---

## 2. Целевая архитектура

### 2.1. Общая схема

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INSTRUMENTATION LAYER                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Next.js (Vercel)          │  Modal Worker (Python)    │  Cron / Webhooks   │
│  - OpenTelemetry SDK       │  - structlog / JSON       │  - Same as above   │
│  - Pino → stdout (JSON)    │  - stdout → log drain     │                    │
│  - Sentry (client+server)  │                          │                    │
└──────────────┬─────────────┴──────────────┬────────────┴──────────┬─────────┘
               │                            │                      │
               ▼                            ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LOGGING & OBSERVABILITY PLATFORM                          │
│  (выбор: Axiom / Better Stack / Datadog / Grafana Cloud / self-hosted)       │
│  - Log aggregation                                                           │
│  - Metrics (Prometheus-compatible или native)                                 │
│  - Traces (OpenTelemetry)                                                    │
│  - Alerts                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ALERTING & DASHBOARDS                                 │
│  - Slack / PagerDuty / Email                                                 │
│  - Grafana / Axiom / Better Stack UI                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Компоненты решения

### 3.1. Health Checks (обязательный минимум)

**Цель:** Load balancer, uptime monitoring (UptimeRobot, Better Uptime), k8s probes.

| Endpoint | Назначение | Проверки |
|----------|------------|----------|
| `GET /api/health` | Liveness | App отвечает |
| `GET /api/health/ready` | Readiness | DB connect |

**Безопасность (P1):** Публичный endpoint не должен раскрывать внутреннюю топологию. Варианты:

- **Bearer-токен:** `Authorization: Bearer <HEALTH_CHECK_SECRET>` — UptimeRobot/Better Uptime поддерживают custom headers. При неверном токене — 401.
- **Минимальный ответ при ошибке:** При 503 возвращать только `{ ok: false }` без `db: 'error'`. Детали писать в лог: `logger.error({ err }, 'Health check failed')`.

**Реализация:**

```typescript
// GET /api/health — публичный, без зависимостей
export async function GET() {
  return Response.json({ ok: true, ts: new Date().toISOString() });
}

// GET /api/health/ready — проверка DB, опционально защищён
const HEALTH_SECRET = process.env.HEALTH_CHECK_SECRET;
export async function GET(request: NextRequest) {
  if (HEALTH_SECRET) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${HEALTH_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Health check failed');
    return Response.json({ ok: false }, { status: 503 }); // без деталей
  }
}
```

**Рекомендация:** Не включать в ready проверки GitHub/Stripe/OpenRouter — они могут быть временно недоступны, но приложение должно оставаться «ready» для чтения данных.

---

### 3.2. Централизованное логирование

**Проблема:** Pino пишет в файл — на Vercel файловая система эфемерна. Логи нужно отправлять во внешний сервис.

**Варианты:**

| Вариант | Плюсы | Минусы |
|---------|-------|--------|
| **Vercel Log Drains** | Встроено, минимальные изменения | Платный (Pro+), формат ограничен |
| **pino → stdout + Log Drain** | Логи уже в JSON, drain пересылает | Нужен drain-сервис (Axiom, Better Stack) |
| **Axiom / Better Stack** | Готовые drains для Vercel, поиск, retention | Стоимость |
| **Grafana Loki** | Self-hosted, дешёво | Нужна инфраструктура |

**Рекомендация для MVP:** Axiom или Better Stack (Logtail) — бесплатный tier, Vercel integration, быстрый старт.

**Изменения в logger.ts (автодетект среды):**

Текущий `logger.ts` использует `NODE_ENV !== 'production'` и всегда добавляет file transport при наличии `.logs/`. На Vercel `fs.mkdirSync(LOG_DIR)` может молча отработать (в `/tmp` или read-only), но файлы не персистятся. Явный автодетект надёжнее:

```typescript
const isDev = process.env.NODE_ENV !== 'production';
const isVercel = !!process.env.VERCEL;  // Vercel sets this automatically
const enableFileTransport = !isVercel;  // file только когда не Vercel (local dev или self-hosted)
```

- **File transport:** только когда `!isVercel` (и опционально `LOG_DIR` существует). Ключевой механизм — `VERCEL` env (Vercel устанавливает автоматически), дублировать через `NODE_ENV` для локального production build.
- В production (Vercel): только stdout (JSON). Vercel Log Drains перехватывают stdout.
- Добавить `LOG_DRAIN_URL` или использовать Vercel Log Drains (настраиваются в dashboard).

**Modal:** Python worker — добавить structlog с JSON output в stdout. Modal по умолчанию собирает stdout; можно настроить log forwarding в Axiom/Better Stack через их API или webhook.

---

### 3.3. Distributed Tracing (OpenTelemetry)

**Цель:** Связать HTTP request → Order → AnalysisJob → Modal call → LLM requests.

**Концепция:**

- Trace ID передаётся: Next.js API → `processAnalysisJob` → Modal webhook (в body, т.к. webhook принимает JSON)
- Modal worker парсит `traceparent` из payload, создаёт child span
- При retry (watchdog re-trigger) — тот же `job_id` может породить новый trace; для идемпотентности сохранять `trace_id` в `AnalysisJob` при первом trigger и передавать при retry

**Реализация (детали):**

1. **Next.js:** `@opentelemetry/api` + `@opentelemetry/sdk-node`, instrumentation для Prisma, fetch.

2. **Payload в Modal webhook** (текущий формат `{ job_id, auth_token }` расширить):
   ```json
   { "job_id": "...", "auth_token": "...", "traceparent": "00-<trace_id>-<span_id>-01" }
   ```
   `traceparent` — W3C Trace Context format. Добавлять в `triggerModal()` в `pipeline-bridge.ts` и в cron watchdog при retry.

3. **Modal Python worker** (`worker.py` / `app.py`):
   - При получении request извлечь `traceparent` из body
   - `opentelemetry.propagate.extract` с `TraceContextTextMapPropagator`
   - Создать span как child: `with tracer.start_as_current_span("run_analysis", parent=...)`
   - При retry — если `traceparent` передан, использовать его; иначе создать новый root span

4. **Идемпотентность:** Modal webhook может быть вызван повторно (watchdog retry). Trace context в payload — часть входных данных; при повторном вызове передаём тот же или новый context (предпочтительно новый span в том же trace, если trace_id сохранён в БД).

**Приоритет:** Средний. Полезно для отладки долгих анализов, но не блокер для первого релиза.

---

### 3.4. Метрики (Metrics)

**Что измерять:**

| Метрика | Тип | Источник | Алерт |
|---------|-----|----------|-------|
| `http_requests_total` | Counter | Next.js middleware / instrumentation | — |
| `http_request_duration_seconds` | Histogram | То же | p99 > 30s |
| `analysis_job_duration_seconds` | Histogram | analysis-worker | — |
| `analysis_jobs_failed_total` | Counter | AnalysisJob status=FAILED_* | rate > 0 |
| `modal_trigger_failures_total` | Counter | watchdog / analyze route | > 0 |
| `stripe_webhook_errors_total` | Counter | billing webhook | > 0 |
| `db_connection_errors_total` | Counter | Prisma | > 0 |
| `db_query_duration_seconds` | Histogram | Критические операции | p99 > 10s |

**Мониторинг БД (Supabase/PgBouncer) (P1):**

Supabase pooler (PgBouncer) — частый источник проблем:
- Исчерпание пула соединений при пиковой нагрузке
- Медленные запросы блокируют пул
- Supabase Dashboard — явно настроить алерты на connection pool usage, slow queries

Рекомендация: логировать `db_query_duration_seconds` хотя бы для критических операций:
- `processAnalysisJob` (clone + LLM loop)
- `ghost-metrics-service.calculateAndSave`
- Post-processing в watchdog
- Stripe webhook handlers

Через Prisma middleware или ручной `Date.now()` до/после. При наличии OpenTelemetry — `@prisma/instrumentation`.

**Реализация:**

- **Prometheus:** Экспорт `/api/metrics` (Prometheus scrape) — на Vercel serverless неудобно (короткие инстансы)
- **Push-based:** OpenTelemetry Metrics → OTLP → Axiom/Grafana Cloud
- **Better Stack / Axiom:** События из логов (парсинг `"level":"error"`) как метрики

**Рекомендация:** Начать с событий из логов + ручные счётчики в критических местах. Полноценный Prometheus — при переходе на long-running workers (если будет отдельный Node process).

---

### 3.5. Алертинг

**Каналы:** Slack, Email, PagerDuty (по критичности).

**Правила (примеры):**

| Условие | Severity | Канал |
|---------|----------|-------|
| `AnalysisJob` FAILED_FATAL | High | Slack + Email |
| Watchdog обработал > 5 stale jobs за run | Medium | Slack |
| Stripe webhook 5xx | High | Slack + Email |
| DB connection errors > 3 за 5 мин | Critical | PagerDuty |
| `/api/health/ready` 503 | Critical | PagerDuty |
| Modal trigger 4xx/5xx | High | Slack |

**Политика эскалации (P0):** Без дедупликации и throttling алерты быстро начинают игнорироваться.

| Механизм | Описание |
|----------|----------|
| **Дедупликация** | Один FAILED_FATAL job = одно оповещение. Не слать повторно при каждом watchdog run, если job уже был заалерчен. Реализация: alert rule с группировкой по `job_id` или окном "не чаще 1 раза в 1 час на один job_id". |
| **Throttling** | Максимум N алертов одного типа в час (например, 5). При массовом сбое — один summary alert вместо 50 отдельных. |
| **Runbook-ссылки** | Каждый alert должен содержать ссылку на runbook: "При FAILED_FATAL: 1) Открыть Admin → Monitoring, 2) Найти job, 3) Проверить error message, 4) При необходимости — rerun через Admin". Хранить в Confluence/Notion или в описании alert rule. |

**Реализация:** Через UI платформы (Axiom, Better Stack, Datadog) — alert rules с настройкой group_by, throttle, и аннотациями runbook.

---

### 3.6. Улучшение Admin Monitoring

**Проблема:** `dirSize`, `cloneStats` на Vercel не работают — нет `CLONE_BASE_PATH`, `PIPELINE_CACHE_DIR` в serverless.

**Решение:**

1. **Cache/Clone stats** — показывать только когда `process.env.PIPELINE_MODE === 'local'` или когда директории существуют. Иначе — "N/A (Modal mode)".
2. **Добавить в monitoring API:**
   - Статус Modal: последний успешный heartbeat, количество RUNNING jobs
   - Статус cron: последний успешный run watchdog (через таблицу или env)
   - Stripe: последний webhook event (опционально)
3. **Отдельный endpoint** `GET /api/admin/monitoring/jobs` с фильтрами (status, date range) для детального разбора.

---

### 3.7. Audit vs Error Log — разделение доменов

**AuditLog** — бизнес-аудит: кто что сделал (auth, admin actions, promo, credits). Retention — долгий, объём умеренный.

**ErrorLog** — технические ошибки. Разные retention policies, разные потребители, объём может быть высоким.

**Рекомендация:** Не писать `system.error` в AuditLog. Смешение доменов усложняет retention и запросы. При наличии Axiom/Better Stack отдельная таблица `ErrorLog` в БД избыточна — внешняя платформа лучше справляется с поиском, агрегацией и алертами.

Если нужен fallback в Admin UI без доступа к внешним логам — отдельная таблица `ErrorLog` с коротким retention (например, 7 дней), ограниченным набором полей (timestamp, jobId, error, action). Не смешивать с AuditLog.

---

### 3.8. Клиентский мониторинг (P0)

Документ ранее фокусировался на бэкенде. Для production необходим мониторинг фронтенда.

| Компонент | Реализация | Назначение |
|-----------|------------|------------|
| **Error tracking** | Sentry (бесплатный tier) | React errors, unhandled rejections, boundary catches |
| **Core Web Vitals** | Next.js `reportWebVitals` | LCP, FID, CLS — отправка в Sentry или Google Analytics |
| **SSE-соединения** | `/api/orders/[id]/progress` | Специфичная точка отказа: обрывы, таймауты. Логировать disconnect/reconnect на клиенте, при ошибке — Sentry.captureException |

**Sentry для Next.js:**
- `@sentry/nextjs` — из коробки поддерживает App Router, API routes, middleware
- Инициализация в `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`
- Source maps для production (Vercel автоматически загружает в Sentry)

**SSE:** При `EventSource.onerror` или неожиданном close — отправлять в Sentry с контекстом (orderId, jobId, lastEventId). Помогает выявлять проблемы с long-polling при холодных стартах или таймаутах Vercel.

**Рекомендация:** Добавить Sentry в Фазу 1 наравне с health checks.
---

## 4. План внедрения (поэтапно)

### Фаза 1: Минимум для production (2–3 дня с тестами)

1. **Health checks:** `GET /api/health`, `GET /api/health/ready` (с защитой/минимальным ответом)
2. **Logger:** Автодетект `VERCEL` env, отключить file transport на Vercel
3. **Admin monitoring:** Условный показ cache/clone (только для local mode)
4. **Клиентский мониторинг:** Sentry (Next.js SDK)
5. **Uptime monitoring:** Настроить UptimeRobot/Better Uptime на `/api/health` (каждые 5 мин)
6. **Тесты:** Unit/integration на health endpoints

### Фаза 2: Логи и алерты (3–5 дней)

1. **Log drain:** Подключить Axiom или Better Stack к Vercel
2. **Modal:** structlog JSON в stdout, убедиться что логи попадают в drain
3. **Alert rules:** FAILED_FATAL, Stripe errors, health 503 → Slack/Email
4. **Политика эскалации:** Дедупликация, throttling, runbook-ссылки

### Фаза 3: Метрики и трейсинг (по необходимости)

1. OpenTelemetry SDK в Next.js
2. Метрики через OTLP или события из логов
3. Distributed tracing (trace_id в job, Modal)
4. Мониторинг Supabase (connection pool, slow queries)

---

## 5. Рекомендуемый стек (конкретные продукты)

| Задача | Рекомендация | Альтернативы |
|--------|--------------|---------------|
| Logs | **Axiom** или **Better Stack** | Datadog, Grafana Loki |
| Error tracking (client) | **Sentry** | Rollbar, Bugsnag |
| Uptime | **Better Uptime** или UptimeRobot | Pingdom, StatusCake |
| Alerts | Встроено в Axiom/Better Stack | PagerDuty |
| Metrics | Axiom/Better Stack (из логов) | Grafana Cloud, Datadog |
| Tracing | Axiom (поддерживает OTLP) | Jaeger, Tempo |

**Почему Axiom / Better Stack:** Единая платформа для логов + метрик + алертов, хорошая интеграция с Vercel, бесплатный tier для старта.

**Оценка объёмов и стоимости (P2):** При активном анализе объём логов растёт быстро: каждый job — десятки LLM-запросов → десятки log entries; watchdog каждые 5 мин; SSE-стриминг; каждый API request. Грубая оценка: 10 анализов/день × 50 коммитов × 3 log/commit ≈ 1500 entries/day от pipeline + API/cron/webhooks. Итого **50–200 MB/месяц** на старте. Axiom free tier — 500 GB/месяц, Better Stack — 1 GB free. Мониторить usage, настроить sampling/retention при росте.

---

## 6. Чек-лист перед production

**Сервер:**
- [ ] `GET /api/health` и `GET /api/health/ready` реализованы (ready — без утечки деталей при 503)
- [ ] Health endpoints защищены Bearer-токеном или возвращают минимальный ответ
- [ ] Uptime monitor настроен на `/api/health`
- [ ] Logger: автодетект `VERCEL` / `NODE_ENV`, file transport отключён на Vercel
- [ ] Log drain подключён (Vercel → Axiom/Better Stack)
- [ ] Modal логи доступны в той же платформе
- [ ] Алерты с политикой эскалации (дедупликация, throttling, runbook)
- [ ] Admin monitoring не падает на Vercel (cache/clone условно)

**Клиент:**
- [ ] Sentry настроен (Next.js SDK, client + server)
- [ ] Core Web Vitals отправляются (reportWebVitals)
- [ ] SSE-обрывы логируются в Sentry

**Инфраструктура:**
- [ ] Валидация критичных env-переменных при старте (DATABASE_URL, AUTH_SECRET, и т.д.) — fail fast
- [ ] Supabase Dashboard: алерты на connection pool, slow queries
- [ ] Документация: где смотреть логи, как реагировать на алерты

---

## 7. Приоритеты (сводка из ревью)

| Приоритет | Что добавить |
|-----------|--------------|
| **P0** | Клиентский мониторинг (Sentry) |
| **P0** | Политика эскалации алертов (дедупликация, throttling, runbooks) |
| **P1** | Безопасность health endpoints |
| **P1** | Мониторинг Supabase/PgBouncer |
| **P2** | Оценка объёмов логов и стоимости |
| **P2** | Автодетект среды в logger.ts (`VERCEL` env) |
