## 1. Контекст и цели

**Продукт:** DevGhost — платформа аналитики эффективности разработки по Git‑репозиториям с использованием LLM (через OpenRouter) для оценки трудозатрат по каждому коммиту.

**Ключевые требования по бэкенду:**

1. Подключение Git‑репозиториев (GitHub OAuth + публичные репы по ссылке + Explore).
2. Выкачивание и разбор истории коммитов (вплоть до «вся история»).
3. Массовые вызовы LLM (OpenRouter) по каждому диффу.
4. Потенциально долгие задачи (анализ большого репо может занимать десятки минут и более).
5. Постоянное хранение:
    - результатов анализов;
    - метрик и агрегатов;
    - кэша по репозиториям (желательно).
6. Фронтенд — интерактивные дашборды (Next.js) с быстрым откликом.

**Цель документа:**
Показать, почему хостинг всего бэкенда на Vercel (включая тяжелую обработку репозиториев) — архитектурно неверный выбор даже на платных тарифах, и предложить реалистичную архитектуру с использованием бесплатных/минимально платных сервисов на этапе MVP.

***

## 2. Ограничения Vercel как среды выполнения тяжелых задач

### 2.1. Эфемерная среда и файловая система

- Serverless‑функции на Vercel выполняются в контейнерах с **read‑only файловой системой**.
- Единственное место для записи — `/tmp` с лимитом порядка **500 МБ** на инстанс,.[^1][^2]
- Состояние `/tmp`:
    - не сохраняется между инстансами;
    - очищается при холодном старте;
    - не подходит для долговременного кэша репозиториев.

**Следствие:**
Клонировать средние/крупные репозитории (особенно монорепы) и держать их как кэш в serverless‑окружении нельзя. Каждый анализ потребует заново тянуть данные из GitHub → рост задержек и стоимости трафика.

### 2.2. Лимиты по времени выполнения

По текущим докам Vercel Functions,:[^2][^3]

**Стандартные Serverless Functions:**

| План | Default | Max | С Fluid Compute |
|------|---------|-----|-----------------|
| Hobby / Free | 10 с | **60 с** | до 300 с |
| Pro | 15 с | **300 с** (5 мин) | до 800 с |
| Enterprise | 15 с | **900 с** (15 мин) | до 900 с |

> **Fluid Compute** — режим Vercel, объединяющий ресурсы serverless‑функций для увеличения таймаутов и конкурентности. Включается в настройках проекта, но не меняет фундаментальную природу serverless‑окружения.[^43]

**Следствие для DevGhost:**

- Анализ полного репозитория со 1000+ коммитов с вызовом LLM на каждый дифф легко может:
    - занять >15–30 минут;
    - потребовать ретраев по сети к OpenRouter;
    - включать повторное скачивание репо.

Даже при агрессивной батчевости и ограничении периода (например, «последние 500 коммитов»), вы рискуете:

- либо постоянно упираться в таймауты,
- либо сильно урезать возможности продукта ради таймаутов Vercel.


### 2.3. Лимиты по памяти и размеру payload

- RAM на функцию ограничена (2–4 ГБ в зависимости от тарифа).[^2]
- Максимальный размер тела HTTP‑запроса/ответа и body для функций — около **4.5 МБ**.[^4]
- Кэш Next.js `fetch` и подобные механизмы имеют лимит порядка **2 МБ на объект**.[^5]

**Следствие:**

- Нельзя безопасно держать в памяти/кэше большие структуры (полные AST, длинную историю коммитов, агрегаты для огромных репо) в рамках одного вызова.
- Нельзя возвращать с функций большие массивы результатов анализа «одним махом» — нужен pagination/streaming и хранение в БД.


### 2.4. Вывод: роль Vercel в DevGhost

Vercel остаётся идеальной платформой для:

- хостинга фронтенда (Next.js + App Router);
- лёгких API‑ручек (авторизация, чтение из БД, выдача уже готовых результатов, webhooks от GitHub).

Но Vercel **не** должен быть местом, где:

- клонируются репозитории,
- выполняется основной анализ,
- живут долгие фоновые процессы.

***

## 3. Требования к окружению для воркеров DevGhost

С учётом того, что вы **не планируете Ollama на сервере**, а используете только OpenRouter, требования упрощаются:

