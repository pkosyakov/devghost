import SwiftUI
import Core

public struct GhostHeatmap: View {
    let dailyEfforts: [DailyEffort]
    let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)

    public init(dailyEfforts: [DailyEffort]) {
        self.dailyEfforts = dailyEfforts
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
            HStack {
                ForEach(Array(["M", "T", "W", "T", "F", "S", "S"].enumerated()), id: \.offset) { _, day in
                    Text(day)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }

            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(cells, id: \.date) { cell in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(cellColor(hours: cell.hours))
                        .aspectRatio(1, contentMode: .fit)
                }
            }

            // Legend
            HStack(spacing: AppTheme.Spacing.xs) {
                Text("Less")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                ForEach([0.0, 1.0, 2.0, 3.0, 5.0], id: \.self) { level in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(cellColor(hours: level))
                        .frame(width: 12, height: 12)
                }
                Text("More")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var cells: [(date: String, hours: Double)] {
        let effortByDate = Dictionary(grouping: dailyEfforts, by: \.date)
            .mapValues { $0.reduce(0) { $0 + $1.effortHours } }

        let sorted = effortByDate.sorted { $0.key < $1.key }
        return sorted.map { (date: $0.key, hours: $0.value) }
    }

    private func cellColor(hours: Double) -> Color {
        if hours <= 0 { return Color.gray.opacity(0.1) }
        if hours < 1 { return Color.green.opacity(0.2) }
        if hours < 2 { return Color.green.opacity(0.4) }
        if hours < 3 { return Color.green.opacity(0.6) }
        if hours < 4 { return Color.green.opacity(0.8) }
        return Color.green
    }
}
