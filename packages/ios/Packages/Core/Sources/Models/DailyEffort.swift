import Foundation

public struct DailyEffort: Codable, Identifiable, Sendable {
    public var id: String { "\(date)_\(developerEmail)" }
    public let date: String
    public let developerEmail: String
    public let developerName: String?
    public let effortHours: Double
}
