# Техническая реализация: Интеграция с Core API

## Обзор

Документ описывает детальный план реализации интеграции с Core API на основе [дизайна v2.1](./2025-01-13-core-integration-design-v2.1.md).

**Scope:** Миграция от Order-centric JSONB модели к нормализованной модели с Core API.

---

## Фаза 1: Миграция схемы базы данных

### 1.1 Новые модели Prisma

```prisma
// ==================== REPOSITORY ====================

enum RepositorySource {
  GITHUB
  GITLAB
  BITBUCKET
  UPLOAD
  OTHER
}

enum RepositoryLoadStatus {
  NEW
  IN_PROGRESS
  FINISHED
  ERROR
}

enum RepositorySyncStatus {
  NEVER
  SUCCESS
  FAILED
}

enum CoreStatus {
  NEW
  IN_PROGRESS
  FINISHED
  ERROR
  DO_NOT_PROCESS
}

model Repository {
  id                String               @id @default(cuid())

  // Идентификация
  name              String
  fullName          String?              // owner/repo (для GitHub)
  url               String               // публичный URL
  sourceType        RepositorySource     @default(OTHER)

  // Связь с Core
  coreRepositoryId  Int?                 // ID в Core (null пока не отправлен)

  // Статусы
  loadStatus        RepositoryLoadStatus @default(NEW)
  syncStatus        RepositorySyncStatus @default(NEVER)
  coreStatus        CoreStatus           @default(NEW)

  // Владелец и доступ
  isPrivate         Boolean              @default(false)
  ownerId           String
  owner             User                 @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  // Автообновление
  autoUpdate        Boolean              @default(false)
  updateInterval    String?              // WEEKLY, MONTHLY
  lastSyncAt        DateTime?
  nextSyncAt        DateTime?

  // Защита от race conditions
  syncInProgress    Boolean              @default(false)
  syncStartedAt     DateTime?

  // Локальное хранение (для upload)
  localPath         String?
  localStorageMode  String?              // TEMPORARY, PERSISTENT

  // Метаданные
  createdAt         DateTime             @default(now())
  updatedAt         DateTime             @updatedAt

  // Связи
  authors           Author[]
  coreEfforts       CoreEffort[]

  @@unique([ownerId, url])
  @@index([ownerId])
  @@index([coreStatus])
}
```

```prisma
// ==================== AUTHOR ====================

model Author {
  id              String      @id @default(cuid())
  repositoryId    String
  repository      Repository  @relation(fields: [repositoryId], references: [id], onDelete: Cascade)
  developerId     String?
  developer       Developer?  @relation(fields: [developerId], references: [id], onDelete: SetNull)

  // Данные из git
  name            String
  email           String

  // Статистика
  commitCount     Int         @default(0)
  firstCommitAt   DateTime?
  lastCommitAt    DateTime?

  createdAt       DateTime    @default(now())

  // История маппинга
  history         AuthorDeveloperHistory[]

  @@unique([repositoryId, email])
  @@index([repositoryId])
  @@index([developerId])
}
```

```prisma
// ==================== DEVELOPER ====================

model Developer {
  id              String    @id @default(cuid())
  ownerId         String
  owner           User      @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  // Отображение
  displayName     String
  level           DeveloperLevel @default(MIDDLE)
  primaryEmail    String?

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // Связи
  authors         Author[]
  coreEfforts     CoreEffort[]
  userSettings    UserDeveloper[]
  metrics         UserMetric[]
  history         AuthorDeveloperHistory[]

  @@index([ownerId])
}
```

