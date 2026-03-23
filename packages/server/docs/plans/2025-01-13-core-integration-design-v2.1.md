# Дизайн: Интеграция с Core API

## Обзор

**Цель:** Получать данные о трудозатратах разработчиков из Core API — внешнего сервиса, который анализирует Git-репозитории и рассчитывает effort.

**Спецификация Core API:** `docs/main.yaml`

**Основные сценарии:**
- Разовый анализ репозиториев
- Регулярный мониторинг с автообновлением (cron + ручное)

## Flow

**1. ВЫБОР РЕПОЗИТОРИЕВ**
- Пользователь выбирает репозитории:
  - GitHub OAuth (приватные репо)
  - Публичный URL (любой git-хостинг: GitHub, GitLab, Bitbucket, self-hosted)
  - Загрузка архива (без хостинга)
- POST /api/orders
- Статус: `DRAFT`

**2. ИЗВЛЕЧЕНИЕ АВТОРОВ**
- Система загружает коммиты из выбранных репозиториев
- Извлекает авторов (name + email, опционально GitHub login если доступен)
- POST /api/orders/[id]/developers
- Статус: `DEVELOPERS_LOADED`

**3. АВТО-ДЕДУПЛИКАЦИЯ**
- Система находит дубликаты (exact name, email domain, fuzzy match, опционально GitHub login)
- HIGH confidence — авто-мёрдж
- MEDIUM/LOW confidence — предложения

**4. РУЧНАЯ КОРРЕКТИРОВКА МАППИНГА**
- Пользователь: merge/unmerge, exclude
- Задаёт для каждого Developer: уровень, ставку, валюту, % участия
- POST /api/orders/[id]/mapping
- Статус: `READY_FOR_ANALYSIS`

**5. ОТПРАВКА В CORE**
- POST /repositories (если репозиторий новый)
- Polling статуса пока FINISHED
- POST /repositories/{id}/effort с developers[] и authors[]
- x4 периода: WEEK, MONTH, QUARTER, YEAR
- Сохраняем в CoreEffort

**6. РАСЧЁТ МЕТРИК**
- Агрегируем CoreEffort по всем репозиториям
- Рассчитываем: efficiency, effRate, deviation, totalCost
- Сохраняем в UserMetric
- Статус: `COMPLETED`

**7. ПРОСМОТР АНАЛИТИКИ**
- Таблица метрик, графики, calendar view
- Переключение периодов (мгновенное, данные уже загружены)

---

### Стратегии автоматической дедупликации

| Стратегия | Confidence | Пример | Действие |
|-----------|------------|--------|----------|
| Точное совпадение имени | HIGH | `John Doe` = `john doe` | Авто-мёрдж |
| Одинаковый GitHub login (если есть) | HIGH | `johndoe` = `johndoe` | Авто-мёрдж |
| Инициал + фамилия | MEDIUM | `J. Doe` ↔ `John Doe` | Предложение |
| Тот же домен email + похожее имя | MEDIUM | `john@company.com` ↔ `j.doe@company.com` | Предложение |
| Levenshtein distance ≤ 2 | LOW | `Jon Doe` ↔ `John Doe` | Предложение |

**Алгоритм:** Union-Find. HIGH → авто-мёрдж, MEDIUM/LOW → предложение пользователю.

**Примечание:** GitHub login — опциональный сигнал, доступен только для репозиториев добавленных через GitHub OAuth. Дедупликация работает и без него.

---

## Архитектура

**UI/API** ---> **Our DB** ---> **Core API**

| UI/API | Our DB | Core API |
|--------|--------|----------|
| Repositories | Repository | Clone |
| Developers | Author | Analyze |
| Mapping | Developer | Effort |
| Analytics | CoreEffort | |

**Ключевые решения:**
- Repository — уникальная сущность per User (не переиспользуется между пользователями)
- **Author** — из git, **Developer** — дедублицированная сущность (1 Developer ↔ N Authors)
- Метрики рассчитываем на периодной основе (WEEK/MONTH/QUARTER/YEAR)
- Дедупликация разработчиков определяется на нашей стороне, передаётся в Core через `authors`
- **MVP:** Расчёт всегда по всем загруженным репозиториям (без частичного выбора)
- **MVP:** Маппинг Author → Developer обязателен для запуска расчёта

