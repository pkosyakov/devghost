import Foundation

public struct User: Codable, Identifiable, Sendable {
    public let id: String
    public let email: String
    public let role: UserRole
    public let name: String?
    public let githubUsername: String?
    public let image: String?
    public let createdAt: Date?
}

public enum UserRole: String, Codable, Sendable {
    case user = "USER"
    case admin = "ADMIN"
}
