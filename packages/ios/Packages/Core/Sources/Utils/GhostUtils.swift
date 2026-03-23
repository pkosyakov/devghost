import Foundation
import SwiftUI

public enum GhostColorValue: String, Sendable {
    case green, yellow, red, gray

    public var color: Color {
        switch self {
        case .green: .green
        case .yellow: .yellow
        case .red: .red
        case .gray: .gray
        }
    }
}

public enum GhostUtils {
    public static func calcGhostPercentRaw(totalEffortHours: Double, actualWorkDays: Int) -> Double? {
        guard actualWorkDays >= GhostConstants.minWorkDaysForGhost else { return nil }
        let avgDaily = totalEffortHours / Double(actualWorkDays)
        return (avgDaily / GhostConstants.norm) * 100
    }

    public static func calcGhostPercent(totalEffortHours: Double, actualWorkDays: Int, share: Double) -> Double? {
        guard actualWorkDays >= GhostConstants.minWorkDaysForGhost, share > 0 else { return nil }
        let avgDaily = totalEffortHours / Double(actualWorkDays)
        return (avgDaily / (GhostConstants.norm * share)) * 100
    }

    public static func ghostColor(percent: Double?) -> GhostColorValue {
        guard let percent else { return .gray }
        if percent >= GhostConstants.Threshold.good { return .green }
        if percent >= GhostConstants.Threshold.warning { return .yellow }
        return .red
    }

    public static func formatGhostPercent(_ percent: Double?) -> String {
        guard let percent else { return "N/A" }
        return "\(Int(percent.rounded()))%"
    }
}