**Решение: дедупликация репозиториев на нашей стороне НЕ нужна**

Рассмотрели вариант дедупликации по URL + root commit SHA (хэш первого коммита), но отказались:
- Core сам оптимизирует повторные запросы (не тратит ресурсы на уже обработанные репо)
- Простая архитектура: каждый User имеет изолированные данные
- Нет проблем с GDPR (удаление данных пользователя)
- Нет shared state между пользователями
- Защита от namespace hijacking не требуется (изоляция per User)

---

## Модель данных

### Концептуальная модель: Author vs Developer

**GIT (исходные данные):**
- Коммит 1: author = { name: "John Doe", email: "john@work.com" }
- Коммит 2: author = { name: "J. Doe", email: "john.doe@gmail.com" }
- Коммит 3: author = { name: "Jane", email: "jane@company.com" }

**НАША СИСТЕМА (после дедупликации):**

| Author (из гита) | Developer (наша сущность) |
|------------------|---------------------------|
| name: "John Doe", email: john@work.com | **Developer uuid-1** |
| name: "J. Doe", email: john.doe@gmail.com | displayName: "John Doe", level: SENIOR |
| | |
| name: "Jane", email: jane@company.com | **Developer uuid-2** |
| | displayName: "Jane Smith", level: MIDDLE |

*Несколько Author могут маппиться на одного Developer (дедупликация)*

### Справочники

```sql
-- Справочник источников репозиториев
RepositorySource (
  id              VARCHAR(20) PRIMARY KEY,  -- GITHUB, UPLOAD, GITLAB, BITBUCKET
  name            VARCHAR(100),
  description     TEXT
)

-- Справочник уровней разработчиков
DeveloperLevel (
  id              VARCHAR(20) PRIMARY KEY,  -- JUNIOR, MIDDLE, SENIOR, LEAD
  name            VARCHAR(100),
  defaultRate     DECIMAL(10,2)             -- в Settings.defaultCurrency
)

-- Начальные данные (в дефолтной валюте RUB):
-- JUNIOR: 3000, MIDDLE: 5000, SENIOR: 8000, LEAD: 10000
```

### Repository

```sql
Repository (
  id                UUID PRIMARY KEY,

  -- Идентификация
  name              VARCHAR(255),
  fullName          VARCHAR(255),           -- owner/repo (для GitHub)
  url               VARCHAR(500),           -- публичный URL (без токена)
  sourceType        VARCHAR(20) FK → RepositorySource,  -- GITHUB/UPLOAD/...

  -- Связь с Core
  coreRepositoryId  BIGINT,                 -- ID в Core (null пока не отправлен)

  -- Статусы
  loadStatus        VARCHAR(20),            -- NEW/IN_PROGRESS/FINISHED/ERROR
  syncStatus        VARCHAR(20),            -- NEVER/SUCCESS/FAILED
  coreStatus        VARCHAR(20),            -- NEW/IN_PROGRESS/FINISHED/ERROR/DO_NOT_PROCESS

  -- Владелец и доступ
  isPrivate         BOOLEAN,
  ownerId           UUID FK → User,         -- кто добавил (для токена)

  -- Автообновление
  autoUpdate        BOOLEAN DEFAULT FALSE,
  updateInterval    VARCHAR(20),            -- WEEKLY/MONTHLY (минимум = неделя)
  lastSyncAt        TIMESTAMP,
  nextSyncAt        TIMESTAMP,

  -- Защита от race conditions
  syncInProgress    BOOLEAN DEFAULT FALSE,
  syncStartedAt     TIMESTAMP,

  -- Локальное хранение (для Сценария B: upload)
  localPath         VARCHAR(500),             -- путь к локальной копии (null если не храним)
  localStorageMode  VARCHAR(20),              -- TEMPORARY / PERSISTENT

  createdAt         TIMESTAMP,
  updatedAt         TIMESTAMP
)

-- Токен для приватных репозиториев: Repository.ownerId → User.githubAccessToken
-- При автосинхронизации: JOIN User, формируем URL с токеном
-- Если токен истёк/отозван → syncStatus = FAILED, уведомляем пользователя
```

### Author