1. **Постоянный процесс или job‑runner**, способный работать десятки минут и дольше без таймаутов.
2. **Постоянный диск** (не эфемерный):
    - кэш репозиториев (опционально);
    - временные файлы анализа;
    - логи.
3. **Адекватные ресурсы:**
    - CPU: 1–2 vCPU достаточно на MVP;
    - RAM: 2–4 ГБ достаточно при аккуратной обработке (stream‑парсинг, инкрементальная обработка).
4. **Дешёвый или бесплатный трафик:**
    - загрузка репо из GitHub;
    - исходящий HTTP‑трафик к OpenRouter.
5. **Интеграция с БД:**
    - Postgres (Supabase/Neon и т. п.) для сохранения результатов;
    - гарантированно доступная извне.

***

## 4. Обзор подходящих бесплатных/дешёвых вариантов

### 4.1. Oracle Cloud Infrastructure (OCI) — Always Free

**Почему интересно:**

- Always Free Tier: до **4 ARM‑ядер и 24 ГБ RAM суммарно** на Ampere A1,.[^6][^7]
- До **200 ГБ** блочного хранилища и до **10 ТБ исходящего трафика**/месяц на Always Free.[^8]
- ВМ работает 24/7 без таймаутов.

**Плюсы для DevGhost:**

- Можно поднять:
    - один backend‑воркер (Node.js/Python);
    - Redis (как очередь задач) или использовать сам Postgres как «очередь»;
    - файловый кэш репозиториев.
- Без таймаутов: одна задача может крутиться часами, спокойно дожидаясь ответов от OpenRouter.

**Минусы:**

- Жёсткая политика регистрации:
    - нужна карта иностранного банка;
    - есть риск отклонения аккаунта/закрытия без объяснения (репутационные кейсы на Reddit,).[^7][^9]
- **Reclamation policy (критично!):**
    - Oracle считает инстанс idle, если CPU‑утилизация за 7 дней <20% на 95‑м перцентиле.[^44]
    - Idle‑инстансы **автоматически удаляются**. Для воркера DevGhost, который может простаивать между анализами, это реальный риск потери VM.
    - Обходные пути: cron‑задача с искусственной нагрузкой, но это хак.
- **Проблемы с ёмкостью:**
    - В большинстве регионов Ampere A1 невозможно создать — ошибка «Out of Capacity».[^45]
    - Для надёжного создания часто требуется переход на Pay‑As‑You‑Go аккаунт (временный hold $100 на карте).


### ~~4.2. GitHub Actions как «воркерная платформа»~~ — ОТКЛОНЕНО

> **Статус: ОТКЛОНЕНО.** Детальное исследование (февраль 2026) показало, что этот вариант нарушает ToS GitHub и несёт неприемлемые риски. Секция сохранена для истории принятия решения.

**Идея:** использовать GitHub Actions как compute‑платформу для фоновых задач.

**Факты (технические):**

- Раннеры GitHub Actions:
    - 2 vCPU, 7 ГБ RAM, ~14 ГБ диска.
    - Один job может идти до **6 часов**.
- Бесплатно:
    - для **публичных репозиториев** — неограниченно;
    - для приватных — 2000 минут/месяц на free‑аккаунт.[^10]
- Concurrency: 20 parallel jobs (Free), 40 (Pro), 60 (Team).[^10]

**Причины отклонения:**

**1. Прямое нарушение ToS GitHub (3 пункта):**[^53]

> *"The provision of a stand-alone or integrated application or service offering the Actions product or service **for commercial purposes**"*

> *"Don't use Actions **as part of a serverless application**"*

> *"Any activity **unrelated to the production, testing, deployment, or publication of the software project** associated with the repository where GitHub Actions are used."*

Использование workflow_dispatch для триггера анализа чужих репозиториев через LLM — это именно «serverless application for commercial purposes, unrelated to the repository». Санкции: прекращение jobs, отключение репозитория, **блокировка GitHub‑аккаунта**. GitHub активно мониторит и заблокировал 1000+ репо за abuse Actions.[^54]

**2. Ненадёжность для user‑facing нагрузки:**

