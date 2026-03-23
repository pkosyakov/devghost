import Foundation

public struct SelectedRepo: Codable, Sendable {
    public let id: String
    public let fullName: String
    public let cloneUrl: String?
}

public struct SelectedDeveloper: Codable, Sendable {
    public let name: String
    public let email: String
    public let commitCount: Int?
}

public struct Order: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String?
    public let status: OrderStatus
    public let createdAt: Date
    public let completedAt: Date?
    public let metrics: OrderMetricsSummary?
    public let selectedRepos: [SelectedRepo]?
    public let selectedDevelopers: [SelectedDeveloper]?
    public let ghostPercent: Double?
    public let userId: String?

    public var displayName: String {
        name ?? "Order \(id.prefix(8))"
    }
}

public struct OrderMetricsSummary: Codable, Sendable {
    public let avgGhostPercent: Double?
    public let totalEffortHours: Double?
    public let totalCommitsAnalyzed: Int?
}

public struct OrderListItem: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String?
    public let status: OrderStatus
    public let repoCount: Int?
    public let developerCount: Int?
    public let totalCommits: Int?
    public let createdAt: Date
    public let analyzedAt: Date?
    public let completedAt: Date?
    public let metrics: OrderMetricsSummary?

    public var displayName: String {
        name ?? "Order \(id.prefix(8))"
    }
}

public enum OrderStatus: String, Codable, Sendable {
    case draft = "DRAFT"
    case developersLoaded = "DEVELOPERS_LOADED"
    case readyForAnalysis = "READY_FOR_ANALYSIS"
    case processing = "PROCESSING"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case insufficientCredits = "INSUFFICIENT_CREDITS"

    public var displayName: String {
        switch self {
        case .draft: "Draft"
        case .developersLoaded: "Developers Loaded"
        case .readyForAnalysis: "Ready"
        case .processing: "Processing"
        case .completed: "Completed"
        case .failed: "Failed"
        case .insufficientCredits: "Insufficient Credits"
        }
    }

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .insufficientCredits: true
        default: false
        }
    }

    public var isActive: Bool {
        self == .processing
    }
}
