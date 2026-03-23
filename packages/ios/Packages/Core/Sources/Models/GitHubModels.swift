import Foundation

public struct GitHubRepo: Codable, Identifiable, Sendable {
    public let id: Int
    public let name: String
    public let fullName: String
    public let description: String?
    public let language: String?
    public let stargazersCount: Int?
    public let isPrivate: Bool
    public let defaultBranch: String?
    public let updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name, description, language
        case fullName = "full_name"
        case stargazersCount = "stargazers_count"
        case isPrivate = "private"
        case defaultBranch = "default_branch"
        case updatedAt = "updated_at"
    }
}

public struct GitHubConnectionStatus: Codable, Sendable {
    public let isConnected: Bool
    public let username: String?
    public let avatarUrl: String?
}

public struct GitHubContributor: Codable, Identifiable, Sendable {
    public var id: String { email }
    public let name: String
    public let email: String
    public let commitCount: Int
}