```prisma
// ==================== CORE EFFORT ====================

enum CorePeriodType {
  WEEK
  MONTH
  QUARTER
  YEAR
}

model CoreEffort {
  id              String         @id @default(cuid())
  repositoryId    String
  repository      Repository     @relation(fields: [repositoryId], references: [id], onDelete: Cascade)
  developerId     String
  developer       Developer      @relation(fields: [developerId], references: [id], onDelete: Cascade)

  // Период
  periodType      CorePeriodType
  dateFrom        DateTime       @db.Date
  dateTo          DateTime       @db.Date

  // Данные от Core
  effort          Decimal        @db.Decimal(10, 2)  // часы
  actualWorkDays  Int            // фактические рабочие дни
  commitCount     Int            // количество коммитов

  // Метаданные
  fetchedAt       DateTime       @default(now())
  mappingVersion  Int            @default(1)

  @@unique([repositoryId, developerId, periodType, dateFrom])
  @@index([repositoryId])
  @@index([developerId])
}
```

```prisma
// ==================== USER DEVELOPER SETTINGS ====================

model UserDeveloper {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  developerId     String
  developer       Developer @relation(fields: [developerId], references: [id], onDelete: Cascade)

  // Настройки
  dailyRate       Decimal?  @db.Decimal(10, 2)
  currency        Currency  @default(RUB)
  share           Decimal   @default(1.0) @db.Decimal(3, 2)
  isExcluded      Boolean   @default(false)

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([userId, developerId])
  @@index([userId])
}
```

```prisma
// ==================== USER METRIC ====================

model UserMetric {
  id              String         @id @default(cuid())
  userId          String
  user            User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  developerId     String
  developer       Developer      @relation(fields: [developerId], references: [id], onDelete: Cascade)

  // Период
  periodType      CorePeriodType
  dateFrom        DateTime       @db.Date
  dateTo          DateTime       @db.Date

  // Из Core (агрегировано по всем репозиториям)
  totalEffort     Decimal        @db.Decimal(10, 2)
  actualWorkDays  Int
  commitCount     Int

  // Рассчитано нами
  efficiency      Decimal        @db.Decimal(5, 4)   // 0.8500 = 85%
  effRate         Decimal        @db.Decimal(10, 2)  // эффективная ставка
  deviation       Decimal        @db.Decimal(5, 2)   // отклонение %
  totalCost       Decimal        @db.Decimal(12, 2)  // итоговая стоимость

  // Метаданные
  calculatedAt    DateTime       @default(now())
  mappingVersion  Int            @default(1)

  @@unique([userId, developerId, periodType, dateFrom])
  @@index([userId])
  @@index([developerId])
}
```

```prisma
// ==================== MAPPING HISTORY ====================

model AuthorDeveloperHistory {
  id              String    @id @default(cuid())
  authorId        String
  author          Author    @relation(fields: [authorId], references: [id], onDelete: Cascade)
  developerId     String?
  developer       Developer? @relation(fields: [developerId], references: [id], onDelete: SetNull)

  changedAt       DateTime  @default(now())
  changedById     String
  changedBy       User      @relation(fields: [changedById], references: [id], onDelete: Cascade)

  mappingVersion  Int

  @@index([authorId])
  @@index([developerId])
}

model UserMappingState {
  id              String    @id @default(cuid())
  userId          String    @unique
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  currentVersion  Int       @default(1)
  lastCalcVersion Int       @default(0)

  updatedAt       DateTime  @updatedAt

  @@index([userId])
}
```

### 1.2 Изменения в User

```prisma
model User {
  // ... существующие поля ...

  // Новые поля для Core интеграции
  analyticsDepthYears  Decimal?  @default(1.0) @db.Decimal(3, 1)
  displayCurrency      Currency  @default(RUB)
  defaultDailyRate     Decimal?  @db.Decimal(10, 2)

  // Новые связи
  repositories         Repository[]
  developers           Developer[]
  userDevelopers       UserDeveloper[]
  userMetrics          UserMetric[]
  mappingState         UserMappingState?
  mappingHistory       AuthorDeveloperHistory[]
}
```

### 1.3 Стратегия миграции

**Этап 1: Добавление новых таблиц (non-breaking)**
- Создать новые модели без удаления старых
- Обе системы работают параллельно