```sql
-- Авторы коммитов (сырые данные из git)
Author (
  id              UUID PRIMARY KEY,
  repositoryId    UUID FK → Repository,   -- в каком репозитории встречается
  developerId     UUID FK → Developer,    -- к какому разработчику привязан (null если не привязан)

  -- Данные из git
  name            VARCHAR(255),           -- git user.name
  email           VARCHAR(255),           -- git user.email

  -- Статистика (для удобства)
  commitCount     INT,
  firstCommitAt   TIMESTAMP,
  lastCommitAt    TIMESTAMP,

  createdAt       TIMESTAMP,

  UNIQUE (repositoryId, email)            -- один email на репозиторий
)
```

### Developer

```sql
-- Разработчики (наша дедублицированная сущность)
Developer (
  id              UUID PRIMARY KEY,
  ownerId         UUID FK → User,         -- кто создал (для изоляции данных)

  -- Отображение
  displayName     VARCHAR(255),           -- отображаемое имя (редактируемое)
  level           VARCHAR(20) FK → DeveloperLevel,  -- JUNIOR/MIDDLE/SENIOR/LEAD

  -- Для идентификации (опционально)
  primaryEmail    VARCHAR(255),           -- основной email (для отображения)

  createdAt       TIMESTAMP,
  updatedAt       TIMESTAMP
)

-- Core привязывается к Developer.id, displayName можно менять
```

### CoreEffort

```sql
-- Effort из Core
CoreEffort (
  id              UUID PRIMARY KEY,
  repositoryId    UUID FK → Repository,
  developerId     UUID FK → Developer,

  -- Период
  periodType      VARCHAR(10),            -- WEEK/MONTH/QUARTER/YEAR
  dateFrom        DATE,
  dateTo          DATE,

  -- Данные от Core
  effort          DECIMAL(10,2),          -- часы
  actualWorkDays  INT,                    -- фактические рабочие дни (дни с effort > 0)
  commitCount     INT,                    -- количество коммитов за период

  -- Метаданные
  fetchedAt       TIMESTAMP,              -- когда получили от Core
  mappingVersion  INT,                    -- версия маппинга на момент получения

  UNIQUE (repositoryId, developerId, periodType, dateFrom)
)
```

### Историчность маппинга

```sql
-- История изменений маппинга Author → Developer
AuthorDeveloperHistory (
  id              UUID PRIMARY KEY,
  authorId        UUID FK → Author,
  developerId     UUID FK → Developer,    -- к кому был привязан (null = отвязан)

  changedAt       TIMESTAMP,
  changedBy       UUID FK → User,

  -- Для отслеживания пересчёта
  mappingVersion  INT                     -- инкрементируется при каждом изменении
)

-- На уровне пользователя
UserMappingState (
  userId          UUID FK → User PRIMARY KEY,
  currentVersion  INT,                    -- текущая версия маппинга
  lastCalcVersion INT,                    -- версия при последнем расчёте
  needsRecalc     BOOLEAN GENERATED ALWAYS AS (currentVersion > lastCalcVersion) STORED
)
```

### Настройки разработчика (UserDeveloper)

```sql
UserDeveloper (
  userId          UUID FK → User,
  developerId     UUID FK → Developer,

  dailyRate       DECIMAL(10,2),             -- custom ставка
  currency        VARCHAR(3) DEFAULT 'RUB',  -- валюта ставки
  share           DECIMAL(3,2) DEFAULT 1.0,  -- доля участия (0.0-1.0)
  isExcluded      BOOLEAN DEFAULT FALSE,

  PRIMARY KEY (userId, developerId)
)
```

### Рассчитанные метрики

```sql
UserMetric (
  id              UUID PRIMARY KEY,
  userId          UUID FK → User,
  developerId     UUID FK → Developer,

  -- Период
  periodType      VARCHAR(10),
  dateFrom        DATE,
  dateTo          DATE,

  -- Из Core (агрегировано по всем репозиториям)
  totalEffort     DECIMAL(10,2),          -- сумма effort
  actualWorkDays  INT,                    -- фактические рабочие дни
  commitCount     INT,                    -- количество коммитов

  -- Рассчитано нами
  efficiency      DECIMAL(5,2),           -- эффективность (не показываем в UI)
  effRate         DECIMAL(10,2),          -- эффективная ставка
  deviation       DECIMAL(5,2),           -- отклонение %
  totalCost       DECIMAL(12,2),          -- итоговая стоимость

  -- Метаданные
  calculatedAt    TIMESTAMP,
  mappingVersion  INT,                    -- версия маппинга при расчёте

  UNIQUE (userId, developerId, periodType, dateFrom)
)
```

