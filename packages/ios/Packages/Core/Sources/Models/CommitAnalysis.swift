import Foundation

public struct FileChange: Codable, Sendable {
    public let filename: String
    public let additions: Int
    public let deletions: Int
}

public struct CommitAnalysis: Codable, Identifiable, Sendable {
    public let id: String
    public let sha: String
    public let message: String?
    public let authorName: String?
    public let authorEmail: String?
    public let committedAt: Date?
    public let date: Date?
    public let estimatedHours: Double?
    public let confidence: Double?
    public let reasoning: String?
    public let filesChanged: Int?
    public let additions: Int?
    public let deletions: Int?
    public let files: [FileChange]?

    /// Non-optional accessor with default for estimated hours
    public var effort: Double { estimatedHours ?? 0 }

    /// Non-optional accessor for files changed count
    public var totalFilesChanged: Int { filesChanged ?? 0 }

    /// Non-optional accessor for total lines changed
    public var totalLinesChanged: Int { (additions ?? 0) + (deletions ?? 0) }
}
