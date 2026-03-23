import Foundation
import Observation

@Observable
public final class APIClient {
    public static var shared: APIClient!

    public static let defaultBaseURL = URL(string: "https://devghost.app")!

    private let baseURL: URL
    private let session: URLSession
    private let authManager: AuthManager
    private let decoder: JSONDecoder

    private let refreshCoordinator = TokenRefreshCoordinator()

    public init(baseURL: URL = APIClient.defaultBaseURL, authManager: AuthManager) {
        self.baseURL = baseURL
        self.authManager = authManager
        self.session = URLSession(configuration: .default)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let str = try container.decode(String.self)

            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = iso.date(from: str) { return d }
            iso.formatOptions = [.withInternetDateTime]
            if let d = iso.date(from: str) { return d }

            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Bad date: \(str)")
        }
        self.decoder = decoder
    }

    // MARK: - Public API

    public func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        let response: APIResponse<T> = try await perform(endpoint)
        guard response.success, let data = response.data else {
            throw APIError.serverError(response.error ?? "Unknown error")
        }
        return data
    }

    public func requestRaw<T: Decodable>(_ endpoint: Endpoint) async throws -> APIResponse<T> {
        try await perform(endpoint)
    }

    public func requestVoid(_ endpoint: Endpoint) async throws {
        let _: APIResponse<EmptyResponse> = try await perform(endpoint)
    }

    // MARK: - Internal

    private func perform<T: Decodable>(_ endpoint: Endpoint, isRetry: Bool = false) async throws -> APIResponse<T> {
        var request = try buildRequest(endpoint)

        if let token = authManager.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, urlResponse) = try await session.data(for: request)

        guard let http = urlResponse as? HTTPURLResponse else {
            throw APIError.network(URLError(.badServerResponse))
        }

        if http.statusCode == 401 && !isRetry {
            let newToken = try await refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, retryResponse) = try await session.data(for: request)
            guard let retryHttp = retryResponse as? HTTPURLResponse else {
                throw APIError.network(URLError(.badServerResponse))
            }
            if retryHttp.statusCode == 401 {
                await MainActor.run { authManager.logout() }
                throw APIError.tokenExpired
            }
            return try decoder.decode(APIResponse<T>.self, from: retryData)
        }

        if http.statusCode == 401 {
            await MainActor.run { authManager.logout() }
            throw APIError.tokenExpired
        }

        if http.statusCode == 403 {
            throw APIError.forbidden
        }

        do {
            return try decoder.decode(APIResponse<T>.self, from: data)
        } catch {
            throw APIError.decodable(error)
        }
    }

    private func buildRequest(_ endpoint: Endpoint) throws -> URLRequest {
        guard let components = URLComponents(url: baseURL.appendingPathComponent(endpoint.path), resolvingAgainstBaseURL: true) else {
            throw APIError.serverError("Invalid URL for path: \(endpoint.path)")
        }
        var mutableComponents = components
        mutableComponents.queryItems = endpoint.queryItems

        guard let url = mutableComponents.url else {
            throw APIError.serverError("Could not construct URL for path: \(endpoint.path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let body = endpoint.body {
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        return request
    }

    private func refreshToken() async throws -> String {
        try await refreshCoordinator.refreshIfNeeded { [self] in
            guard let rt = authManager.getRefreshToken() else {
                await MainActor.run { authManager.logout() }
                throw APIError.tokenExpired
            }

            var request = URLRequest(url: baseURL.appendingPathComponent("api/auth/mobile/refresh"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode([
                "refreshToken": rt,
                "deviceId": authManager.deviceId,
            ])

            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                await MainActor.run { authManager.logout() }
                throw APIError.tokenExpired
            }

            let refreshResp = try decoder.decode(RefreshTokenResponse.self, from: data)
            guard let tokens = refreshResp.data else {
                await MainActor.run { authManager.logout() }
                throw APIError.tokenExpired
            }

            try authManager.saveTokens(accessToken: tokens.accessToken, refreshToken: tokens.refreshToken)
        }

        return authManager.accessToken!
    }
}

// MARK: - Token Refresh Coordinator

private actor TokenRefreshCoordinator {
    private var refreshTask: Task<Void, Error>?

    func refreshIfNeeded(using refresh: @Sendable () async throws -> Void) async throws {
        if let existing = refreshTask {
            try await existing.value
            return
        }

        let task = Task {
            try await refresh()
        }
        refreshTask = task

        do {
            try await task.value
            refreshTask = nil
        } catch {
            refreshTask = nil
            throw error
        }
    }
}

// MARK: - Helpers

private struct EmptyResponse: Decodable {}

private struct RefreshTokenResponse: Decodable {
    let success: Bool
    let data: TokenData?
    struct TokenData: Decodable {
        let accessToken: String
        let refreshToken: String
    }
}

private struct AnyEncodable: Encodable {
    private let encode: (Encoder) throws -> Void
    init(_ value: any Encodable) {
        self.encode = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encode(encoder)
    }
}