- Задокументированные задержки очереди **от 30 минут до 3+ часов** на Linux runners.[^55]
- Декабрь 2025: инцидент длительностью **~9 часов** с таймаутами API в Actions.[^56]
- Февраль 2026: major outage, затронувший все hosted‑runner jobs.[^57]
- Для SaaS, где пользователь ждёт результат — неприемлемо.

**3. Критические риски безопасности:**

- Март 2025: компрометация `tj-actions/changed-files` (CVE‑2025‑30066) — **23 000 репозиториев** потеряли секреты (AWS ключи, npm токены, RSA ключи).[^58]
- Сентябрь 2025: кампания GhostAction — 817 репозиториев, **3 325 украденных секретов**.[^59]
- Если DevGhost хранит OpenRouter API key и DATABASE_URL как GitHub Secrets — они уязвимы через supply chain атаки.

**Ценообразование (для справки):**
- С 1 января 2026 GitHub снизил цены runners на ~39%, но ввёл новый сбор **$0.002/мин** за «Actions cloud platform» для self‑hosted runners в приватных репо (с марта 2026).[^46]


### 4.2.1. Альтернативы API‑triggered compute (вместо GitHub Actions)

Исследование выявило платформы, **специально спроектированные** для паттерна «API‑triggered async compute»:

