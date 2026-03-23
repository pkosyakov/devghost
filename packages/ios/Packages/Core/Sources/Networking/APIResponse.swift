import Foundation

public struct APIResponse<T: Decodable>: Decodable {
    public let success: Bool
    public let data: T?
    public let error: String?
}

public enum APIError: Error, LocalizedError {
    case unauthorized
    case tokenExpired
    case forbidden
    case serverError(String)
    case network(Error)
    case decodable(Error)
    case blocked

    public var errorDescription: String? {
        switch self {
        case .unauthorized: "Please login again"
        case .tokenExpired: "Session expired"
        case .forbidden: "Access denied"
        case .serverError(let msg): msg
        case .network(let err): err.localizedDescription
        case .decodable(let err): "Data parsing error: \(err.localizedDescription)"
        case .blocked: "Account is blocked"
        }
    }

    public var userMessage: String {
        errorDescription ?? "An unexpected error occurred. Please try again."
    }
}