---

## Интеграция с Core API

### Добавление репозитория

**Сценарий A: Core клонирует сам (по URL)**

```
POST /repositories
{
  "name": "spring-boot",
  "url": "https://github.com/spring-projects/spring-boot.git"
}
← { "id": 42 }
```

Когда использовать:
- Публичные репозитории
- Core имеет прямой доступ к Git-хостингу

**Сценарий B: Мы передаём архив (upload)**

```
POST /repositories/upload
Content-Type: multipart/form-data

file: <zip-архив репозитория>
name: "spring-boot"

← { "id": 42 }
```

Когда использовать:
- Приватные репозитории (токен не передаём в Core)
- Core не имеет доступа к Git-хостингу (firewall, VPN)
- Локальные репозитории без remote

### Запрос effort (с маппингом)

```
POST /repositories/42/effort
{
  groupByPeriod: "MONTH",
  developers: [
    {
      id: "uuid-dev-1",
      authors: [
        { name: "John Doe", email: "john@work.com" },
        { name: "J. Doe", email: "john.doe@gmail.com" }
      ]
    },
    {
      id: "uuid-dev-2",
      authors: [
        { name: "Jane", email: "jane@company.com" }
      ]
    }
  ]
}

← [
    {
      developerId: "uuid-dev-1",
      period: { dateFrom: "2024-01-01", dateTo: "2024-01-31" },
      effort: 45.2,
      actualWorkDays: 18,    // НОВОЕ: дни с effort > 0
      commitCount: 42        // НОВОЕ: количество коммитов
    },
    {
      developerId: "uuid-dev-2",
      period: {...},
      effort: 32.8,
      actualWorkDays: 15,
      commitCount: 28
    }
  ]

Core суммирует effort по всем email в authors для каждого developerId.
Агрегация идёт только по репозиториям, указанным в запросе.
```

### Обязательные поля в ответе effort

```yaml
DeveloperEffortByPeriod:
  properties:
    developerId:
      type: string
      format: uuid
    period:
      $ref: '#/components/schemas/Period'
    effort:
      type: number
      description: Часы effort за период
    actualWorkDays:           # ОБЯЗАТЕЛЬНО
      type: integer
      description: Количество дней с effort > 0 в периоде
    commitCount:              # ОБЯЗАТЕЛЬНО
      type: integer
      description: Количество коммитов за период
  required:
    - developerId
    - period
    - effort
    - actualWorkDays          # ОБЯЗАТЕЛЬНО
    - commitCount             # ОБЯЗАТЕЛЬНО
```

### Константы для расчёта

Core должен использовать следующие константы:

```yaml
constants:
  distributionLimit: 5        # лимит распределения
  localTestingReduction: 0.2  # все базовые Effort уменьшаются на 20%
```

---

## Расчёт метрик

### Входные данные

- **От Core:** effort (часы), actualWorkDays (дни с effort > 0), commitCount
- **Наши настройки:** dailyRate (ставка), share (доля участия 0.0-1.0)

### Формулы

**Важно:** Нормы считаем от фактических рабочих дней (actualWorkDays), не от констант.

```
Efficiency = effort / (actualWorkDays × 5 × share)

Где:
  - effort: часы от Core
  - actualWorkDays: дни с effort > 0 (от Core)
  - 5: нормо-часов в день (константа)
  - share: доля участия (0.0-1.0)

Пример (share=100%, actualWorkDays=18):
  76.5ч / (18 × 5 × 1.0) = 76.5 / 90 = 85%

Пример (share=50%, actualWorkDays=18):
  38.0ч / (18 × 5 × 0.5) = 38 / 45 = 84.4%
```

```
Effective Rate = Efficiency × dailyRate

Пример: 0.85 × ₽5000 = ₽4250
```

```
Deviation = ((effRate - dailyRate) / dailyRate) × 100%

Пример: ((₽4250 - ₽5000) / ₽5000) × 100% = -15%
```

```
Total Cost = effRate × actualWorkDays

Пример: ₽4250 × 18 = ₽76,500
```