**Modal** (https://modal.com):[^60]

- Serverless Python compute, scale to zero, посекундная тарификация.
- **Free tier: $30/мес** (~3 750 десятиминутных jobs бесплатно).
- Стоимость: ~**$0.008** за 10‑мин job на 1 core + 2 GiB RAM.
- Заточен под LLM/batch workloads. Встроенные очереди (до 1M inputs).
- Ограничение: инфраструктура только в US‑East (Ashburn, VA).

**Google Cloud Run Jobs**:[^61]

- Контейнеры по запросу, triggered через API/Scheduler/Pub‑Sub.
- Стоимость: ~**$0.014** за 10‑мин job на 1 vCPU.
- Полный `git clone` возможен (контейнер с диском).
- 2M free requests/мес.

| | Modal | Cloud Run Jobs | GitHub Actions |
|---|---|---|---|
| ToS | Разрешено | Разрешено | **Запрещено** |
| Надёжность | Высокая | Высокая | Непредсказуемая |
| Cold start | 1–5 с | 5–10 с | 15–45 с + очередь |
| Max duration | 24ч+ | настраивается | 6ч |
| Git clone | Да | Да | Да |
| Free tier | $30/мес | 2M req/мес | 2000 мин/мес |
| Риск аккаунта | Нет | Нет | **Блокировка** |


### 4.3. Fly.io / Koyeb / Railway / Render

Состояние на 2025–2026:

- **Railway**:
    - разовый **кредит $5** (истекает через 30 дней), после trial — Free‑план с **$1/мес** бесплатного кредита,;[^11][^12]
    - минимальный платный план — Hobby $5/мес. Trial ограничен: 1 ГБ RAM, shared vCPU, до 5 сервисов на проект.
- **Fly.io**:
    - формально **без постоянного free‑tier**; есть «free allowance» (3 shared VM, 160 ГБ bandwidth), но требуется кредитная карта,.[^13][^14]
    - С 1 января 2026 — платные volume snapshots.[^47]
- **Koyeb**:
    - free‑tier: **512 МБ RAM, 0.1 vCPU, 2 ГБ SSD**, лимит **1 инстанс** на организацию (только Frankfurt или Washington D.C.),;[^15][^16]
    - этого мало для тяжелого анализа крупных репо (0.1 vCPU — критически мало для парсинга диффов).
- **Render**:
    - есть бесплатный tier для web‑сервисов и БД, но **background workers на free‑tier недоступны**,,.[^17][^18][^19]

**Вывод:**

- Для именно длительных фоновых воркеров free‑tier у этих PaaS либо отсутствует, либо сильно урезан.
- Они хороши как «следующий шаг» после MVP, но не идеальны как бесплатный старт под вашу нагрузку.


### 4.4. Базы данных: Supabase / Neon

- **Supabase Free**:
    - 500 МБ БД, 1 ГБ storage, 50k MAU, безлимит запросов, 5 ГБ egress,.[^20][^21]
    - Этого достаточно для MVP и первых платежеспособных клиентов.
    - **Важно:** free‑проекты **паузятся после 1 недели без API‑запросов** — данные сохраняются, но проект уходит в offline до ручного возобновления. Лимит — 2 активных free‑проекта.[^48]
- **Neon**:
    - 0.5 ГБ storage на проект (до 5 ГБ на 10 проектов), **100 CU‑hours/мес** на free‑tier (удвоено с 50 в октябре 2025).[^22][^23]
    - 1 CU = 1 vCPU + 4 ГБ RAM. Compute масштабируется до нуля при простое (idle timeout 5 мин) — CU‑часы тратятся только при активных запросах.[^49]
    - Тоже хороший вариант, особенно если нравится serverless‑подход.

Обе опции отлично интегрируются с Next.js/Vercel.


### 4.5. Durable Execution Platforms (альтернативный подход)

Вместо выделенного VPS или GitHub Actions можно использовать **платформы durable execution**, которые разбивают длинную задачу на шаги, каждый из которых укладывается в таймаут Vercel:

- **Inngest** (https://inngest.com):
    - Durable workflows с автоматическими ретраями, параллелизмом и throttling.
    - Free‑tier: 50k событий/мес, до 5 concurrent functions.[^50]
    - Интегрируется напрямую с Next.js App Router.
- **Trigger.dev** (https://trigger.dev):
    - Open‑source фоновые задачи для Next.js/Node.js.
    - Free‑tier: 50k runs/мес.[^51]
    - Поддерживает длительные задачи через step‑функции.
- **Upstash Workflow**:
    - Serverless‑оркестрация поверх Vercel без таймаутов.
    - Основан на Upstash QStash; free‑tier: 500k сообщений/мес.[^52]

**Применимость для DevGhost:**

Анализ репозитория можно разбить на шаги:
1. Получить список коммитов (один вызов).
2. Для каждого коммита — отправить дифф в OpenRouter (батчами).
3. Агрегировать результаты и записать метрики.

Каждый шаг укладывается в 60–300 с таймаут Vercel. Платформа гарантирует exactly‑once выполнение и ретраи.

**Плюсы:**
- Не нужен отдельный сервер / VM.
- Весь код остаётся в Next.js‑проекте.
- Встроенный мониторинг и retry‑логика.

**Минусы:**
- Нет доступа к файловой системе — `git clone` невозможен; нужно работать через GitHub API (получать диффы по API).
- Vendor lock‑in на конкретную платформу.
- Free‑tier может быть недостаточен при большом объёме коммитов.

***

## 5. Рекомендуемая архитектура DevGhost (MVP)

### 5.1. Общая схема

**Фронтенд + легкий API:**

- **Vercel + Next.js (App Router)**.
- Роли:
    - UI дашбордов.
    - Авторизация (GitHub OAuth).
    - CRUD по настройкам анализов, пользователям, тарифам.
    - Чтение результатов из БД.

**База данных:**

- **Supabase** (или Neon) как Postgres:
    - таблицы `repositories`, `analysis_jobs`, `commits`, `developers`, `metrics_*` и т. д.
    - хранение токенов/линков GitHub (шифрование).
    - REST/GraphQL/Edge Functions при необходимости.

**Фоновые воркеры (варианты):**

1. **Вариант А (при наличии зарубежной карты):**
    - OCI Always Free: одна VM (Ampere A1 2–4 vCPU, 8–16 ГБ RAM).
    - На ней:
        - Docker или просто systemd‑сервисы:
            - воркер DevGhost (Node.js/Python);
            - очередь (Redis или просто таблица `jobs` в Postgres).
    - Воркер:
        - периодически опрашивает БД на наличие задач;
        - клонирует репо (с диском 50–100 ГБ для кэша);
        - стримово обрабатывает историю коммитов;
        - делает запросы к OpenRouter (LLM);
        - пишет результаты в БД.
2. ~~**Вариант B: GitHub Actions‑как‑воркер**~~ — **ОТКЛОНЁН** (нарушение ToS GitHub, см. секцию 4.2).
3. **Вариант B (serverless compute): Modal или Google Cloud Run Jobs**
    - Для каждого анализа создается `analysis_job` в БД.
    - Vercel‑бекенд триггерит job через API платформы.
    - Job (в изолированном контейнере):
        - делает `git clone` целевого репозитория;
        - парсит диффы коммитов;
        - отправляет в OpenRouter (LLM);
        - пишет результаты в Supabase/Neon;
        - помечает задачу как завершённую.
    - Modal: $30/мес free tier, ~$0.008 за 10‑мин job, scale to zero.
    - Cloud Run: 2M free req/мес, ~$0.014 за 10‑мин job, полный контроль контейнера.
4. **Вариант C (без внешней инфраструктуры): Durable Execution поверх Vercel**
    - Используется Inngest, Trigger.dev или Upstash Workflow.
    - Анализ разбивается на step‑функции:
        - Step 1: получить список коммитов через GitHub API.
        - Step 2–N: для каждого батча коммитов — получить дифф через GitHub API, отправить в OpenRouter, записать результат в БД.
        - Final step: агрегировать метрики.
    - Каждый шаг — отдельный вызов serverless‑функции, укладывающийся в таймаут.
    - **Ограничение:** нет `git clone` — вся работа через GitHub REST API (медленнее для больших репо, зато нет зависимости от файловой системы).

### 5.2. Роль Vercel в такой архитектуре

На Vercel остаются:

- Маршруты:
    - `/api/auth/github` — OAuth;
    - `/api/analysis/create` — создание задачи анализа;
    - `/api/analysis/status` — проверка прогресса;
    - `/api/analysis/results` — выдача готовых метрик.
- Фронтенд:
    - выбор репозиториев;
    - конфигурация периода анализа;
    - дашборды Ghost %, графики, отчеты.

При этом **никакого тяжелого анализа и клонирования** в serverless‑функциях Vercel нет — только orchestrator.

### 5.3. Стратегия кэширования (Modal + Supabase)

**Проблема:** Modal — эфемерный. Каждый job = новый контейнер. Без кэша каждый анализ одного и того же репо начинается с нуля: повторный git clone + повторные LLM‑вызовы.

**Решение — два уровня кэша:**

**L1: Modal Volume (кэш репозиториев)**

- Modal Volumes — persistent сетевой диск, подключаемый к контейнерам.[^62]
- **Бесплатно** — отдельная плата за storage не взимается (на февраль 2026).[^60]
- Bare git repos после `git gc` содержат ~20–60 файлов на репо (packfiles). Volume v1 (лимит 500k inodes, рекомендовано <50k) справляется с сотнями репо.
- Bandwidth: до 2.5 GB/s (не гарантировано).[^62]
- **Concurrent access:** запись в один файл из нескольких контейнеров — last‑write‑wins. Нужен locking через Supabase при одновременном `git fetch` одного репо.
- Потеря Volume = повторный clone (неприятно, но не фатально).

**L2: Supabase `commit_cache` (кэш LLM‑результатов, source of truth)**

```sql
CREATE TABLE commit_cache (
    repo_url    TEXT,
    commit_sha  TEXT,
    diff_hash   TEXT,
    llm_result  JSONB,
    model_id    TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (repo_url, commit_sha)
);
```

- Перед отправкой в OpenRouter — проверить кэш: `SELECT ... WHERE repo_url = X AND commit_sha IN (...)`.
- Найдено 400 из 500 → в OpenRouter уходят только 100 новых коммитов.
- Потеря кэша = повторные LLM‑вызовы (деньги!).

**Эффект кэширования:**

| | Первый анализ | Повторный (те же коммиты) | Повторный (50 новых) |
|---|---|---|---|
| git | clone ~3 мин | fetch ~5 сек | fetch ~5 сек |
| LLM | 500 вызовов, ~$0.13 | **0 вызовов, $0** | 50 вызовов, ~$0.013 |
| Время | ~15 мин | **~30 сек** | ~2 мин |

**Открытые вопросы:**
- Лимит ГБ на Volume для Starter — не документирован. Проверить при PoC.
- Volume v2 (beta) снимает ограничение на inodes и улучшает concurrent access — рассмотреть при росте.[^62]

***

## 6. Риски и trade‑off’ы

1. **OCI Always Free:**
    - Риск закрытия/ограничения аккаунта.
    - **Idle reclamation** — инстансы с CPU <20% за 7 дней удаляются автоматически.
    - **Out of Capacity** — во многих регионах Ampere A1 недоступен без Pay‑As‑You‑Go.
    - Придётся инвестировать время в настройку Linux/DevOps.
2. ~~**GitHub Actions как воркер:**~~ — **ОТКЛОНЁН** (нарушение ToS, ненадёжность, security risks — см. секцию 4.2).
3. **Modal / Cloud Run Jobs:**
    - Зависимость от облачного провайдера (vendor lock‑in, но умеренный — стандартные контейнеры).
    - Modal: инфраструктура только в US‑East; Python‑ориентирован.
    - Cloud Run: требует Google Cloud аккаунт и минимальный DevOps (Dockerfile, IAM).
    - Стоимость растёт линейно с числом анализов (~$0.01/job).
4. **Supabase Free:**
    - 500 МБ БД может быстро заполниться, если:
        - хранить «сырые» диффы;
        - не делать агрессивную агрегацию/архивацию.
    - **Автоматическая пауза** проекта после 1 недели без запросов — требует ручного возобновления.
    - Нужен дизайн схемы с упором на:
        - хранение агрегатов;
        - возможность чистки старых «сырых» данных.
4. **Durable Execution (Inngest/Trigger.dev):**
    - Vendor lock‑in на конкретную платформу оркестрации.
    - Нет файловой системы — невозможен `git clone`, только GitHub API.
    - Free‑tier может быть недостаточен при анализе репо с тысячами коммитов (каждый коммит = минимум 1 event/run).

***

## 7. Рекомендации ИИ‑архитектору проекта

1. **Жёстко зафиксировать правило:**
Vercel используется **только** как слой UI + легкая оркестрация API.
Любые длительные операции (дольше 10–20 секунд), работа с файловой системой и репозиториями должны уходить во внешние воркеры.
2. **На этапе MVP выбрать одну из трёх стратегий воркеров:**
    - **Стратегия A (self‑hosted):** OCI Always Free как единый compute‑узел. Учесть риски idle reclamation и out‑of‑capacity.
    - **Стратегия B (serverless compute, рекомендуемая):** Modal или Google Cloud Run Jobs — API‑triggered контейнеры с `git clone`, scale to zero, $30/мес free (Modal) или 2M req/мес free (Cloud Run).
    - **Стратегия C (serverless‑only, без сервера):** Durable execution (Inngest / Trigger.dev) поверх Vercel — весь код в Next.js, анализ через GitHub API без `git clone`. Подходит для быстрого старта, но ограничен по масштабу.
    - ~~**GitHub Actions**~~ — **ОТКЛОНЁН** (нарушение ToS GitHub для коммерческого SaaS).
3. **Использовать Supabase (или Neon) как центральную точку данных:**
    - схема БД должна быть спроектирована под:
        - idempotent‑обработку (повторный анализ тех же коммитов не дублирует записи);
        - инкрементальное обновление;
        - возможность шардирования по репозиториям или организациям в будущем.
4. **Оптимизировать LLM‑вызовы:**
    - батчить маленькие диффы;
    - ограничивать объем контекста;
    - кэшировать уже проанализированные коммиты (hash диффа → результат).
5. **Предусмотреть переход с free‑tier на платный:**
    - заранее заложить в код конфиги:
        - смены хоста БД (Supabase → managed Postgres);
        - увеличения мощности воркеров (OCI → платный VPS, Render, AWS ECS/EKS и т. п.);
        - возможность горизонтального масштабирования воркеров (несколько инстансов, очередь задач).
6. **Безопасность и комплаенс:**
    - при работе с приватными репозиториями:
        - не хранить access‑tokens в явном виде;
        - предусмотреть опцию «удалить все данные анализа и кэш по репо»;
        - чётко прописать, что код не отправляется в сторонние LLM (если это критично) либо явно предупреждать о том, что OpenRouter получает диффы.

***


[^1]: https://vercel.com/docs/functions/runtimes

[^2]: https://vercel.com/docs/functions/limitations

[^3]: https://vercel.com/docs/functions/configuring-functions/duration

[^4]: https://www.reddit.com/r/nextjs/comments/1f98s54/how_do_i_bypass_the_45mb_body_size_limit_of/

[^5]: https://github.com/vercel/next.js/discussions/48324

[^6]: https://www.reddit.com/r/oraclecloud/comments/1nxycai/is_vmstandarda1flex_really_always_free_under_the/

[^7]: https://www.reddit.com/r/oraclecloud/comments/1f8pqsm/a_question_about_always_free_limits/

[^8]: https://fullmetalbrackets.com/blog/oci-free-tier-breakdown/

[^9]: https://www.reddit.com/r/selfhosted/comments/1ma6jbt/does_oracle_cloud_free_tier_have_any_gotchas_or/

[^10]: https://docs.github.com/en/actions/administering-github-actions/usage-limits-billing-and-administration?azure-portal=true

[^11]: https://www.saaspricepulse.com/tools/railway

[^12]: https://docs.railway.com/pricing/plans

[^13]: https://toolradar.com/tools/flyio/pricing

[^14]: https://askai.glarity.app/search/Is-Fly-io-free-to-use

[^15]: https://freetier.co/directory/products/koyeb

[^16]: https://help-center.atlasbeta.so/getatlas-m4f5xb79jb/articles/281592-understanding-koyeb-s-pricing-plans

[^17]: https://community.render.com/t/web-worker-not-part-of-the-free-plan/24555

[^18]: https://freetier.co/directory/products/render

[^19]: https://www.reddit.com/r/Backend/comments/1mijlb1/background_workers_with_decent_free_plans/

[^20]: https://uibakery.io/blog/supabase-pricing

[^21]: https://freetier.co/directory/products/supabase

[^22]: https://freetier.co/directory/products/neon-serverless-postgres

[^23]: https://vela.simplyblock.io/articles/neon-serverless-postgres-pricing-2026/

[^24]: https://render.com/docs/background-workers

[^25]: https://northflank.com/blog/railway-vs-render

[^26]: https://render.com/articles/best-infrastructure-python-ai-celery-workers

[^27]: https://www.reddit.com/r/devops/comments/1l0aqcd/looking_for_cheapest_way_to_run_a_247_background/

[^28]: https://github.com/TheOdinProject/curriculum/issues/26316

[^29]: https://azhida.github.io/docs.fly.io/about/pricing

[^30]: https://thesoftwarescout.com/railway-vs-render-2026-best-platform-for-deploying-apps/

[^31]: https://railway.com/pricing

[^32]: https://supabase.com/pricing

[^33]: https://github.com/orgs/supabase/discussions/38200

[^34]: https://github.com/orgs/supabase/discussions/33121

[^35]: https://forum.codewithmosh.com/t/planetscale-is-removing-free-tier/25534

[^36]: https://seema3dev.com/blog/supabase-free-plan-limits-maximize

[^37]: https://www.reddit.com/r/aws/comments/1fqnj8m/rds_free_tier_db_going_over_the_free_tier_limits/

[^38]: https://dev.to/lukeecart/planet-scale-is-removing-free-tier-2f17

[^39]: https://kamarasa.com/blog/supabase-free-tier-user-limits

[^40]: https://www.youtube.com/watch?v=UNpoF5-dD8I

[^41]: https://www.reddit.com/r/Supabase/comments/1hjcc5e/will_free_tier_be_enough_for_my_project/

[^42]: https://dev.to/hackmamba/run-postgres-for-free-top-3-options-2pk6

[^43]: https://vercel.com/docs/functions/configuring-functions/duration

[^44]: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm

[^45]: https://www.freetiers.com/directory/oracle-cloud-compute-arm

[^46]: https://www.blacksmith.sh/blog/actions-pricing

[^47]: https://fly.io/docs/about/pricing/

[^48]: https://supabase.com/docs/guides/platform/billing-on-supabase

[^49]: https://neon.com/pricing

[^50]: https://www.inngest.com/pricing

[^51]: https://trigger.dev/pricing

[^52]: https://upstash.com/pricing

[^53]: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features

[^54]: https://www.trendmicro.com/en/research/22/g/unpacking-cloud-based-cryptocurrency-miners-that-abuse-github-ac.html

[^55]: https://github.com/orgs/community/discussions/165400

[^56]: https://github.blog/news-insights/company-news/github-availability-report-december-2025/

[^57]: https://github.com/orgs/community/discussions/186197

[^58]: https://www.wiz.io/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066

[^59]: https://blog.gitguardian.com/ghostaction-campaign-3-325-secrets-stolen/

[^60]: https://modal.com/pricing

[^61]: https://cloud.google.com/run/pricing

[^62]: https://modal.com/docs/guide/volumes

