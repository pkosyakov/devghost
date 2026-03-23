# DevGhost iOS App — Design Document

**Date**: 2026-03-05
**Status**: Approved
**Stack**: Swift UI, iOS 17+, MVVM + @Observable, Swift Packages

## Decisions

- **Platform**: Native iOS (Swift UI), not React Native/Flutter
- **Scope**: Full feature parity with web, implemented in 6 phases
- **Architecture**: Modular MVVM via Swift Packages (Core / Features / SharedUI)
- **Billing**: StoreKit 2 (IAP) — consumable credit packs + auto-renewable subscriptions
- **Design**: Apple-native (NavigationStack, TabView, List, SF Symbols, system colors)
- **Min iOS**: 17+ (~90% devices, enables @Observable, Swift Charts, StoreKit 2)
- **Auth**: Custom mobile JWT flow (access + refresh tokens, Keychain storage)
- **Charts**: Swift Charts (native framework)
- **Push**: APNs (native, not Expo)

## 1. Project Structure

```
packages/ios/
├── DevGhost.xcodeproj
├── DevGhost/                    # Main App target
│   ├── DevGhostApp.swift        # @main, dependency injection
│   ├── ContentView.swift        # Root TabView
│   └── Info.plist
│
├── Packages/
│   ├── Core/                    # Swift Package
│   │   ├── Models/              # Swift structs: Order, GhostMetric, User, etc.
│   │   ├── Networking/          # APIClient (URLSession), endpoints, auth interceptor
│   │   ├── Auth/                # AuthManager (@Observable), Keychain token storage
│   │   ├── Storage/             # UserDefaults wrappers, Keychain service
│   │   └── Constants/           # Ghost norm, thresholds (port from @devghost/shared)
│   │
│   ├── Features/                # Swift Package, depends on Core
│   │   ├── Orders/              # OrderListView, OrderDetailView, OrderCreateView
│   │   ├── Metrics/             # GhostKPIView, DeveloperListView, ChartsView
│   │   ├── Analysis/            # AnalysisProgressView (polling), PipelineLogView
│   │   ├── Billing/             # BalanceView, CreditPacksView, StoreKit manager
│   │   ├── GitHub/              # GitHubConnectView, RepoPickerView
│   │   ├── Explore/             # ExploreGridView, PublicDashboardView
│   │   ├── Profile/             # ProfileView, SettingsView
│   │   ├── Share/               # ShareView (by share-token), DevProfileView
│   │   ├── Admin/               # AdminDashboardView (role=ADMIN only)
│   │   └── Auth/                # LoginView, RegisterView
│   │
│   └── SharedUI/                # Swift Package
│       ├── Theme/               # Colors, Typography, Spacing
│       ├── Components/          # GhostGauge, StatusBadge, KPICard, LoadingView
│       └── Charts/              # GhostBubbleChart, HeatmapView (Swift Charts)
```

**Dependencies**: `DevGhost App` → `Features` → `Core` + `SharedUI`. Core has zero internal dependencies.

## 2. Navigation

### Tab Structure

```
┌─────────────────────────────────────────────┐
│  Orders  │  Explore  │  Billing  │  Profile  │  Admin* │
└─────────────────────────────────────────────┘
```
*Admin tab visible only for role=ADMIN*

### Tab 1 — Orders (main flow)

```
OrderListView (order list with KPI preview)
  └→ OrderDetailView (tabs: Metrics / Developers / Commits)
       ├→ MetricsView (KPI cards + charts + period selector)
       ├→ DeveloperListView (per-developer Ghost% + drill-down)
       │    └→ DeveloperDetailView (effort timeline, daily effort)
       ├→ CommitListView (commits with LLM estimates)
       └→ DeveloperSettingsSheet (share%, exclude)
  └→ OrderCreateView (wizard)
       ├→ Step 1: RepoPickerView (GitHub repos, search, public)
       ├→ Step 2: PeriodConfigView (ALL_TIME / years / date range / last N)
       └→ Step 3: ConfirmView → start analysis
  └→ AnalysisProgressView (polling /progress, pipeline log)
```

### Tab 2 — Explore

```
ExploreGridView (public repos, search, featured)
  └→ PublicDashboardView (read-only metrics)
  └→ DevProfileView (public developer profile)
```

