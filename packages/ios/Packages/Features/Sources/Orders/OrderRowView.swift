import SwiftUI
import Core
import SharedUI

// MARK: - View

public struct OrderRowView: View {
    let order: Order

    public init(order: Order) {
        self.order = order
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
            // Top row: repos + status
            HStack(alignment: .top) {
                repoNames
                Spacer()
                StatusBadge(status: order.status)
            }

            // Bottom row: date + ghost% preview
            HStack {
                dateLabel

                Spacer()

                if let ghostPercent = order.ghostPercent,
                   order.status == .completed {
                    ghostPreview(ghostPercent)
                }
            }
        }
        .padding(.vertical, AppTheme.Spacing.xs)
    }

    // MARK: - Subviews

    private var repoNames: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let repos = order.selectedRepos, !repos.isEmpty {
                let displayRepos = repos.prefix(2)
                ForEach(Array(displayRepos.enumerated()), id: \.offset) { _, repo in
                    HStack(spacing: AppTheme.Spacing.xs) {
                        Image(systemName: "folder.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        Text(repo.fullName)
                            .font(.subheadline.weight(.medium))
                            .lineLimit(1)
                    }
                }

                if repos.count > 2 {
                    Text("+\(repos.count - 2) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Order #\(order.id.prefix(8))")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var dateLabel: some View {
        HStack(spacing: AppTheme.Spacing.xs) {
            Image(systemName: "calendar")
                .font(.caption2)
            Text(order.createdAt.formatted(.dateTime.month(.abbreviated).day()))
                .font(.caption)
        }
        .foregroundStyle(.tertiary)
    }

    private func ghostPreview(_ percent: Double) -> some View {
        HStack(spacing: AppTheme.Spacing.xs) {
            Image(systemName: "ghost.fill")
                .font(.caption)

            Text("\(Int(percent))%")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(ghostColor(for: percent))
    }

    // MARK: - Helpers

    private func ghostColor(for percent: Double) -> Color {
        switch percent {
        case 120...: return .green
        case 100..<120: return AppTheme.Colors.primary
        case 80..<100: return .orange
        default: return .red
        }
    }
}
