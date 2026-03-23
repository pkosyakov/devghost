import SwiftUI
import Charts
import Core

public struct GhostBubbleChart: View {
    public struct DataPoint: Identifiable {
        public let id = UUID()
        public let name: String
        public let commitCount: Int
        public let ghostPercent: Double
        public let totalEffortHours: Double

        public init(name: String, commitCount: Int, ghostPercent: Double, totalEffortHours: Double = 0) {
            self.name = name
            self.commitCount = commitCount
            self.ghostPercent = ghostPercent
            self.totalEffortHours = totalEffortHours
        }

        public init(name: String, ghostPercent: Double, commitCount: Int, totalEffortHours: Double = 0) {
            self.name = name
            self.commitCount = commitCount
            self.ghostPercent = ghostPercent
            self.totalEffortHours = totalEffortHours
        }
    }

    private let dataPoints: [DataPoint]

    public init(metrics: [GhostMetric]) {
        self.dataPoints = metrics.map { metric in
            DataPoint(
                name: metric.developerName,
                commitCount: metric.commitCount,
                ghostPercent: metric.ghostPercent,
                totalEffortHours: metric.totalEffortHours
            )
        }
    }

    public init(data: [DataPoint]) {
        self.dataPoints = data
    }

    public var body: some View {
        Chart(dataPoints) { point in
            PointMark(
                x: .value("Commits", point.commitCount),
                y: .value("Ghost%", point.ghostPercent)
            )
            .symbolSize(CGFloat(point.totalEffortHours) * 20)
            .foregroundStyle(GhostUtils.ghostColor(percent: point.ghostPercent).color)
            .annotation(position: .top) {
                if dataPoints.count <= 8 {
                    Text(point.name.components(separatedBy: " ").first ?? "")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading)
        }
        .chartXAxisLabel("Commits")
        .chartYAxisLabel("Ghost%")
        .frame(height: 250)
    }
}
