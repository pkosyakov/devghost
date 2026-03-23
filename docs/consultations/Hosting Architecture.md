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

- Hobby / Free: максимальная длительность serverless‑функции ~300 с.
- Pro/Enterprise: увеличивается, но предел — порядка **800–900 с** на вызов.

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


### 4.2. GitHub Actions как «воркерная платформа»

**Идея:** использовать GitHub Actions как compute‑платформу для фоновых задач.

**Факты:**

- Раннеры GitHub Actions:
    - 2 vCPU, 7 ГБ RAM, ~14 ГБ диска.
    - Один job может идти до **6 часов**.
- Бесплатно:
    - для **публичных репозиториев** — неограниченно;
    - для приватных — 2000 минут/месяц на free‑аккаунт.[^10]

**Поток:**

1. Пользователь инициирует анализ репозитория через UI на Vercel.
2. Vercel‑бекенд записывает «задачу» в БД и/или дергает GitHub Actions через `workflow_dispatch` API.
3. Action‑job:
    - делает `git clone` целевого репозитория;
    - прогоняет аналитику (LLM через OpenRouter);
    - пишет результаты обратно в вашу БД (Supabase/Neon);
    - помечает задачу как завершенную.
4. Фронтенд периодически опрашивает БД и обновляет UI.

**Плюсы:**

- Практически бесплатный compute (особенно если весь DevGhost ориентировать на публичные репозитории на старте).
- Нет ограничений Vercel по времени и диску.

**Минусы:**

- Активно используете GitHub как compute‑платформу — это «хак», но рабочий.
- Потенциальные нюансы с rate limits GitHub API и политикой использования Actions для сторонних задач.


### 4.3. Fly.io / Koyeb / Railway / Render

Состояние на 2025–2026:

- **Railway**:
    - теперь даёт только разовый **кредит \$5** и дальше переходит на платную модель,;[^11][^12]
    - это не постоянный бесплатный tier, только trial.
- **Fly.io**:
    - когда‑то имел free‑tier, сейчас — модель «почти бесплатно», но формально **без постоянного free‑tier**, только небольшие кредиты на старт,.[^13][^14]
- **Koyeb**:
    - есть небольшой free‑tier (~512 МБ RAM на инстанс, ограниченный трафик и storage),;[^15][^16]
    - этого мало для тяжелого анализа крупных репо.
- **Render**:
    - есть бесплатный tier для web‑сервисов и БД, но **background workers на free‑tier недоступны**,,.[^17][^18][^19]

**Вывод:**

- Для именно длительных фоновых воркеров free‑tier у этих PaaS либо отсутствует, либо сильно урезан.
- Они хороши как «следующий шаг» после MVP, но не идеальны как бесплатный старт под вашу нагрузку.


### 4.4. Базы данных: Supabase / Neon

- **Supabase Free**:
    - 500 МБ БД, 1 ГБ storage, 50k MAU, безлимит запросов,.[^20][^21]
    - Этого достаточно для MVP и первых платежеспособных клиентов.
- **Neon**:
    - 0.5 ГБ total storage, 190 compute‑часов/мес. на free‑tier, 10 проектов,.[^22][^23]
    - Тоже хороший вариант, особенно если нравится serverless‑подход.

Обе опции отлично интегрируются с Next.js/Vercel.

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
2. **Вариант B (без надежного доступа к «нормальному» VPS): GitHub Actions‑как‑воркер**
    - Для каждого анализа создается `analysis_job`.
    - Vercel вызывает GitHub Actions workflow через API.
    - Workflow:
        - поднимается на стандартном GitHub раннере (2 vCPU, 7 ГБ RAM, 6 часов).
        - запускает скрипт анализа (Python/Node.js).
        - сохраняет результаты в Supabase.
    - Можно ограничить поддержку **только публичных репозиториев** на раннем этапе, чтобы не выбиться из free‑лимитов Actions.

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

***

## 6. Риски и trade‑off’ы

1. **OCI Always Free:**
    - Риск закрытия/ограничения аккаунта.
    - Придётся инвестировать время в настройку Linux/DevOps.
2. **GitHub Actions как воркер:**
    - Потенциальное изменение политики GitHub по использованию Actions как compute.
    - Важно следить за лимитами минут и аккуратно использовать workflow’ы.
3. **Supabase Free:**
    - 500 МБ БД может быстро заполниться, если:
        - хранить «сырые» диффы;
        - не делать агрессивную агрегацию/архивацию.
    - Нужен дизайн схемы с упором на:
        - хранение агрегатов;
        - возможность чистки старых «сырых» данных.

***

## 7. Рекомендации ИИ‑архитектору проекта

1. **Жёстко зафиксировать правило:**
Vercel используется **только** как слой UI + легкая оркестрация API.
Любые длительные операции (дольше 10–20 секунд), работа с файловой системой и репозиториями должны уходить во внешние воркеры.
2. **На этапе MVP выбрать одну из двух стратегий воркеров:**
    - **Стратегия 1 (предпочтительная):** OCI Always Free как единый compute‑узел.
    - **Стратегия 2 (alt):** GitHub Actions как compute для анализа, с ориентацией на публичные репозитории.
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

