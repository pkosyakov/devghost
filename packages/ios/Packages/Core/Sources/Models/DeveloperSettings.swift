import Foundation

public struct DeveloperSettings: Codable, Identifiable, Sendable {
    public var id: String { developerId }
    public let developerId: String
    public var share: Double
    public let shareAutoCalculated: Bool
    public var isExcluded: Bool
}
