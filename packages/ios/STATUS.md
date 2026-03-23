# DevGhost iOS App — Development Status

**Date**: 2026-03-06
**Branch**: master
**Status**: Swift code written, needs Xcode project setup + compilation

## What Was Done

### Server-Side (fully implemented, tested, committed)

14 commits covering mobile auth, billing, push, and GitHub OAuth:

1. **Prisma schema** (`98fe957`) — RefreshToken, DeviceToken, AppStoreEvent models; CreditTransactionType extended with IAP_PURCHASE, IAP_SUBSCRIPTION_RENEWAL, IAP_REFUND; appStoreProductId on CreditPack/Subscription; appStoreOriginalTransactionId on UserSubscription
2. **Mobile JWT utils** (`d74aeec`) — `lib/mobile-auth.ts` using `jose` library (HS256, 15 min access, 30 day refresh, bcrypt hash-at-rest). 8 tests passing.
3. **Dual-auth** (`6658c23`) — `requireUserSession()` in `api-utils.ts` checks Bearer JWT first, falls back to NextAuth cookie. All existing endpoints work for both web and iOS.
4. **Mobile login** (`4dc9b9f`) — `POST /api/auth/mobile/login` with device-bound refresh tokens
5. **Mobile refresh** (`9ddb9bb`) — `POST /api/auth/mobile/refresh` with rotation-on-use, reuse detection (revokes ALL tokens on replay)
6. **Mobile logout** (`2831092`) — `POST /api/auth/mobile/logout` revokes all refresh tokens
7. **GitHub PKCE OAuth** (`01ae52d`) — `GET /api/github/mobile/authorize`, `GET /api/github/mobile/callback`, `POST /api/github/mobile/exchange` with S256 PKCE + universal links
8. **iOS billing verify** (`1238806`) — `POST /api/billing/ios-verify` for StoreKit 2 transaction verification (consumable + subscription), AppStoreEvent idempotency
9. **App Store webhook** (`5c27662`) — `POST /api/billing/ios-webhook` for Server Notifications v2 (DID_RENEW, REFUND, REVOKE)
10. **Push notifications** (`11b8a90`) — `POST/DELETE /api/user/device-token`, push service stub with `sendPushToUser()`, `notifyAnalysisComplete()`, `notifyGhostAlert()`

**NOTE**: `pnpm db:generate` needs to be run to regenerate Prisma client after schema changes. On Windows it failed due to file lock — will work on Mac or after restarting processes.

### iOS Swift Code (64 files, ~7400 lines)

All code is in `packages/ios/`. Written on Windows, **not compiled** — needs Xcode project setup and build/fix pass on Mac.

#### Package Structure

