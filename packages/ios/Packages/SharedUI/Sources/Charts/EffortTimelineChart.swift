import SwiftUI
import Charts
import Core

public struct EffortTimelineChart: View {
    public struct DataPoint: Identifiable {
        public let id = UUID()
        public let date: Date
        public let effort: Double
        public let developer: String?

        public init(date: Date, effort: Double, developer: String? = nil) {
            self.date = date
            self.effort = effort
            self.developer = developer
        }

        public init(date: String, effort: Double, developer: String? = nil) {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = formatter.date(from: date) {
                self.date = d
            } else {
                let df = DateFormatter()
                df.dateFormat = "yyyy-MM-dd"
                self.date = df.date(from: date) ?? Date()
            }
            self.effort = effort
            self.developer = developer
        }
    }

    private let chartData: [(date: Date, hours: Double)]

    public init(dailyEfforts: [DailyEffort]) {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"

        self.chartData = Dictionary(grouping: dailyEfforts, by: \.date)
            .compactMap { (dateStr, efforts) -> (date: Date, hours: Double)? in
                guard let date = formatter.date(from: dateStr) else { return nil }
                let total = efforts.reduce(0) { $0 + $1.effortHours }
                return (date: date, hours: total)
            }
            .sorted { $0.date < $1.date }
    }

    public init(data: [DataPoint]) {
        // Group by date, sum effort
        var grouped: [Date: Double] = [:]
        let calendar = Calendar.current
        for point in data {
            let day = calendar.startOfDay(for: point.date)
            grouped[day, default: 0] += point.effort
        }
        self.chartData = grouped.map { (date: $0.key, hours: $0.value) }.sorted { $0.date < $1.date }
    }

    public var body: some View {
        Chart {
            ForEach(chartData, id: \.date) { entry in
                BarMark(
                    x: .value("Date", entry.date),
                    y: .value("Hours", entry.hours)
                )
                .foregroundStyle(barColor(hours: entry.hours))
            }

            RuleMark(y: .value("Ghost Norm", GhostConstants.norm))
                .foregroundStyle(.orange)
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [5, 3]))
                .annotation(position: .top, alignment: .trailing) {
                    Text("Norm \(GhostConstants.norm, specifier: "%.0f")h")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
        }
        .chartYAxisLabel("Hours")
        .frame(height: 200)
    }

    private func barColor(hours: Double) -> Color {
        if hours >= GhostConstants.norm { return .green }
        if hours >= GhostConstants.norm * 0.6 { return .yellow }
        return .red
    }
}
