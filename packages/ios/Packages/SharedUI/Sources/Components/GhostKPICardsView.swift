import SwiftUI
import Core

public struct GhostKPICardsView: View {
    let avgGhostPercent: Double?
    let developerCount: Int
    let commitCount: Int
    let workDays: Int

    public init(avgGhostPercent: Double?, developerCount: Int, commitCount: Int, workDays: Int) {
        self.avgGhostPercent = avgGhostPercent
        self.developerCount = developerCount
        self.commitCount = commitCount
        self.workDays = workDays
    }

    /// Alternate init for summary-based metrics
    public init(avgGhostPercent: Double?, totalCommits: Int, totalEffort: Double, activeDevelopers: Int) {
        self.avgGhostPercent = avgGhostPercent
        self.developerCount = activeDevelopers
        self.commitCount = totalCommits
        self.workDays = totalEffort > 0 ? max(1, Int(totalEffort / GhostConstants.norm)) : 0
    }

    public var body: some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible()),
        ], spacing: AppTheme.Spacing.sm) {
            KPICard(
                title: "Avg Ghost%",
                value: GhostUtils.formatGhostPercent(avgGhostPercent),
                color: GhostUtils.ghostColor(percent: avgGhostPercent).color
            )

            KPICard(
                title: "Developers",
                value: "\(developerCount)"
            )

            KPICard(
                title: "Commits",
                value: "\(commitCount)"
            )

            KPICard(
                title: "Work Days",
                value: "\(workDays)"
            )
        }
    }
}