**Не показываем в UI:** Efficiency, Effort (внутренние данные).

---

## UI и визуализация

### Порядок колонок в таблице метрик

| Имя | Класс | Ставка | Занятость | Эфф.ставка | Откл. | Раб.дни | Итого |
|-----|-------|--------|-----------|------------|-------|---------|-------|
| John Doe | Senior | 8000 | 100% | 6800 | -15% | 18 | 122K |
| Jane Smith | Middle | 5000 | 50% | 5100 | +2% | 15 | 76K |

**Колонки:**
1. **Имя** — displayName разработчика
2. **Класс** — JUNIOR/MIDDLE/SENIOR/LEAD
3. **Ставка** — dailyRate (из иерархии настроек)
4. **Занятость** — share (%)
5. **Эфф.ставка** — effRate (рассчитано)
6. **Откл.** — deviation (%)
7. **Раб.дни** — actualWorkDays (от Core)
8. **Итого** — totalCost (рассчитано)

### Страница маппинга разработчиков

**Важно:** Редактирование Уровня, Ставки и Занятости **только на странице маппинга**, не из аналитики.

**Структура страницы маппинга:**

**Заголовок:** Маппинг разработчиков [Подтвердить всё]

**Секция 1: Авто-мёрдж (HIGH confidence)**
- John Doe [Unmerge] — Уровень: Senior, Ставка: 8000, Валюта: RUB, Занятость: 100%
  - Авторы: john@work.com (45), john.doe@gmail.com (12)
  - Причина: Same GitHub login "johndoe"

**Секция 2: Предложение (MEDIUM confidence)**
- Jane Smith [Merge] [Отклонить] — Уровень: Middle, Ставка: 5000, Валюта: RUB, Занятость: 100%
  - Возможные дубликаты: jane@company.com (30), j.smith@company.com (5)
  - Причина: Same email domain + similar name

**Секция 3: Уникальные авторы**
- Bob Wilson [Найти дубликаты] — Уровень: Junior, Ставка: 3000, Валюта: USD, Занятость: 50%
  - Автор: bob@external.com (8)
- Test User [Exclude]
  - Автор: test@test.com (3), похоже на тестового пользователя

**Футер:** Всего: 4 разработчика, 7 авторов, 103 коммита. 1 предложение требует подтверждения [Подтвердить]

**Действия пользователя на странице маппинга:**

| Действие | Описание |
|----------|----------|
| **Merge** | Объединить предложенных авторов в одного Developer |
| **Unmerge** | Разделить авто-мёрдж обратно на отдельных Developer |
| **Отклонить** | Отклонить предложение, оставить авторов раздельно |
| **Найти дубликаты** | Вручную указать другого автора как дубликат |
| **Exclude** | Исключить автора из расчёта (боты, тестовые пользователи) |
| **Уровень** | Выбрать JUNIOR/MIDDLE/SENIOR/LEAD (влияет на дефолтную ставку) |
| **Ставка** | Custom ставка для разработчика |
| **Валюта** | Валюта ставки (RUB/USD/EUR) для распределённых команд |
| **Занятость** | % участия (part-time, совмещение с другими проектами) |

**UI ручного мёржа (когда авто-алгоритм не нашёл дубликаты):**

**Диалог: Ручной мёрж: Bob Wilson**

Выберите авторов для объединения:
- [x] bob@external.com (Bob Wilson) — 8 коммитов (текущий)
- [ ] robert@company.com (Robert W.) — 3 коммита
- [ ] b.wilson@gmail.com (B Wilson) — 2 коммита

Поиск: (по имени или email)

Имя Developer: Bob Wilson

Кнопки: [Отмена] [Объединить выбранных]

**Дефолты при создании Developer:**
- Уровень: MIDDLE
- Ставка: из уровня (MIDDLE = 5000)
- Валюта: RUB (из Settings.defaultCurrency)
- Занятость: 100%

### Селектор периода

`[Неделя] [Месяц●] [Квартал] [Год]` — по умолчанию MONTH, переключение мгновенное.

### Ограничение глубины аналитики (Админка)

```sql
-- Настройки пользователя
User (
  ...
  analyticsDepthYears  DECIMAL(3,1) DEFAULT 1.0  -- глубина аналитики в годах
)
```

