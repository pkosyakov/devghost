import Foundation

public enum GhostConstants {
    public static let norm: Double = 3.0
    public static let maxDailyEffort: Double = 5.0
    public static let maxSpreadDays: Int = 5
    public static let minWorkDaysForGhost: Int = 1
    public static let minCustomRangeDays: Int = 30

    public enum Threshold {
        public static let excellent: Double = 120
        public static let good: Double = 100
        public static let warning: Double = 80
    }
}