**Этап 2: Миграция данных**
- Скрипт миграции JSONB → нормализованные таблицы
- Валидация целостности данных

**Этап 3: Переключение на новую модель**
- Обновить API endpoints
- UI компоненты

**Этап 4: Удаление старых полей**
- Удалить JSONB поля из Order
- Удалить связанные модели (CommitAnalysis, DailyEffort, etc.)

---

## Фаза 2: Core API Client

### 2.1 Структура сервиса

```
src/lib/core/
├── client.ts           # HTTP клиент для Core API
├── types.ts            # TypeScript типы для Core API
├── repositories.ts     # Операции с репозиториями
├── effort.ts           # Запрос effort данных
├── polling.ts          # Polling статуса обработки
└── errors.ts           # Обработка ошибок Core API
```

### 2.2 Core API Client

```typescript
// src/lib/core/client.ts

export interface CoreClientConfig {
  baseUrl: string;
  timeout?: number;
  retryAttempts?: number;
}

export class CoreClient {
  constructor(config: CoreClientConfig);

  // Repositories
  addRepository(data: AddRepositoryRequest): Promise<RepositoryResponse>;
  uploadRepository(file: File, name: string): Promise<RepositoryResponse>;
  getRepository(id: number): Promise<RepositoryInfo>;
  getRepositoryStatus(id: number): Promise<RepositoryStatus>;

  // Effort
  getEffort(repositoryId: number, request: EffortRequest): Promise<EffortResponse>;

  // Polling
  waitForCompletion(id: number, options?: PollingOptions): Promise<RepositoryInfo>;
}
```

### 2.3 Типы Core API

```typescript
// src/lib/core/types.ts

export interface AddRepositoryRequest {
  name: string;
  url: string;
}

export interface RepositoryResponse {
  id: number;
}

export interface RepositoryInfo {
  id: number;
  name: string;
  url: string;
  status: 'NEW' | 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'DO_NOT_PROCESS';
  lastProcessedAt?: string;
}

export interface EffortRequest {
  groupByPeriod: 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';
  developers: DeveloperMapping[];
}

export interface DeveloperMapping {
  id: string;  // Developer UUID
  authors: AuthorInfo[];
}

export interface AuthorInfo {
  name: string;
  email: string;
}

export interface EffortResponse {
  developerId: string;
  period: {
    dateFrom: string;
    dateTo: string;
  };
  effort: number;
  actualWorkDays: number;
  commitCount: number;
}
```

### 2.4 Polling с exponential backoff

```typescript
// src/lib/core/polling.ts

export interface PollingOptions {
  maxAttempts?: number;      // default: 60
  initialDelay?: number;     // default: 2000ms
  maxDelay?: number;         // default: 30000ms
  backoffFactor?: number;    // default: 1.5
}

export async function pollUntilComplete(
  client: CoreClient,
  repositoryId: number,
  options: PollingOptions
): Promise<RepositoryInfo> {
  // Exponential backoff polling
  // Throw CorePollingTimeoutError after maxAttempts
}
```

---

## Фаза 3: Backend Services

### 3.1 Repository Service

```typescript
// src/lib/services/repository-service.ts

export class RepositoryService {
  constructor(private db: PrismaClient, private coreClient: CoreClient);

  // CRUD
  async addFromGitHub(userId: string, repoData: GitHubRepoData): Promise<Repository>;
  async addFromUrl(userId: string, url: string, name: string): Promise<Repository>;
  async addFromUpload(userId: string, file: File, name: string): Promise<Repository>;
  async getUserRepositories(userId: string): Promise<Repository[]>;
  async deleteRepository(userId: string, repoId: string): Promise<void>;

  // Sync with Core
  async syncToCore(repoId: string): Promise<void>;
  async refreshFromCore(repoId: string): Promise<void>;
  async pollCoreStatus(repoId: string): Promise<CoreStatus>;
}
```

