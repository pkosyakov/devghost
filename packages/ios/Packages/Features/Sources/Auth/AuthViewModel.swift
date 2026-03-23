import SwiftUI
import Core

/// Shared authentication state coordinator.
///
/// `LoginViewModel` and `RegisterViewModel` each manage their own form state
/// and API calls. This type provides a lightweight coordination layer for
/// screens that need to observe or react to auth state changes without
/// owning a specific form.
///
/// Typical usage: inject via `@Environment` to let deep child views trigger
/// logout or check current auth status without passing closures through
/// the view hierarchy.
@MainActor
@Observable
public final class AuthViewModel {
    public private(set) var isCheckingSession = false

    private let authManager: AuthManager
    private let apiClient: APIClient

    public init(authManager: AuthManager, apiClient: APIClient) {
        self.authManager = authManager
        self.apiClient = apiClient
    }

    /// Whether the user currently holds a valid access token.
    public var isAuthenticated: Bool {
        authManager.isAuthenticated
    }

    /// Sign out: revoke server-side refresh tokens, then clear local keychain.
    public func signOut() async {
        do {
            struct Empty: Decodable {}
            let _: Empty = try await apiClient.request(
                Endpoint(path: "/api/auth/mobile/logout", method: .post)
            )
        } catch {
            // Server logout failed — clear local state anyway
        }
        authManager.clearTokens()
    }

    /// Validate the current session by making a lightweight API call.
    /// Returns `true` if the session is still valid, `false` if the token
    /// has been revoked or expired beyond refresh.
    public func validateSession() async -> Bool {
        isCheckingSession = true
        defer { isCheckingSession = false }

        do {
            let endpoint = Endpoint(path: "/api/user/profile", method: .get)
            let _: User = try await apiClient.request(endpoint)
            return true
        } catch {
            return false
        }
    }
}
