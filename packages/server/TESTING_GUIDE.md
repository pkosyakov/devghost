# Руководство по тестированию Phase 3: UI/UX Enhancement

## Предварительные требования

### 1. Запуск базы данных PostgreSQL
```powershell
# Убедитесь, что PostgreSQL запущен на порту 5433
# Проверка подключения:
psql -h localhost -p 5433 -U postgres -d dea_db -c "SELECT 1"
```

### 2. Применение миграций базы данных
```powershell
cd C:\Projects\AI-Code Audit\prototype
pnpm db:push
pnpm db:generate
```

### 3. Настройка переменных окружения
Проверьте файл `.env.local`:
```env
# Обязательные
DATABASE_URL="postgresql://postgres:password@localhost:5433/dea_db"
AUTH_SECRET="your-secret-key"
AUTH_URL="http://localhost:3000"

# GitHub (для работы с репозиториями)
GITHUB_CLIENT_ID="your-github-client-id"
GITHUB_CLIENT_SECRET="your-github-client-secret"

# AI Providers (минимум один)
OPENROUTER_API_KEY="your-openrouter-key"
# или
ANTHROPIC_API_KEY="your-anthropic-key"
# или
OPENAI_API_KEY="your-openai-key"
# или Ollama (локально, без ключа)
```

### 4. Запуск сервера разработки
```powershell
cd C:\Projects\AI-Code Audit\prototype
pnpm dev
```

Откройте браузер: http://localhost:3000

---

## Тест 1: Компонент выбора настроек анализа

### Шаги:
1. Войдите в систему или зарегистрируйтесь
2. Перейдите в **Orders** → **New Analysis**
3. Подключите GitHub если ещё не подключен (Settings → Connect GitHub)
4. Выберите 1-2 репозитория
5. После выбора репозиториев появится карточка **"Analysis Settings"**

### Что проверить:
- [ ] Карточка показывает текущий провайдер и режим обработки
- [ ] Кнопка "Configure" раскрывает полные настройки
- [ ] Можно выбрать AI Provider из списка (Claude, OpenAI, Ollama, OpenRouter)
- [ ] Для каждого провайдера показывается информация (стоимость, точность, скорость)
- [ ] Можно выбрать Processing Mode (Auto, GitHub API, Local Clone)
- [ ] Переключатель "Advanced Settings" работает
- [ ] В расширенных настройках можно указать:
  - Custom Model
  - Clone Base Path (для LOCAL_CLONE)
  - Enable Caching
  - Max Clone Age (слайдер)

### Ожидаемый результат:
Все настройки сохраняются и передаются при создании заказа.

---

## Тест 2: Создание заказа с настройками AI

### Шаги:
1. Выберите репозитории
2. Настройте AI Provider = "OpenRouter" (или другой)
3. Настройте Processing Mode = "AUTO"
4. Нажмите "Continue"

### Что проверить в базе данных:
```powershell
# Откройте Prisma Studio
pnpm db:studio
```
Найдите созданный Order и проверьте поля:
- [ ] `aiProvider` = "OPENROUTER"
- [ ] `processingMode` = "AUTO"
- [ ] `enableCache` = true
- [ ] `maxCloneAge` = 7 (по умолчанию)

---

## Тест 3: Информационная панель настроек AI

### Шаги:
1. Откройте созданный заказ (Orders → кликните на заказ)
2. Посмотрите на информационную панель под заголовком

### Что проверить:
- [ ] Отображается значок мозга и "AI Provider: OPENROUTER"
- [ ] Отображается значок настроек и "Mode: AUTO"
- [ ] После анализа появляются "Total Effort" и "Avg Quality"

---

## Тест 4: Загрузка разработчиков

### Шаги:
1. На странице заказа нажмите **"Load Developers"**
2. Дождитесь завершения загрузки

### Что проверить:
- [ ] Разработчики загружаются из выбранных репозиториев
- [ ] Отображаются карточки разработчиков
- [ ] Работает функция объединения дубликатов
- [ ] Статус заказа изменился на "Developers Loaded"

---

## Тест 5: Запуск анализа и отслеживание прогресса

### Шаги:
1. После загрузки разработчиков нажмите **"Run Analysis"**
2. Наблюдайте за карточкой прогресса

### Что проверить:
- [ ] Появляется карточка "Analysis Progress" с синей рамкой
- [ ] Отображается прогресс-бар (0% → 100%)
- [ ] Показывается статистика:
  - Total commits
  - Analyzed commits
  - Failed commits
  - ETA (оставшееся время)
- [ ] Отображается текущий анализируемый коммит
- [ ] Кнопка паузы работает (останавливает polling)
- [ ] Кнопка обновления работает
- [ ] После завершения автоматически переключается на вкладку Analytics

### Для проверки API прогресса вручную:
```powershell
# Замените ORDER_ID на реальный ID заказа
curl http://localhost:3000/api/orders/ORDER_ID/progress
```