### 3.2 Author Service

```typescript
// src/lib/services/author-service.ts

export class AuthorService {
  constructor(private db: PrismaClient);

  // Извлечение авторов
  async extractAuthorsFromRepository(repoId: string): Promise<Author[]>;
  async getRepositoryAuthors(repoId: string): Promise<Author[]>;
  async getUserAuthors(userId: string): Promise<Author[]>;
}
```

### 3.3 Developer Service (Deduplication)

```typescript
// src/lib/services/developer-service.ts

export interface DeduplicationResult {
  autoMerged: DeveloperGroup[];     // HIGH confidence
  suggestions: DeveloperGroup[];    // MEDIUM/LOW confidence
  unique: Developer[];              // No matches
}

export class DeveloperService {
  constructor(private db: PrismaClient);

  // Дедупликация
  async runDeduplication(userId: string): Promise<DeduplicationResult>;

  // Маппинг Author → Developer
  async mergeAuthors(userId: string, authorIds: string[], displayName: string): Promise<Developer>;
  async unmergeAuthor(userId: string, authorId: string): Promise<Developer>;
  async excludeAuthor(userId: string, authorId: string): Promise<void>;

  // Settings
  async updateDeveloperSettings(
    userId: string,
    developerId: string,
    settings: DeveloperSettingsUpdate
  ): Promise<UserDeveloper>;

  // Версионность маппинга
  async incrementMappingVersion(userId: string): Promise<number>;
  async getMappingState(userId: string): Promise<UserMappingState>;
}
```

### 3.4 Effort Service

```typescript
// src/lib/services/effort-service.ts

export class EffortService {
  constructor(
    private db: PrismaClient,
    private coreClient: CoreClient,
    private developerService: DeveloperService
  );

  // Запрос effort из Core
  async fetchEffortForRepository(
    repoId: string,
    periods: CorePeriodType[]
  ): Promise<CoreEffort[]>;

  async fetchEffortForAllRepositories(
    userId: string,
    periods: CorePeriodType[]
  ): Promise<CoreEffort[]>;

  // Локальная агрегация
  async aggregateEffortByDeveloper(
    userId: string,
    periodType: CorePeriodType
  ): Promise<AggregatedEffort[]>;
}
```

### 3.5 Metrics Calculation Service

```typescript
// src/lib/services/metrics-service.ts

export class MetricsService {
  constructor(private db: PrismaClient, private effortService: EffortService);

  // Расчёт метрик
  async calculateUserMetrics(userId: string): Promise<UserMetric[]>;

  // Формулы (из дизайн-документа)
  calculateEfficiency(effort: number, workDays: number, share: number): number;
  calculateEffRate(efficiency: number, dailyRate: number): number;
  calculateDeviation(effRate: number, dailyRate: number): number;
  calculateTotalCost(effRate: number, workDays: number): number;

  // Проверка необходимости пересчёта
  async needsRecalculation(userId: string): Promise<boolean>;
  async markRecalculated(userId: string): Promise<void>;
}
```

---

## Фаза 4: API Endpoints

### 4.1 Repositories API

```
POST   /api/repositories          # Добавить репозиторий (URL или GitHub)
POST   /api/repositories/upload   # Загрузить архив
GET    /api/repositories          # Список репозиториев пользователя
GET    /api/repositories/[id]     # Детали репозитория
DELETE /api/repositories/[id]     # Удалить репозиторий
POST   /api/repositories/[id]/sync # Синхронизировать с Core
GET    /api/repositories/[id]/status # Статус обработки в Core
```

### 4.2 Authors API

```
GET    /api/repositories/[id]/authors  # Авторы репозитория
GET    /api/authors                    # Все авторы пользователя
```

### 4.3 Developers API (Deduplication)