**Правила:**
- По умолчанию: -1.0 год от текущей даты (округляем до целого месяца в прошлое)
- Администратор может изменить для конкретного пользователя
- Формат: десятичное число (0.5 = полгода, 2.0 = два года)

**Пример (Admin Panel):**
- User: john@example.com
- Analytics Depth: 1.0 years
- Current access: Jan 2024 - Jan 2025

### Иерархия ставок и валюты

**1. Глобальные настройки (Settings)**
- defaultDailyRate: 5000
- defaultCurrency: RUB

**2. Уровень разработчика (DeveloperLevel)**
- JUNIOR: 3000, MIDDLE: 5000, SENIOR: 8000, LEAD: 10000

**3. Настройки пользователя (User)**
- dailyRate: переопределяет глобальный
- displayCurrency: валюта отображения сводной аналитики

**4. Настройки разработчика (UserDeveloper)**
- dailyRate: custom ставка (переопределяет всё выше)
- currency: валюта ставки (для распределённых команд)
- share: доля участия

**Логика применения ставки:**
```
effectiveRate = UserDeveloper.dailyRate
             ?? DeveloperLevel.defaultRate
             ?? User.dailyRate
             ?? Settings.defaultDailyRate
```

**Логика валют:**
```
developerCurrency = UserDeveloper.currency      -- валюта ставки разработчика
                 ?? Settings.defaultCurrency

displayCurrency = User.displayCurrency          -- валюта отображения сводки
               ?? Settings.defaultCurrency
```

**Мультивалютность в распределённых командах:**
- Каждый разработчик может иметь свою валюту (USD, EUR, RUB)
- В сводной аналитике все суммы конвертируются в `displayCurrency`
- Курсы конвертации: из Settings или внешний API

**Пример сводной аналитики (валюта отображения: RUB):**

| Имя | Валюта | Ставка | Эфф.ставка | Итого (ориг) | Итого (RUB) |
|-----|--------|--------|------------|--------------|-------------|
| John Doe | USD | $100 | $85 | $1,530 | 137,700 |
| Ivan Petrov | RUB | 8000 | 6800 | 122,400 | 122,400 |
| Hans Muller | EUR | €90 | €95 | €1,710 | 170,000 |
| **ИТОГО** | | | | | **430,100** |

### Статус синхронизации

**Repository: owner/repo**
- Load Status: FINISHED
- Sync Status: SUCCESS (2 hours ago)
- Core Status: FINISHED
- Кнопки: [Refresh] [Stop Processing] [Delete]
- Auto-update: ON/OFF | Interval: Weekly

### Индикация состояний

| Core Status | UI |
|-------------|-----|
| NEW | "В очереди на обработку" |
| IN_PROGRESS | "Анализируется..." + прогресс |
| FINISHED | "Готово" + timestamp |
| ERROR | "Ошибка" + retry button |
| DO_NOT_PROCESS | "Пропущено Core" + info tooltip |

### Индикатор устаревших данных

Сообщение: "Маппинг изменён. Данные могут быть неактуальны." Кнопка: [Пересчитать]

### Пустые данные

**Сообщение: Нет данных для отображения**

Возможные причины:
- Репозитории ещё обрабатываются
- Не настроен маппинг разработчиков
- Нет коммитов в выбранном периоде

Кнопки: [Настроить маппинг] [Обновить]

---

## Регулярный мониторинг

### Минимальный квант обновления

**Неделя** — минимальный интервал для обновления. Метрики собираются только по полным неделям.

```sql
-- updateInterval допустимые значения:
-- WEEKLY, MONTHLY (не DAILY!)
```

### Ручное обновление

**Пользователь нажимает "Обновить" в UI:**

1. POST /repositories (тот же URL) или POST /repositories/{id}/recalculate - Core определяет: нужен ли пересчёт
2. Polling статуса
3. POST /effort x 4 периода с текущим маппингом
4. Обновляем CoreEffort, пересчитываем UserMetric

### Автоматическое обновление (cron)

**Cron Job: раз в неделю (минимум)**

1. Найти репозитории с `autoUpdate = true AND nextSyncAt <= NOW()`
2. Для каждого:
   - Захватить блокировку (см. race conditions)
   - POST /repositories или /recalculate
   - Обновить syncStatus, lastSyncAt, nextSyncAt