```
packages/ios/
├── DevGhost/                           # App target (2 files)
│   ├── DevGhostApp.swift               # @main, creates AuthManager + APIClient
│   └── ContentView.swift               # Auth gate + 5-tab TabView
│
├── Packages/
│   ├── Core/                           # Swift Package (19 files)
│   │   ├── Package.swift               # No external dependencies, iOS 17+
│   │   ├── Sources/
│   │   │   ├── Auth/
│   │   │   │   ├── AuthManager.swift   # @Observable, Keychain token storage
│   │   │   │   └── KeychainService.swift
│   │   │   ├── Constants/
│   │   │   │   └── GhostConstants.swift
│   │   │   ├── Models/                 # 12 model files
│   │   │   │   ├── Order.swift         # Order, OrderListItem, OrderStatus
│   │   │   │   ├── GhostMetric.swift   # GhostMetric, PeriodType
│   │   │   │   ├── User.swift          # User, UserRole
│   │   │   │   ├── BillingModels.swift # Balance, CreditPack, CreditTransaction, etc.
│   │   │   │   ├── GitHubModels.swift  # GitHubRepo, ConnectionStatus, Contributor
│   │   │   │   ├── ExploreModels.swift # PublicRepo, DeveloperProfile, Referral
│   │   │   │   ├── CommitAnalysis.swift
│   │   │   │   ├── DailyEffort.swift
│   │   │   │   ├── DeveloperSettings.swift
│   │   │   │   ├── AnalysisProgress.swift
│   │   │   │   └── AnalysisJobStatus.swift
│   │   │   ├── Networking/
│   │   │   │   ├── APIClient.swift     # Auto-refresh on 401, mutex for concurrent refreshes
│   │   │   │   ├── APIResponse.swift   # Generic APIResponse<T>, APIError enum
│   │   │   │   └── Endpoint.swift      # Path + method + body + queryItems
│   │   │   └── Utils/
│   │   │       └── GhostUtils.swift    # calcGhostPercent, ghostColor, formatGhostPercent
│   │   └── Tests/
│   │       └── GhostUtilsTests.swift   # 6 unit tests
│   │
│   ├── SharedUI/                       # Swift Package (12 files)
│   │   ├── Package.swift               # Depends on Core
│   │   └── Sources/
│   │       ├── Theme/
│   │       │   └── AppTheme.swift      # Colors, Spacing, CornerRadius
│   │       ├── Components/             # 7 reusable views
│   │       │   ├── KPICard.swift
│   │       │   ├── GhostGauge.swift    # Circular gauge with animated trim
│   │       │   ├── StatusBadge.swift   # Color-coded capsule for OrderStatus
│   │       │   ├── LoadingView.swift
│   │       │   ├── ErrorView.swift
│   │       │   ├── EmptyStateView.swift
│   │       │   └── GhostKPICardsView.swift  # 2x2 grid of KPI cards
│   │       └── Charts/                 # 4 Swift Charts views
│   │           ├── GhostBubbleChart.swift
│   │           ├── GhostHeatmap.swift
│   │           ├── EffortTimelineChart.swift
│   │           └── DeveloperDistributionChart.swift
│   │
│   └── Features/                       # Swift Package (26 files)
│       ├── Package.swift               # Depends on Core + SharedUI
│       └── Sources/
│           ├── Auth/
│           │   ├── LoginView.swift     # Email/password + LoginViewModel
│           │   ├── RegisterView.swift  # Name/email/password + auto-login
│           │   └── AuthViewModel.swift # Shared auth coordination
│           ├── Orders/
│           │   ├── OrderListView.swift       # NavigationStack + List + pull-to-refresh
│           │   ├── OrderDetailView.swift      # Tabs: Metrics/Developers/Commits
│           │   ├── OrderCreateView.swift      # 3-step wizard (repos/period/confirm)
│           │   └── OrderRowView.swift         # Reusable order row
│           ├── Metrics/
│           │   ├── MetricsView.swift          # Period selector + KPI cards + charts
│           │   ├── DeveloperListView.swift    # Sortable developer list
│           │   ├── DeveloperDetailView.swift  # Detail + settings sheet (share%, exclude)
│           │   └── CommitListView.swift       # Commit analyses with search
│           ├── Analysis/
│           │   ├── AnalysisProgressView.swift     # Circular progress, status, ETA
│           │   └── AnalysisProgressViewModel.swift # Timer polling every 2s
│           ├── Billing/
│           │   └── BillingDashboardView.swift # Balance, packs, subscriptions, transactions, promo
│           ├── GitHub/
│           │   └── GitHubConnectView.swift    # Connect/disconnect flow
│           ├── Explore/
│           │   ├── ExploreView.swift          # Public repos grid with search
│           │   ├── PublicDashboardView.swift  # Read-only repo metrics
│           │   └── DevProfileView.swift       # Public developer profile
│           ├── Profile/
│           │   ├── ProfileView.swift          # User info + edit + logout
│           │   ├── ReferralView.swift         # Referral code + stats
│           │   └── SettingsView.swift         # Notifications, about
│           └── Admin/
│               ├── AdminDashboardView.swift   # Stats + navigation
│               ├── UserManagementView.swift   # User list with search
│               ├── OrderManagementView.swift  # Order list with admin actions
│               ├── LLMSettingsView.swift      # LLM provider config
│               ├── PromoCodesView.swift       # Promo code management
│               ├── MonitoringView.swift       # System health + active jobs
│               └── AuditLogView.swift         # Searchable audit log
```

## Setup Instructions for Mac

### 1. Regenerate Prisma Client
```bash
cd packages/server
pnpm db:generate
```

