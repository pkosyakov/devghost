import Foundation

public struct GhostMetric: Codable, Identifiable, Sendable {
    public var id: String { developerId }
    public let developerId: String
    public let developerName: String
    public let developerEmail: String
    public let periodType: PeriodType
    public let totalEffortHours: Double
    public let actualWorkDays: Int
    public let avgDailyEffort: Double
    public let ghostPercentRaw: Double
    public let ghostPercent: Double
    public let share: Double
    public let shareAutoCalculated: Bool
    public let commitCount: Int
    public let hasEnoughData: Bool
    public let overheadHours: Double?

    public var totalCommits: Int { commitCount }
}

public enum PeriodType: String, Codable, CaseIterable, Sendable {
    case allTime = "ALL_TIME"
    case year = "YEAR"
    case quarter = "QUARTER"
    case month = "MONTH"
    case week = "WEEK"
    case day = "DAY"

    public var isGhostEligible: Bool {
        switch self {
        case .allTime, .year, .quarter, .month: true
        case .week, .day: false
        }
    }

    public var displayName: String {
        switch self {
        case .allTime: "All Time"
        case .year: "Year"
        case .quarter: "Quarter"
        case .month: "Month"
        case .week: "Week"
        case .day: "Day"
        }
    }
}