### Tab 3 — Billing

```
BillingDashboardView
  ├→ BalanceCard (available / permanent / subscription credits)
  ├→ CreditPacksView (StoreKit 2 IAP)
  ├→ SubscriptionView (StoreKit 2 auto-renewable)
  ├→ TransactionHistoryView (paginated list)
  └→ PromoRedeemSheet
```

### Tab 4 — Profile

```
ProfileView
  ├→ GitHubConnectView (OAuth via ASWebAuthenticationSession)
  ├→ ReferralView (code, stats, invited users)
  ├→ PublicationsView (manage publications)
  └→ SettingsView (notifications, about)
```

### Tab 5 — Admin (role=ADMIN)

```
AdminDashboardView (stats)
  ├→ UserManagementView
  ├→ OrderManagementView
  ├→ LLMSettingsView
  ├→ PromoCodesView
  ├→ MonitoringView
  └→ AuditLogView
```

**Modal screens**: ShareSheet (native), LoginView/RegisterView (full-screen cover before auth).

## 3. Networking & Authentication

### APIClient

Single client on `URLSession` with async/await:

```swift
struct APIResponse<T: Decodable>: Decodable {
    let success: Bool
    let data: T?
    let error: String?
}

@Observable class APIClient {
    private let session: URLSession
    private let baseURL: URL
    private let authManager: AuthManager

    func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T
}
```

### Mobile Auth Flow

