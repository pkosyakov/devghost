import Foundation

public struct AnalysisProgress: Codable, Sendable {
    public let jobId: String
    public let status: AnalysisJobStatus
    public let progress: Double
    public let currentStep: String?
    public let currentCommit: String?
    public let totalCommits: Int?
    public let startedAt: Date?
    public let eta: String?
    public let error: String?
}