**Отдельный job: проверка статусов**

1. Найти репозитории с `coreStatus = 'IN_PROGRESS'`
2. GET /repositories/{id}, обновить статусы
3. Для FINISHED: запросить effort, обновить метрики

### Защита от race conditions

```sql
-- Атомарный захват блокировки
UPDATE Repository
SET syncInProgress = true, syncStartedAt = NOW()
WHERE id = :id
  AND (syncInProgress = false
       OR syncStartedAt < NOW() - INTERVAL '10 minutes')
RETURNING id

-- Если вернулся id → продолжаем
-- Если пусто → другой процесс работает, пропускаем
```

### Пересчёт при изменении маппинга

```
При изменении маппинга Author → Developer:
  1. Инкрементируем UserMappingState.currentVersion
  2. needsRecalc становится TRUE автоматически
  3. При следующем запросе аналитики:
     - Показываем индикатор "Данные устарели"
     - Предлагаем пересчитать
  4. При пересчёте:
     - Запрашиваем effort с новым маппингом
     - Обновляем lastCalcVersion = currentVersion
```

---

## Обработка ошибок

### Ошибки Core API

| Ситуация | Обработка |
|----------|-----------|
| Core недоступен (5xx, timeout) | Показать ошибку, кнопка "Retry", показать последние данные |
| Репозиторий не найден (404) | Удалить coreRepositoryId, предложить добавить заново |
| Невалидный URL (400) | Показать ошибку валидации |
| Core STATUS = ERROR | Показать сообщение от Core, кнопка "Retry" |

### Ошибки приватных репозиториев

**Сообщение: Ошибка доступа к репозиторию**

Не удалось клонировать приватный репозиторий. Токен мог истечь или быть отозван.

Кнопки: [Переподключить GitHub] [Использовать публичный URL]

### Graceful degradation

Core недоступен → показываем последние данные + индикатор времени + кнопка "Retry".

---

## Открытые вопросы к Core

### Вопрос 1: Получение статуса конкретного репозитория

*Текущая ситуация:* Для получения статуса нужен `GET /repositories?page=0&size=N`.

*Предложение:* Добавить `GET /repositories/{id}`.

---

### Вопрос 2: Время последней обработки

*Текущая ситуация:* Нет информации о том, когда Core завершил обработку репозитория.

*Предложение:* Добавить в `RepositoryInfo`:
```yaml
lastProcessedAt: datetime  # когда завершилась последняя обработка
```

*Примечание:* Отслеживание новых коммитов реализуем на своей стороне через GitHub API (сравниваем SHA последнего коммита с сохранённым).

---

### Вопрос 3: Лимиты и ограничения

*Нужно знать:*
- Максимальный размер репозитория?
- Rate limits?
- Таймаут обработки?
- Рекомендуемый интервал polling?

---

### Вопрос 4: Механизм пересчёта

*Вопрос:* Что происходит при повторном `POST /repositories` с тем же URL?

*Предпочтительный вариант:* Запускает пересчёт и возвращает существующий id.

---

### Вопрос 5: Webhook вместо polling

*Предложение:*
```yaml
POST /repositories
{
  "webhookUrl": "https://our-api.com/webhook/core"
}
```

---

### Вопрос 6: Локальный пересчёт при изменении маппинга

*Проблема:* При изменении маппинга (merge/unmerge авторов) нужно пересчитать метрики. Текущий подход — перезапросить Core с новым маппингом.

*Альтернатива:* Хранить effort на уровне Author, агрегировать локально.

```
Первичный запрос: каждый Author = отдельный developer
POST /repositories/42/effort
{
  developers: [
    { id: "author-uuid-1", authors: [{ name: "John", email: "j@x.com" }] },
    { id: "author-uuid-2", authors: [{ name: "J.Doe", email: "j@y.com" }] }
  ]
}

Сохраняем в AuthorEffort (сырые данные).
При изменении маппинга — агрегируем локально без запроса к Core.
```

*Преимущества:*
- Мгновенный пересчёт при merge/unmerge
- Меньше нагрузки на Core
- Core нужен только при синхронизации (новые коммиты)

*Недостатки:*
- Больше данных для хранения
- Дублирование логики агрегации

*Статус:* Отложено. Текущий сценарий — перезапрос Core при изменении маппинга.
