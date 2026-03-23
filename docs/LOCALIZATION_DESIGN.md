# Проектирование системы локализации DevGhost

## 1. Обзор

Система локализации (i18n) для платформы DevGhost — монорепозитория с Next.js 16 App Router, React 19 и TypeScript. Цель: поддержка нескольких языков интерфейса без дублирования логики и с сохранением type-safety.

---

## 2. Технический стек и выбор решения

### 2.1 Рекомендуемая библиотека: **next-intl**

| Критерий | next-intl | react-i18next | next-i18next |
|----------|-----------|---------------|---------------|
| App Router | ✅ Нативная поддержка | ⚠️ Требует обходных путей | ❌ Pages Router |
| Server Components | ✅ `getTranslations()` | ⚠️ Ограничено | ❌ |
| Bundle size | ~2 KB | ~8 KB+ | ~8 KB+ |
| TypeScript | ✅ Полная типизация | ⚠️ Частичная | ⚠️ |
| ICU MessageFormat | ✅ | ✅ | ✅ |
| Роутинг по locale | ✅ Middleware | Ручная реализация | Встроен |

**Вывод:** next-intl — оптимальный выбор для Next.js 16 App Router.

### 2.2 Поддерживаемые языки (MVP)

- **en** — English (по умолчанию)
- **ru** — Русский
- **uk** — Українська (опционально на втором этапе)

### 2.3 Совместимость с Next.js 16

