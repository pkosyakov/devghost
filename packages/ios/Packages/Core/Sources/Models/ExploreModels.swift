import Foundation

public struct PublicRepo: Codable, Identifiable, Sendable {
    public let id: String
    public let repoFullName: String
    public let description: String?
    public let avgGhostPercent: Double?
    public let developerCount: Int?
    public let commitCount: Int?
    public let isFeatured: Bool?
    public let shareToken: String?
    public let owner: String?
    public let name: String?
    public let stars: Int?
    public let language: String?
    public let ghostPercent: Double?

    /// Extracts owner from repoFullName if not provided directly
    public var resolvedOwner: String {
        if let owner { return owner }
        return String(repoFullName.split(separator: "/").first ?? "")
    }

    /// Extracts name from repoFullName if not provided directly
    public var resolvedName: String {
        if let name { return name }
        return String(repoFullName.split(separator: "/").last ?? "")
    }
}

public struct ProfileStats: Codable, Sendable {
    public let avgGhostPercent: Double?
    public let repoCount: Int?
    public let commitCount: Int?
}

public struct DeveloperProfile: Codable, Identifiable, Sendable {
    public let id: String
    public let displayName: String
    public let slug: String
    public let bio: String?
    public let avatarUrl: String?
    public let githubUsername: String?
    public let location: String?
    public let stats: ProfileStats?
    public let repos: [PublicRepo]?
}

public struct ReferralInfo: Codable, Sendable {
    public let referralCode: String
    public let stats: ReferralStats
    public let referrals: [ReferralEntry]
}

public struct ReferralStats: Codable, Sendable {
    public let invited: Int
    public let limit: Int
    public let creditsEarned: Int
    public let creditsPerReferral: Int

    public var totalReferred: Int { invited }
    public var totalCreditsEarned: Int { creditsEarned }
}

public struct ReferralEntry: Codable, Identifiable, Sendable {
    public let id: String
    public let email: String
    public let createdAt: Date
    public let referredEmail: String?
    public let creditsEarned: Int?
    public let status: String?
}