Ожидаемый ответ:
```json
{
  "success": true,
  "data": {
    "orderId": "...",
    "status": "PROCESSING",
    "totalCommits": 50,
    "analyzedCommits": 25,
    "failedCommits": 0,
    "progress": 50,
    "estimatedTimeRemaining": 120
  }
}
```

---

## Тест 6: Расширенная аналитика

### Шаги:
1. После завершения анализа перейдите на вкладку **Analytics**

### Что проверить:
- [ ] Карточки метрик отображаются в сетке (до 6 колонок):
  - Total Cost ($)
  - Developers (количество)
  - Total Commits
  - AI Effort Estimate (часы) - голубая карточка
  - Avg Quality (оценка /5.0) - цветная карточка
  - Analyzed (дата)
- [ ] Карточка качества меняет цвет:
  - Зелёный: >= 4.0
  - Синий: >= 3.0
  - Жёлтый: < 3.0
- [ ] Bubble Chart работает
- [ ] Таблица метрик разработчиков отображается

---

## Тест 7: Проверка без AI ключей (Ollama)

### Предварительно:
```powershell
# Установите и запустите Ollama
ollama serve
ollama pull deepseek-coder-v2:16b
```

### Шаги:
1. Создайте новый заказ
2. Выберите AI Provider = "Ollama (Local)"
3. Убедитесь, что показывается badge "Privacy"
4. Запустите анализ

### Что проверить:
- [ ] Анализ работает локально без API ключей
- [ ] Скорость зависит от мощности машины

---

## Тест 8: Обработка ошибок

### Тест 8.1: Неверный API ключ
1. Установите неверный OPENROUTER_API_KEY
2. Попробуйте запустить анализ
3. Должна появиться ошибка

### Тест 8.2: Ollama не запущен
1. Выберите Ollama как провайдер
2. Остановите Ollama сервер
3. Попробуйте запустить анализ
4. Должна появиться ошибка "Ollama is not running"

### Что проверить:
- [ ] Ошибки отображаются в красной карточке
- [ ] Статус заказа меняется на "FAILED"
- [ ] Сообщение об ошибке понятное

---

## Тест 9: Компонент AIMetricsDashboard (для разработчиков)

Этот компонент можно протестировать напрямую, добавив его на тестовую страницу:

### Создайте тестовую страницу:
```tsx
// src/app/(dashboard)/test-metrics/page.tsx
'use client';

import { AIMetricsDashboard } from '@/components/ai-metrics-dashboard';

const mockMetrics = {
  totalEffortHours: 156.5,
  averageQualityScore: 4.2,
  averageConfidence: 0.87,
  categoryBreakdown: {
    feature: 45,
    bugfix: 30,
    refactor: 15,
    docs: 5,
    test: 3,
    chore: 2,
  },
  complexityBreakdown: {
    trivial: 10,
    simple: 25,
    moderate: 40,
    complex: 20,
    expert: 5,
  },
  qualityDistribution: [],
  topContributors: [
    { name: 'John Doe', email: 'john@example.com', effort: 50, quality: 4.5 },
    { name: 'Jane Smith', email: 'jane@example.com', effort: 40, quality: 4.2 },
    { name: 'Bob Wilson', email: 'bob@example.com', effort: 30, quality: 3.8 },
  ],
};

export default function TestMetricsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Test AI Metrics Dashboard</h1>
      <AIMetricsDashboard metrics={mockMetrics} />
    </div>
  );
}
```

Откройте: http://localhost:3000/test-metrics

### Что проверить:
- [ ] Карточки Effort Hours и Quality Score
- [ ] Pie Chart категорий
- [ ] Bar Chart сложности
- [ ] Radar Chart разработчиков
- [ ] Таблица топ-контрибьюторов

---

## Чек-лист финального тестирования

### Функциональность:
- [ ] Выбор AI провайдера работает
- [ ] Выбор режима обработки работает
- [ ] Расширенные настройки сохраняются
- [ ] Прогресс анализа отображается в реальном времени
- [ ] Метрики качества и effort отображаются
- [ ] Обработка ошибок работает корректно

### UI/UX:
- [ ] Компоненты адаптивны (mobile/desktop)
- [ ] Цветовая индикация понятна
- [ ] Tooltips отображаются
- [ ] Анимации плавные
- [ ] Загрузка отображается корректно

### Производительность:
- [ ] Polling не создаёт утечек памяти
- [ ] Страницы загружаются быстро
- [ ] Charts рендерятся без лагов

---

## Устранение неполадок

### Проблема: "Failed to fetch progress"
```powershell
# Проверьте, что API роут существует
curl http://localhost:3000/api/orders/test/progress
```

### Проблема: "Prisma client not generated"
```powershell
pnpm db:generate
```

### Проблема: Charts не отображаются
```powershell
# Проверьте установку recharts
pnpm add recharts
```

### Проблема: TypeScript ошибки
```powershell
pnpm build
# Исправьте ошибки из вывода
```