- **Перед стартом:** проверить актуальную версию next-intl на [npmjs.com](https://www.npmjs.com/package/next-intl) и зафиксировать в проекте
- Peer dependency next-intl: `^12.0.0 || ^13.0.0 || ^14.0.0 || ^15.0.0 || ^16.0.0` для Next.js
- Версии 3.x — стабильная ветка; 4.x — если доступна, включает фиксы для Next.js 16 и `use cache`
- Убедиться в совместимости с `next@16.1.0` в тестовом окружении

---

## 3. Архитектура

### 3.1 Стратегия роутинга

**Рекомендация:** `localePrefix: 'as-needed'` — URL без префикса для дефолтного языка, с префиксом для остальных.

```
/                    → en (дефолт)
/dashboard           → en
/ru/dashboard        → ru
/ru/orders/123       → ru
```

**Преимущества:**
- Короткие URL для основной аудитории (en)
- SEO-friendly для каждого языка
- Прямые ссылки на локализованные страницы

**Альтернатива:** `localePrefix: 'never'` + cookie — locale без изменения URL. Подходит, если не нужен SEO для разных языков.

### 3.2 Структура файлов

```
packages/server/
├── messages/
│   ├── en.json
│   ├── ru.json
│   └── uk.json
├── next.config.mjs             # ESM (createNextIntlPlugin требует ESM)
├── src/
│   ├── i18n/
│   │   ├── request.ts          # getRequestConfig для next-intl
│   │   ├── routing.ts          # routing config для middleware + createNavigation
│   │   └── navigation.ts       # Link, redirect, useRouter, usePathname (createNavigation)
│   ├── app/
│   │   ├── [locale]/           # Динамический сегмент
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   ├── (auth)/
│   │   │   ├── (dashboard)/
│   │   │   └── (public)/
│   │   └── api/                # API без префикса locale
│   └── middleware.ts           # next-intl + NextAuth (или proxy.ts в Next.js 16)
│
packages/shared/
└── src/
    └── i18n-keys.ts            # Опционально: ключи для shared-логики
```

**Примечание:** Текущий `next.config.js` использует CommonJS (`module.exports`). `createNextIntlPlugin()` обычно используется с ESM. Потребуется конвертация в `next.config.mjs` или `next.config.ts`.

### 3.2.1 Содержимое routing.ts

```typescript
// src/i18n/routing.ts
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  alternateLinks: true,  // hreflang для SEO
});

// Re-export для middleware
export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;
```

### 3.2.2 Содержимое request.ts

```typescript
// src/i18n/request.ts
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale ?? '';
  const locale = routing.locales.includes(requested) ? requested : routing.defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

Валидация `locale` обязательна: невалидное значение может привести к падению dynamic import или path traversal. Путь `../../messages` — от `src/i18n/request.ts` к `packages/server/messages/`.

### 3.3 Type safety для ключей переводов

Проект использует strict TypeScript. next-intl поддерживает типизацию ключей — autocompletion для `t('...')` и ошибки при опечатках:

```typescript
// global.d.ts или src/types/next-intl.d.ts
// Путь к messages зависит от расположения файла: src/types/ → ../../../messages/en.json, корень packages/server/ → ./messages/en.json
import type en from '../messages/en.json';
type Messages = typeof en;
declare global {
  interface IntlMessages extends Messages {}
}
```

После настройки `t('landing.hero.title')` будет типизирован, `t('landing.hero.typo')` — ошибка компиляции.

### 3.4 Организация JSON-сообщений

Иерархия по доменам и компонентам:

```json
{
  "common": {
    "loading": "Loading...",
    "error": "Something went wrong",
    "save": "Save",
    "cancel": "Cancel"
  },
  "layout": {
    "header": {
      "signIn": "Sign in",
      "getStarted": "Get started"
    },
    "sidebar": {
      "dashboard": "Dashboard",
      "orders": "Orders",
      "publications": "Publications"
    }
  },
  "landing": {
    "hero": {
      "title": "Measure real developer {productivity}",
      "productivity": "productivity",
      "description": "Analyze Git repositories...",
      "features": "Features"
    }
  },
  "auth": {
    "login": { "title": "Sign in", ... },
    "register": { "title": "Create account", ... }
  },
  "dashboard": { ... },
  "orders": { ... },
  "billing": { ... },
  "errors": {
    "unauthorized": "Unauthorized",
    "orderNotFound": "Order not found",
    "invalidPeriod": "Invalid period"
  },
  "status": {
    "COMPLETED": "Completed",
    "PROCESSING": "Processing",
    "FAILED": "Failed",
    "DRAFT": "Draft"
  },
  "ghost": {
    "thresholds": {
      "EXCELLENT": "Excellent",
      "GOOD": "Good",
      "WARNING": "Warning",
      "LOW": "Low"
    }
  }
}
```

---

## 4. Интеграция компонентов

### 4.1 Server Components

```tsx
import { getTranslations } from 'next-intl/server';

export default async function LandingPage() {
  const t = await getTranslations('landing.hero');
  return <h1>{t('title', { productivity: t('productivity') })}</h1>;
}
```

### 4.2 Client Components

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

export function Sidebar() {
  const t = useTranslations('layout.sidebar');
  return <Link href="/dashboard">{t('dashboard')}</Link>;
}
```

### 4.3 Форматирование дат и чисел

**Client Components** — `useFormatter()` (хук):

```tsx
'use client';
import { useFormatter } from 'next-intl';

function DateDisplay({ date }: { date: Date }) {
  const format = useFormatter();
  return <span>{format.dateTime(date, { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>;
}
```

**Server Components** — `getFormatter()` из `next-intl/server`:

```tsx
import { getFormatter } from 'next-intl/server';

export default async function ServerDateDisplay({ date }: { date: Date }) {
  const format = await getFormatter();
  return <span>{format.dateTime(date, { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>;
}
```

`useFormatter()` — хук, работает только в Client Components. Для Server Components использовать `getFormatter()`.

### 4.4 Метаданные

В Next.js 16 App Router `params` стал async:

```tsx
// app/[locale]/layout.tsx
import { getTranslations } from 'next-intl/server';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'metadata' });
  return {
    title: t('title'),
    description: t('description'),
  };
}
```

### 4.5 Миграция Navigation API (критический блок)

next-intl требует замены `next/navigation` и `next/link` на locale-aware API. Это **самый объёмный блок работы** (~40% миграции).

**Создать `src/i18n/navigation.ts`:**

```typescript
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
```

**Замены импортов:**

| Было | Стало |
|------|-------|
| `import Link from 'next/link'` | `import { Link } from '@/i18n/navigation'` |
| `import { useRouter } from 'next/navigation'` | `import { useRouter } from '@/i18n/navigation'` |
| `import { usePathname } from 'next/navigation'` | `import { usePathname } from '@/i18n/navigation'` |
| `import { redirect } from 'next/navigation'` | `import { redirect } from '@/i18n/navigation'` |

**Файлы для миграции** (по текущей кодовой базе):

- `layout/sidebar.tsx` — Link, usePathname
- `layout/header.tsx` — Link, useRouter
- `app/page.tsx` — Link
- `app/(auth)/login/page.tsx` — Link, useRouter
- `app/(auth)/register/page.tsx` — Link, useRouter
- `app/(dashboard)/orders/page.tsx` — Link, useRouter
- `app/(dashboard)/orders/[id]/page.tsx` — Link, useRouter
- `app/(dashboard)/orders/[id]/developers/[email]/page.tsx` — useRouter
- `app/(dashboard)/orders/new/page.tsx` — useRouter
- `app/(dashboard)/demo/page.tsx` — useRouter
- `app/(dashboard)/dashboard/page.tsx` — Link
- `app/(dashboard)/admin/orders/page.tsx` — Link
- `app/(dashboard)/admin/layout.tsx` — redirect
- `app/(public)/layout.tsx` — Link
- `components/ghost-developer-table.tsx` — Link
- `components/repo-card.tsx` — Link
- и др. (~20+ файлов)

**Важно:** `redirect` из next-intl принимает `pathname` (не `href`). Locale определяется автоматически из контекста:

```tsx
import { redirect } from '@/i18n/navigation';

// В Server Component — locale из контекста
if (!userId) return redirect('/login');

// Для явного указания locale (при реализации сверить с API next-intl версии — может быть второй аргумент: redirect({ pathname: '/login' }, { locale: 'ru' }))
if (!userId) return redirect({ pathname: '/login', locale: 'ru' });
```

---

## 5. API и сообщения об ошибках

### 5.1 Стратегия

API возвращает **коды ошибок** (ключи), а клиент переводит их:

```typescript
// api-utils.ts
export function apiError(messageKey: string, status: number = 400) {
  return NextResponse.json({ success: false, error: messageKey }, { status });
}

// Использование
return apiError('errors.orderNotFound', 404);
```

**Важно:** Не только `apiError()`, но и хелперы, возвращающие сырые строки:

- `getOrderWithAuth()` — возвращает `{ success: false, error: 'Unauthorized' | 'Order not found', status }` — заменить на ключи `errors.unauthorized`, `errors.orderNotFound`
- `requireUserSession()`, `requireAdmin()` — уже используют `apiError()`, перевести на ключи
- `validateDateRange()` — возвращает `{ valid: false, error: 'Invalid date format' | 'Start date must be before end date' }` — заменить на ключи
- `orderAuthError(result)` — проксирует `result.error`, должен получать уже ключи

```tsx
// Клиент
const { error } = await apiResponse.json();
const t = useTranslations('errors');
// t(error) || error не работает: в dev next-intl бросает при отсутствии ключа, в prod возвращает ключ (truthy)
const message = t.has(error) ? t(error) : error;
```

Альтернатива: настроить `onError` в getRequestConfig для подавления ошибок на отсутствующие ключи.

### 5.2 Параметризованные ошибки

Для ошибок с параметрами (например, `Invalid repository format: ${repos}`) — два варианта:

1. **Ключ + params в JSON:**
   ```json
   { "error": "errors.invalidRepoFormat", "params": { "repos": "owner/repo" } }
   ```

2. **Отдельные ключи для типовых случаев:**
   ```json
   "errors": {
     "invalidRepoFormat": "Invalid repository format. Expected owner/repo",
     "reposRequired": "repos parameter is required"
   }
   ```

Рекомендация: второй вариант — проще для переводчиков и без риска XSS.

---

## 6. Middleware

**Примечание о Next.js 16:** В Next.js 16.1.0 файл `middleware.ts` работает штатно. Переименование в `proxy.ts` — экспериментальная/canary фича; при реализации проверить актуальную документацию Next.js. Если проект уже на proxy.ts — следовать новой конвенции.

### 6.1 Объединение next-intl и NextAuth v5

**Проблема:** NextAuth v5 возвращает `{ auth }` — это middleware-функция, а не callable. Правильный подход: вызывать `intlMiddleware` первым, затем проверять сессию через `auth()` **только для protected/auth путей** (иначе DB lookup на каждый запрос landing/explore). При редиректах — сохранять locale в URL и копировать cookies/headers из `intlResponse`, иначе пользователь на `/ru/admin` улетит на `/dashboard` (en).

```typescript
// middleware.ts
import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { routing } from '@/i18n/routing';

const intlMiddleware = createMiddleware(routing);

/** Стриппит locale prefix для проверки protected paths */
function getPathnameWithoutLocale(pathname: string, locales: string[]): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) {
    return '/' + segments.slice(1).join('/');
  }
  return pathname;
}

/** Извлекает текущий locale из pathname */
function getLocaleFromPath(pathname: string, locales: string[]): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) {
    return segments[0];
  }
  return routing.defaultLocale;
}

/** Строит path с учётом localePrefix: as-needed (en без префикса, ru с /ru) */
function buildLocalizedPath(path: string, locale: string): string {
  if (locale === routing.defaultLocale) return path;
  return `/${locale}${path}`;
}

const PROTECTED_PREFIXES = ['/dashboard', '/orders', '/demo', '/settings', '/admin', '/billing', '/publications', '/profile'];

function redirectWithIntlHeaders(intlResponse: NextResponse, url: string): NextResponse {
  const res = NextResponse.redirect(url);
  // Копируем Set-Cookie и другие headers из intlResponse, чтобы locale-cookie сохранился.
  // append() вместо set() — может быть несколько Set-Cookie записей. set() перезаписывает.
  intlResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie' || key.toLowerCase().startsWith('x-next-intl')) {
      res.headers.append(key, value);
    }
  });
  return res;
}

export default async function middleware(req: NextRequest) {
  const intlResponse = intlMiddleware(req);
  const pathnameWithoutLocale = getPathnameWithoutLocale(req.nextUrl.pathname, routing.locales);
  const isProtected = PROTECTED_PREFIXES.some((p) => pathnameWithoutLocale.startsWith(p));
  const isAuthPage = pathnameWithoutLocale === '/login' || pathnameWithoutLocale === '/register';

  // auth() только для protected/auth путей — иначе DB lookup на каждый запрос landing/explore
  if (isProtected || isAuthPage) {
    const session = await auth();
    const locale = getLocaleFromPath(req.nextUrl.pathname, routing.locales);

    if (isProtected && !session?.user) {
      const signInPath = buildLocalizedPath('/login', locale);
      const signInUrl = new URL(signInPath, req.url);
      signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
      return redirectWithIntlHeaders(intlResponse, signInUrl.toString());
    }

    if (session?.user && pathnameWithoutLocale.startsWith('/admin')) {
      if ((session.user as { role?: string }).role !== 'ADMIN') {
        const dashboardPath = buildLocalizedPath('/dashboard', locale);
        return redirectWithIntlHeaders(intlResponse, new URL(dashboardPath, req.url).toString());
      }
    }

    if (session?.user && isAuthPage) {
      const dashboardPath = buildLocalizedPath('/dashboard', locale);
      return redirectWithIntlHeaders(intlResponse, new URL(dashboardPath, req.url).toString());
    }
  }

  return intlResponse;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
```

### 6.2 Обновление auth.config.ts

Текущий `auth.config.ts` проверяет `nextUrl.pathname.startsWith('/dashboard')`. С `localePrefix: 'as-needed'` путь будет `/ru/dashboard` — проверка не сработает.

**Варианты:**
1. **Перенести логику в middleware** (рекомендуется) — как в секции 6.1, с `getPathnameWithoutLocale`.
2. **Оставить auth.config только для NextAuth** — если middleware полностью берёт на себя редиректы, `authorized` callback в auth.config может быть упрощён или отключён для middleware (auth проверяется в API через `auth()`).

Файлы для обновления: `src/lib/auth.config.ts`, `middleware.ts`.

---

## 7. Миграция существующего кода

### 7.1 Фазы внедрения

| Фаза | Объём | Описание |
|------|-------|----------|
| 1 | Инфраструктура | Установка next-intl, config, middleware, [locale] |
| 2 | Layout | Sidebar, header, footer, общие компоненты |
| 3 | Landing + Auth | Главная, страницы логина/регистрации |
| 4 | Dashboard | Dashboard, orders, profile, publications |
| 5 | Admin | Админ-панель |
| 6 | API errors | Переход на ключи в apiError |
| 7 | Форматирование | formatDate, formatRelativeTime → useFormatter |

### 7.2 Утилиты (lib/utils.ts)

Текущие утилиты:
- `formatDate` — хардкод `ru-RU` (utils.ts:8-15)
- `formatRelativeTime` — хардкод английских строк: `'just now'`, `'m ago'`, `'h ago'`, `'d ago'`, `'w ago'`, `'mo ago'`, `'y ago'` (utils.ts:34-53)

Варианты миграции:

1. **Создать `locale-aware` обёртки** (для использования вне React):
   ```ts
   // lib/format.ts
   export function createFormatters(locale: string) {
     return {
       date: (d: Date) => d.toLocaleDateString(locale, { ... }),
       relativeTime: (d: Date) => { /* Intl.RelativeTimeFormat */ },
     };
   }
   ```

2. **Использовать в компонентах `useFormatter()` / `getFormatter()`** — предпочтительно, т.к. next-intl уже даёт locale и `format.relativeTime()`.

### 7.3 Маппинг enum → i18n

Статусы заказов (OrderStatus: COMPLETED, PROCESSING, FAILED, DRAFT, …) и Ghost thresholds (EXCELLENT, GOOD, WARNING, LOW) хранятся как enum/константы. Лейблы для UI — через messages:

```tsx
// Компонент
const t = useTranslations('status');
<span>{t(order.status)}</span>  // order.status = 'COMPLETED' → t('COMPLETED') → "Completed"

const tGhost = useTranslations('ghost.thresholds');
<span>{tGhost(thresholdKey)}</span>  // thresholdKey = 'EXCELLENT' → "Excellent"
```

Ключи в messages должны совпадать с enum значениями: `status.COMPLETED`, `ghost.thresholds.EXCELLENT`.

### 7.4 generateStaticParams и setRequestLocale

Для статической генерации (SSG/ISR) в layout `[locale]` нужны:

1. **generateStaticParams** — возвращает все locale для предгенерации:
   ```tsx
   export function generateStaticParams() {
     return routing.locales.map((locale) => ({ locale }));
   }
   ```

2. **setRequestLocale(locale)** — обязательно вызывать в каждом layout и page, использующем переводы. Без этого `getTranslations()` в статически сгенерированных страницах не знает текущий locale (next-intl использует `headers()`, что помечает маршрут как dynamic; `setRequestLocale` снимает эту зависимость):

   ```tsx
   import { setRequestLocale } from 'next-intl/server';

   export default async function LocaleLayout({ children, params }) {
     const { locale } = await params;
     setRequestLocale(locale);
     // ...
   }
   ```

   Вызывать в каждом layout и page, где нужны переводы. Только в layout недостаточно из‑за race conditions.

### 7.5 Shared package

`@devghost/shared` содержит константы Ghost (EXCELLENT, GOOD, WARNING, LOW). Эти значения — ключи для UI. Лейблы берутся из `messages.ghost.thresholds`.

---

## 8. Переключатель языка и инфраструктура

### 8.1 Компонент LanguageSwitcher

Использовать **next-intl navigation API** — `usePathname` и `useRouter` из `@/i18n/navigation` корректно обрабатывают locale. Ручное построение URL через regex (`pathname.replace(/^\/[a-z]{2}/, '')`) хрупко и ломается на путях вроде `/dev/uk-developer`.

```tsx
// components/language-switcher.tsx
'use client';
import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';

export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const switchLocale = (newLocale: string) => {
    router.replace(pathname, { locale: newLocale });
  };

  return (
    <Select value={locale} onValueChange={switchLocale}>
      <SelectItem value="en">English</SelectItem>
      <SelectItem value="ru">Русский</SelectItem>
    </Select>
  );
}
```

### 8.2 Сохранение preference

- Cookie `NEXT_LOCALE` (next-intl по умолчанию)
- Или User.preferredLocale в БД — для залогиненных пользователей

### 8.3 SEO: hreflang и alternate links

Для публичных страниц (`/explore`, `/share`, `/dev`) hreflang критичен для SEO.

**alternateLinks в routing** — добавляет HTTP-заголовки `Link` в response (не HTML-теги). Для полноценного SEO поисковики предпочитают HTML `<link rel="alternate" hreflang="...">` — их нужно добавлять через `generateMetadata` или вручную в layout:

```typescript
// routing.ts
alternateLinks: true,  // HTTP Link headers
```

```tsx
// generateMetadata — HTML <link rel="alternate" hreflang="..."> для SEO
import { getPathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const pathname = '/explore';  // или текущий path
  return {
    alternates: {
      languages: Object.fromEntries(
        routing.locales.map((loc) => [
          loc,
          getPathname({ locale: loc, href: pathname }),
        ])
      ),
    },
  };
}
```

### 8.4 Порядок Providers и загрузка messages

Текущий `layout.tsx` оборачивает children в `<Providers>`. `NextIntlClientProvider` должен быть выше. **Messages** загружаются через `getRequestConfig()` в `i18n/request.ts`, а в layout — через `getMessages()` (не dynamic import):

См. секцию 3.2.2 для полного содержимого `request.ts` (включая валидацию locale).

```tsx
// app/[locale]/layout.tsx
import { getMessages, setRequestLocale } from 'next-intl/server';
import { NextIntlClientProvider } from 'next-intl';
import { routing } from '@/i18n/routing';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

Рекомендуемый порядок: NextIntlClientProvider → SessionProvider → QueryClientProvider → TooltipProvider → children.

---

## 9. Специфика DevGhost

### 9.1 Публичные vs защищённые маршруты

- **Публичные:** `/`, `/explore`, `/share/[token]`, `/dev/[slug]` — locale в URL
- **Защищённые:** `/dashboard`, `/orders`, `/admin` — locale в URL

### 9.2 LLM-ответы

Ответы LLM (reasoning, summary) — на языке модели. Для их локализации потребуется отдельный LLM-вызов или post-processing — выносить за рамки MVP.

### 9.3 Modal (Python)

Пакет `modal` — Python. Логи и сообщения пользователю идут через API. Локализация — только на стороне сервера (Next.js), Modal остаётся на en.

---

## 10. Чеклист внедрения

**Инфраструктура**
- [ ] `pnpm add next-intl` в packages/server
- [ ] Конвертировать `next.config.js` → `next.config.mjs` (ESM)
- [ ] Создать `src/i18n/request.ts`, `routing.ts`, `navigation.ts`
- [ ] Добавить `createNextIntlPlugin()` в next.config
- [ ] Настроить `getRequestConfig()` в `i18n/request.ts` для загрузки messages
- [ ] Обернуть app в `[locale]`, перенести layout/page
- [ ] Добавить `generateStaticParams` и `setRequestLocale` в `[locale]/layout.tsx` (секция 7.4, 8.4)
- [ ] Обновить middleware (next-intl + auth, locale в redirects, auth только для protected, секция 6.1)
- [ ] Обновить `auth.config.ts` (locale-aware paths или перенос логики в middleware)
- [ ] Обернуть layout в `NextIntlClientProvider`, загрузка messages через `getMessages()` (секция 8.4)
- [ ] Включить `alternateLinks: true` в routing; при необходимости добавить HTML hreflang в generateMetadata (секция 8.3)

**Navigation API (критический блок)**
- [ ] Мигрировать все `Link` → `@/i18n/navigation`
- [ ] Мигрировать все `useRouter`, `usePathname`, `redirect` → `@/i18n/navigation`
- [ ] Обновить `layout/sidebar.tsx`, `layout/header.tsx`
- [ ] Обновить страницы: landing, auth, dashboard, orders, admin, public layout

**Контент и форматирование**
- [ ] Создать `messages/en.json` с базовой структурой
- [ ] Добавить `messages/ru.json` (минимум)
- [ ] Мигрировать layout, landing, auth pages
- [ ] Мигрировать dashboard, orders, admin
- [ ] Добавить `LanguageSwitcher` в header/footer
- [ ] Заменить `formatDate`/`formatRelativeTime` на `useFormatter`/`getFormatter`
- [ ] Добавить `generateMetadata` с переводами (params async)
- [ ] Настроить `IntlMessages` для type-safe ключей (секция 3.3)

**API**
- [ ] Ввести `apiError(key, status)` и ключи в errors
- [ ] Обновить `getOrderWithAuth`, `validateDateRange`, `orderAuthError` на ключи
- [ ] Обновить ~65 API route файлов, возвращающих error strings

---

## 11. Оценка трудозатрат

| Задача | Часы |
|--------|------|
| Инфраструктура + middleware + auth.config | 2–3 |
| next.config ESM, createNavigation, routing | 1–2 |
| **Navigation API миграция** (20+ файлов: Link, useRouter, usePathname, redirect) | **8–12** |
| Структура messages + en.json | 2–3 |
| Миграция layout, landing, auth | 3–4 |
| Миграция dashboard + orders | 4–6 |
| Миграция admin | 2–3 |
| API errors (api-utils + ~65 route files) | 3–5 |
| Форматирование дат/чисел (formatDate, formatRelativeTime) | 1–2 |
| ru.json перевод | 1–2 |
| generateStaticParams, setRequestLocale, hreflang, providers, getMessages | 1–2 |
| Тестирование | 2–4 |
| **Итого** | **~30–47 ч** |

Оценка 17–27 ч была оптимистична. С учётом Navigation API миграции, исправления middleware и обновления 65 API route файлов реалистичнее **30–45 часов**.

---

## 12. Ссылки

- [next-intl docs](https://next-intl.dev/docs/getting-started/app-router)
- [next-intl routing](https://next-intl.dev/docs/routing)
- [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