```
GET    /api/developers                      # Список разработчиков
GET    /api/developers/deduplication        # Результаты дедупликации
POST   /api/developers/merge                # Объединить авторов
POST   /api/developers/[id]/unmerge         # Разделить Developer
POST   /api/developers/[id]/exclude         # Исключить
PATCH  /api/developers/[id]/settings        # Обновить настройки
```

### 4.4 Metrics API

```
GET    /api/metrics                         # Метрики пользователя
GET    /api/metrics?period=MONTH            # По периоду
POST   /api/metrics/recalculate             # Пересчитать метрики
GET    /api/metrics/status                  # Статус (needsRecalc)
```

---

## Фаза 5: UI Components

### 5.1 Новые компоненты

```
src/components/features/
├── repositories/
│   ├── repository-list.tsx         # Список репозиториев
│   ├── repository-card.tsx         # Карточка репозитория
│   ├── repository-status.tsx       # Статус синхронизации
│   ├── add-repository-dialog.tsx   # Диалог добавления
│   └── upload-repository.tsx       # Загрузка архива
│
├── deduplication/
│   ├── deduplication-page.tsx      # Страница маппинга
│   ├── auto-merged-section.tsx     # Секция HIGH confidence
│   ├── suggestions-section.tsx     # Секция MEDIUM/LOW
│   ├── unique-authors-section.tsx  # Уникальные авторы
│   ├── developer-card.tsx          # Карточка разработчика
│   ├── merge-dialog.tsx            # Диалог ручного мёрджа
│   └── developer-settings.tsx      # Настройки (уровень, ставка)
│
└── analytics/
    ├── metrics-table.tsx           # Таблица метрик
    ├── period-selector.tsx         # Селектор периода
    ├── stale-data-banner.tsx       # Индикатор устаревших данных
    └── recalculate-button.tsx      # Кнопка пересчёта
```

### 5.2 Страницы

```
src/app/(dashboard)/
├── repositories/
│   └── page.tsx                    # Управление репозиториями
│
├── developers/
│   └── page.tsx                    # Маппинг разработчиков
│
└── analytics/
    └── page.tsx                    # Аналитика (метрики)
```

---

## Фаза 6: Cron Jobs

### 6.1 Auto-sync job

```typescript
// src/jobs/auto-sync.ts

/**
 * Запускается раз в неделю
 * 1. Находит репозитории с autoUpdate=true и nextSyncAt <= now()
 * 2. Для каждого:
 *    - Захватывает блокировку (syncInProgress)
 *    - POST /repositories в Core
 *    - Обновляет статусы
 */
export async function runAutoSync(): Promise<void>;
```

### 6.2 Status polling job

```typescript
// src/jobs/poll-core-status.ts

/**
 * Запускается каждые 5 минут
 * 1. Находит репозитории с coreStatus=IN_PROGRESS
 * 2. Проверяет статус в Core
 * 3. Для FINISHED — запрашивает effort
 */
export async function pollCoreStatuses(): Promise<void>;
```

---

## Порядок реализации

### Этап 1: Foundation (MVP-блокирующий)
1. Миграция Prisma схемы (новые модели)
2. Core API client
3. Repository Service + API
4. Author Service + API

### Этап 2: Deduplication (MVP-блокирующий)
5. Developer Service (интеграция существующего deduplication.ts)
6. Developers API
7. Deduplication UI

### Этап 3: Core Integration (MVP-блокирующий)
8. Effort Service
9. Metrics Service
10. Metrics API
11. Analytics UI

### Этап 4: Polish
12. Cron jobs
13. Миграция старых данных
14. Удаление deprecated моделей

---

## Открытые вопросы

1. **Core API URL** — какой endpoint использовать? Нужен env variable.
2. **Webhook vs Polling** — Core поддерживает webhooks? Если да, приоритет webhooks.
3. **Лимиты Core** — rate limits, max repo size, timeout?
4. **Upload формат** — какой формат архива ожидает Core?
