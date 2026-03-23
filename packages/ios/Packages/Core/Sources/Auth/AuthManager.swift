import Foundation
import Observation

@Observable
public final class AuthManager {
    public private(set) var isAuthenticated = false
    public private(set) var currentUser: User?

    private let keychain = KeychainService.shared

    private enum Keys {
        static let accessToken = "accessToken"
        static let refreshToken = "refreshToken"
        static let deviceId = "deviceId"
    }

    public var accessToken: String? {
        guard let data = keychain.load(for: Keys.accessToken) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public var deviceId: String {
        if let data = keychain.load(for: Keys.deviceId),
           let existing = String(data: data, encoding: .utf8) {
            return existing
        }
        let newId = UUID().uuidString
        try? keychain.save(Data(newId.utf8), for: Keys.deviceId)
        return newId
    }

    public init() {
        isAuthenticated = keychain.load(for: Keys.accessToken) != nil
    }

    public func saveTokens(accessToken: String, refreshToken: String, expiresIn: Int? = nil) throws {
        try keychain.save(Data(accessToken.utf8), for: Keys.accessToken)
        try keychain.save(Data(refreshToken.utf8), for: Keys.refreshToken)
        isAuthenticated = true
    }

    public func clearTokens() {
        logout()
    }

    public func getRefreshToken() -> String? {
        guard let data = keychain.load(for: Keys.refreshToken) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func logout() {
        keychain.deleteAll()
        isAuthenticated = false
        currentUser = nil
    }

    public func setUser(_ user: User) {
        currentUser = user
    }
}