### 2. Create Xcode Project
1. Open Xcode 16+
2. File > New > Project > iOS > App
3. Product Name: `DevGhost`
4. Language: Swift, Interface: SwiftUI
5. Save at `packages/ios/` (replace scaffold files with existing DevGhostApp.swift and ContentView.swift)

### 3. Add Local Swift Packages
In Xcode project settings:
1. File > Add Package Dependencies > Add Local > select `packages/ios/Packages/Core`
2. Repeat for `SharedUI` and `Features`
3. In target "DevGhost" > General > Frameworks: add Core, SharedUI, Features

### 4. Configure Base URL
In `DevGhostApp.swift`, the `APIClient` is initialized without a baseURL parameter — add it:
```swift
// For local dev:
_apiClient = State(initialValue: APIClient(
    baseURL: URL(string: "http://localhost:3000")!,
    authManager: auth
))
```

### 5. Build & Fix
Code review was performed and 27 critical issues were fixed (commit `57200af`).
Second pass fixed High/Medium issues:
- **@MainActor** — all 21 ViewModels annotated with `@MainActor` for safe UI state mutation from async contexts.
- **APIClient concurrency** — replaced `isRefreshing` flag with actor-based `TokenRefreshCoordinator` for safe concurrent token refresh.
- **Server-side logout** — `ProfileView.logout()` and `AuthViewModel.signOut()` now call `POST /api/auth/mobile/logout` before clearing local tokens.
- **Admin views** — added 4 missing views: `LLMSettingsView`, `PromoCodesView`, `MonitoringView`, `AuditLogView`.
- **@Environment fix** — removed invalid `@Environment(APIClient.self)` from `ProfileView`, uses stored property instead.

Remaining issues that may surface during compilation:
- **@Sendable closures** — some async closures may need explicit `@Sendable` annotation under strict concurrency.
- **StoreKit 2** — `BillingDashboardView` has placeholder purchase flow. Implement real `StoreKit.Product.purchase()` when ready.
- **GitHub OAuth** — `GitHubConnectView` has placeholder for `ASWebAuthenticationSession`. Wire up to `/api/github/mobile/authorize` endpoint.

### 6. Universal Links (for GitHub OAuth callback)
1. Add Associated Domains capability: `applinks:yourdomain.com`
2. Host `apple-app-site-association` at `https://yourdomain.com/.well-known/apple-app-site-association`
3. Handle `/api/github/mobile/callback` deep link in app

### 7. Push Notifications
1. Enable Push Notifications capability in Xcode
2. Create APNs key in Apple Developer portal
3. Configure server with APNs credentials (currently stub in `push-notification-service.ts`)

## Architecture Decisions

- **iOS 17+** minimum — enables @Observable, Swift Charts, StoreKit 2
- **MVVM** — @Observable ViewModels, no Combine
- **3 Swift Packages**: Core (no deps) > SharedUI (depends Core) > Features (depends both) > App target
- **Dual-auth** — server accepts both Bearer JWT (iOS) and NextAuth cookie (web)
- **Refresh token security** — bcrypt hash-at-rest, rotation-on-use, reuse detection, device binding
- **Timer polling** for analysis progress (not SSE — simpler on iOS)
- **Keychain** for tokens, no sensitive data in UserDefaults

## Design Documents

- `docs/plans/2026-03-05-ios-app-design.md` — full design with all sections
- `docs/plans/2026-03-05-ios-app-implementation.md` — 30+ task implementation plan

## What's NOT Implemented Yet

1. **StoreKit 2 integration** — purchase flow is placeholder, needs real Product IDs and StoreKit configuration
2. **ASWebAuthenticationSession** — GitHub OAuth trigger is placeholder
3. **APNs** — server has stub, iOS has no push registration code yet
4. **Offline caching** — no SwiftData/CoreData persistence
5. **Deep linking** — universal link handling not wired
6. **App icon, launch screen, assets** — no design assets
7. **Localization** — all strings hardcoded in English
8. **Accessibility** — basic VoiceOver from SwiftUI, no custom accessibilityLabel/Hint
9. **iPad layout** — single-column only, no adaptive layout
10. **Widget / Live Activity** — not started