**Server-side dual-auth in `requireUserSession`** (Critical Fix #1):

The server's `requireUserSession()` currently uses only NextAuth cookie sessions (`auth()`). For iOS, it must be extended to support dual authentication:

```
requireUserSession():
  1. Check Authorization: Bearer <token> header
     → If present: verify JWT signature, extract userId, return UserSession
  2. Fallback: auth() (NextAuth cookie session) — existing behavior
  3. If neither: return 401
```

This way all existing API endpoints work for both web (cookie) and iOS (Bearer) without duplication.

New server endpoints:
- `POST /api/auth/mobile/login` → `{ accessToken, refreshToken, expiresIn }`
- `POST /api/auth/mobile/refresh` → `{ accessToken, expiresIn }`

Token lifecycle:
- Access token: JWT, 15 min TTL, signed with `AUTH_SECRET`
- Refresh token: opaque (crypto.randomBytes), 30 days TTL
- **Security requirements** (Critical Fix #2):
  - Refresh token stored as **bcrypt hash** in DB (never plaintext)
  - **Rotation on use**: each refresh issues new refresh token, old one invalidated
  - **Reuse detection**: if a previously rotated token is used, revoke ALL tokens for that user (signals theft)
  - **Device binding**: `RefreshToken` includes `deviceId` (generated on first login, stored in Keychain)
  - **Revoke-all on logout**: `DELETE /api/auth/mobile/logout` invalidates all refresh tokens for user
  - **Revoke-all on password change**: server invalidates all refresh tokens

```
RefreshToken {
  id            String   @id @default(cuid())
  userId        String
  tokenHash     String   // bcrypt hash, NOT plaintext
  deviceId      String   // iOS-generated UUID, stored in Keychain
  expiresAt     DateTime
  rotatedAt     DateTime? // null = active, set = already used
  createdAt     DateTime @default(now())
  user          User     @relation(...)
  @@index([userId])
  @@index([tokenHash])
}
```

iOS stores tokens in Keychain via Security framework. APIClient auto-refreshes on 401 with mutex to prevent concurrent refresh races.

### GitHub OAuth on iOS (Fix #4)

**Secure flow with PKCE and universal links:**

```
1. iOS generates code_verifier + code_challenge (S256)
2. ASWebAuthenticationSession opens:
   GET /api/github/mobile/authorize?code_challenge=...&state=<random>&device_id=...
3. Server stores state+challenge, redirects to GitHub OAuth
4. GitHub callback → server exchanges code → gets GitHub token
5. Server redirects to universal link: https://devghost.app/github-callback?auth_code=<one-time-code>
6. iOS receives universal link (NOT custom scheme — more secure)
7. iOS calls POST /api/github/mobile/exchange { auth_code, code_verifier, device_id }
8. Server verifies code_verifier against stored challenge, saves GitHub token
```

**Why universal links over custom scheme**: Custom URL schemes (`devghost://`) can be claimed by any app. Universal links (`https://devghost.app/...`) are verified via Apple's AASA file and cannot be hijacked.

New server endpoints:
- `GET /api/github/mobile/authorize` — initiate OAuth with PKCE
- `POST /api/github/mobile/exchange` — complete OAuth, verify PKCE

### Caching & Offline (Fix #6)

**Tiered storage with security boundaries:**

| Data | Storage | Rationale |
|------|---------|-----------|
| Auth tokens | Keychain (kSecAttrAccessibleWhenUnlockedThisDeviceOnly) | Sensitive credentials |
| User profile, settings | SwiftData (encrypted) | Moderate sensitivity |
| Order list, metrics | SwiftData (standard) | Performance, offline viewing |
| API responses | URLCache (memory + disk, 50MB) | Transparent HTTP caching |

**Invalidation rules:**
- **Logout**: Clear ALL local data (Keychain tokens, SwiftData, URLCache)
- **Account switch**: Full wipe before new account data loads (prevents cross-account leaks)
- **TTL**: SwiftData entries have `cachedAt` timestamp, stale after 1 hour, force-refresh on pull-to-refresh
- **Server-driven**: API responses include `Cache-Control` headers; URLCache respects them

**No sensitive data in UserDefaults.** UserDefaults is only for non-sensitive preferences (theme, notification settings).

### Error Handling

Typed `APIError` enum: `.unauthorized`, `.serverError(String)`, `.network`, `.decodable`, `.tokenExpired`. Unified UI handling via `.alert` modifier. `.tokenExpired` triggers full re-login flow.

## 4. Data Models (port from @devghost/shared)

### Core Types

```swift
struct GhostMetric: Codable, Identifiable {
    var id: String { developerId }
    let developerId, developerName, developerEmail: String
    let periodType: PeriodType
    let totalEffortHours: Double
    let actualWorkDays: Int
    let avgDailyEffort, ghostPercentRaw, ghostPercent, share: Double
    let shareAutoCalculated: Bool
    let commitCount: Int
    let hasEnoughData: Bool
    let overheadHours: Double?
}

enum PeriodType: String, Codable, CaseIterable {
    case allTime = "ALL_TIME"
    case year = "YEAR", quarter = "QUARTER", month = "MONTH"
    case week = "WEEK", day = "DAY"
}

enum OrderStatus: String, Codable {
    case draft = "DRAFT"
    case developersLoaded = "DEVELOPERS_LOADED"
    case readyForAnalysis = "READY_FOR_ANALYSIS"
    case processing = "PROCESSING"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case insufficientCredits = "INSUFFICIENT_CREDITS"
}

// Fix #5: AnalysisJobStatus for progress UX
enum AnalysisJobStatus: String, Codable {
    case pending = "PENDING"
    case running = "RUNNING"
    case llmComplete = "LLM_COMPLETE"       // Modal done, post-processing pending
    case completed = "COMPLETED"
    case failed = "FAILED"                  // Legacy alias for FAILED_FATAL
    case failedRetryable = "FAILED_RETRYABLE" // Transient, watchdog retries
    case failedFatal = "FAILED_FATAL"       // Permanent, needs human action
    case cancelled = "CANCELLED"

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .failedFatal, .cancelled: return true
        default: return false
        }
    }

    var isRetrying: Bool { self == .failedRetryable }
}
```

### Constants

```swift
enum GhostConstants {
    static let norm = 3.0
    static let maxDailyEffort = 5.0
    static let maxSpreadDays = 5
    static let thresholdExcellent = 120.0
    static let thresholdGood = 100.0
    static let thresholdWarning = 80.0
}
```

### Utilities (pure functions, port from shared/utils.ts)

- `calcGhostPercent()`, `ghostColor()`, `formatGhostPercent()`
- `spreadEffort()` — effort spreading algorithm (Swift `Decimal` replaces decimal.js)

## 5. Visualizations (Swift Charts)

**GhostKPICards** — `LazyVGrid(2x2)`: Avg Ghost%, Developers, Commits, Work Days. Color-coded by threshold.

**GhostBubbleChart** — `Chart` + `PointMark`: X=commitCount, Y=ghostPercent, size=totalEffortHours. Color by `ghostColor()`. Tap → popover with developer info.

**GhostHeatmap** — Custom `LazyVGrid(7 columns)`: GitHub-style contribution graph. Each cell = day, color intensity = effort hours. No native heatmap in Swift Charts.

**EffortTimeline** — `Chart` + `BarMark`/`AreaMark`: X=date, Y=effort hours. `RuleMark` at GHOST_NORM (3h).

**DeveloperDistribution** — `Chart` + `BarMark`: Horizontal bars sorted by Ghost%, color by thresholds.

**Period Selector** — `Picker(.segmented)`: ALL_TIME | YEAR | QUARTER | MONTH. Triggers metric refetch.

All charts support dark mode via system colors. Animated transitions via `.animation(.smooth)`.

## 6. Billing (StoreKit 2) — Unified Model (Fix #3)

### Dual Payment System: Stripe (web) + StoreKit (iOS)

Credits are the unified currency. Both Stripe and StoreKit purchases result in `CreditTransaction` entries. The source of truth is the server's credit balance, not either payment system.

### Schema Changes

```
// Extend existing CreditPack with optional App Store identifier
CreditPack {
  ...existing fields...
  appStoreProductId  String?  @unique  // e.g. "devghost.credits.starter"
}

// Extend existing Subscription
Subscription {
  ...existing fields...
  appStoreProductId  String?  @unique  // e.g. "devghost.sub.monthly"
}

// New: idempotency for App Store events (mirrors StripeEvent)
AppStoreEvent {
  id                      String   @id @default(cuid())
  originalTransactionId   String   @unique  // App Store transaction ID
  type                    String   // PURCHASE, RENEWAL, REFUND, REVOKE
  productId               String
  processedAt             DateTime @default(now())
}

// Extend CreditTransactionType enum:
// + IAP_PURCHASE
// + IAP_SUBSCRIPTION_RENEWAL
// + IAP_REFUND

// Extend UserSubscription
UserSubscription {
  ...existing fields...
  appStoreOriginalTransactionId  String?  @unique  // for iOS subscriptions
}
```

### App Store Connect Products

- **Consumable**: `devghost.credits.starter`, `devghost.credits.pro`, `devghost.credits.business` → maps to server CreditPack via `appStoreProductId`
- **Auto-renewable subscriptions**: `devghost.sub.monthly`, `devghost.sub.annual` → maps to server Subscription via `appStoreProductId`

### Purchase Flow with Idempotency

```
StoreKit Product.purchase()
  → Transaction.verified (client-side)
  → POST /api/billing/ios-verify { originalTransactionId, productId, signedTransaction }
  → Server:
    1. Check AppStoreEvent for originalTransactionId (idempotency — reject duplicates)
    2. Verify signedTransaction via App Store Server API v2 (JWS verification)
    3. Map productId → CreditPack/Subscription via appStoreProductId
    4. Create CreditTransaction (type: IAP_PURCHASE)
    5. Create AppStoreEvent record
    6. Return { balance }
```

### Server-Side (new)

- `POST /api/billing/ios-verify` — JWS transaction verification + credit/subscription
- `POST /api/billing/ios-webhook` — App Store Server Notifications v2
  - `DID_RENEW` → credit subscription credits, create AppStoreEvent
  - `REFUND` → debit credits (type: IAP_REFUND), create AppStoreEvent
  - `REVOKE` → deactivate UserSubscription
  - All events idempotent via `AppStoreEvent.originalTransactionId`

### StoreManager (@Observable)

- Loads products on app launch via `Product.products(for:)`
- Listens to `Transaction.updates` for pending/unfinished transactions
- Syncs with server after each purchase
- Calls `Transaction.finish()` only after server confirmation

## 7. Push Notifications (APNs)

### Registration Flow

```
App launch → UNUserNotificationCenter.requestAuthorization()
  → Get device token
  → POST /api/user/device-token { token, platform: "ios" }
  → Server stores in DeviceToken table
```

### Server-Side (new)

- Table: `DeviceToken { id, userId, token, platform, createdAt }`
- Endpoint: `POST /api/user/device-token`, `DELETE /api/user/device-token`
- Send service via `@parse/node-apn` or direct HTTP/2 to APNs

### Notification Types (already in shared types)

- `analysis_complete` — analysis finished, show Ghost%
- `ghost_alert` — Ghost% dropped below threshold
- `weekly_digest` — weekly summary

### Deep Links

Notification payload contains `orderId` → tap opens `OrderDetailView`.

## 8. Server Changes Required

### New Endpoints

1. **Auth**: `POST /api/auth/mobile/login`, `POST /api/auth/mobile/refresh`
2. **Billing**: `POST /api/billing/ios-verify`, `POST /api/billing/ios-webhook`
3. **Push**: `POST /api/user/device-token`, `DELETE /api/user/device-token`

### New DB Tables

- `RefreshToken { id, userId, tokenHash, deviceId, expiresAt, rotatedAt?, createdAt }` — see Section 3 for security requirements
- `DeviceToken { id, userId, token, platform, createdAt }`
- `AppStoreEvent { id, originalTransactionId, type, productId, processedAt }` — see Section 6

### Schema Modifications

- `CreditPack`: add optional `appStoreProductId String? @unique`
- `Subscription`: add optional `appStoreProductId String? @unique`
- `UserSubscription`: add optional `appStoreOriginalTransactionId String? @unique`
- `CreditTransactionType` enum: add `IAP_PURCHASE`, `IAP_SUBSCRIPTION_RENEWAL`, `IAP_REFUND`

### Server Code Modifications

- `requireUserSession()` in `api-utils.ts`: add Bearer JWT check before NextAuth fallback (dual-auth)
- `middleware.ts`: pass through `Authorization` header for API routes

All existing API endpoints are reused as-is — dual-auth makes them work for both web and iOS.

## 9. Implementation Phases

### Phase 1 — Foundation + Auth
- Xcode project, Swift Packages (Core, SharedUI, Features)
- Port models and constants from @devghost/shared (including AnalysisJobStatus)
- **Server: dual-auth in requireUserSession** (Bearer JWT + NextAuth cookie fallback)
- **Server: /api/auth/mobile/login, /api/auth/mobile/refresh, /api/auth/mobile/logout**
- **Server: RefreshToken table with hash-at-rest, rotation, reuse detection**
- APIClient + AuthManager + Keychain (tokens + deviceId)
- Login/Register screens, TabView shell with stubs
- **Tests: auth refresh flow, token rotation, reuse detection, concurrent refresh mutex**

### Phase 2 — Core Flow
- **GitHub OAuth with PKCE + universal links** (server: /api/github/mobile/authorize, /api/github/mobile/exchange)
- **Server: Apple AASA file for universal links**
- RepoPickerView + OrderCreateView (wizard)
- OrderListView + OrderDetailView
- AnalysisProgressView (polling with AnalysisJobStatus — retryable/fatal/cancelled states)
- GhostMetrics: KPI cards + developer table
- **Tests: GitHub OAuth PKCE exchange, order CRUD via Bearer auth**

### Phase 3 — Visualizations
- Swift Charts: bubble, heatmap, effort timeline
- Period selector + data refetch
- DeveloperDetailView with effort calendar
- CommitListView

### Phase 4 — Billing & Notifications
- **Server: AppStoreEvent table, CreditPack.appStoreProductId, extended CreditTransactionType**
- **Server: /api/billing/ios-verify (JWS verification + idempotency via AppStoreEvent)**
- **Server: /api/billing/ios-webhook (renewals, refunds, revocations — all idempotent)**
- StoreKit 2: credit packs + subscriptions, Transaction.finish() only after server confirm
- APNs: device token registration, push handling
- Deep links from notifications (universal links)
- **Tests: purchase verify idempotency (double-submit), webhook replay, refund flow, cross-platform balance consistency (Stripe + StoreKit credits for same user)**

### Phase 5 — Social & Admin
- Explore tab (public repos grid)
- Share links + PublicDashboardView
- Developer profiles
- Publications management
- Referral system
- Admin panel (ADMIN only)

### Phase 6 — Polish
- Offline cache (SwiftData with cachedAt TTL, full wipe on logout/account switch)
- Widget (Lock Screen / Home Screen — current Ghost%)
- Spotlight search integration
- Accessibility audit
- **Security audit: Keychain storage, no sensitive data in UserDefaults, certificate pinning evaluation**
- App Store submission
