import SwiftUI
import Charts
import Core

public struct DeveloperDistributionChart: View {
    public struct DataPoint: Identifiable {
        public let id = UUID()
        public let name: String
        public let ghostPercent: Double
        public let totalEffortHours: Double
        public let commitCount: Int
        public let share: Double

        public init(name: String, ghostPercent: Double, totalEffortHours: Double = 0, commitCount: Int = 0, share: Double = 1.0) {
            self.name = name
            self.ghostPercent = ghostPercent
            self.totalEffortHours = totalEffortHours
            self.commitCount = commitCount
            self.share = share
        }
    }

    private let dataPoints: [DataPoint]

    public init(metrics: [GhostMetric]) {
        self.dataPoints = metrics.map { metric in
            DataPoint(name: metric.developerName, ghostPercent: metric.ghostPercent)
        }
    }

    public init(data: [DataPoint]) {
        self.dataPoints = data
    }

    public var body: some View {
        Chart(sortedData) { point in
            BarMark(
                x: .value("Ghost%", point.ghostPercent),
                y: .value("Developer", point.name)
            )
            .foregroundStyle(GhostUtils.ghostColor(percent: point.ghostPercent).color)
            .annotation(position: .trailing) {
                Text(GhostUtils.formatGhostPercent(point.ghostPercent))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .chartXAxisLabel("Ghost%")
        .frame(height: CGFloat(dataPoints.count) * 44 + 40)
    }

    private var sortedData: [DataPoint] {
        dataPoints.sorted { $0.ghostPercent > $1.ghostPercent }
    }
}
