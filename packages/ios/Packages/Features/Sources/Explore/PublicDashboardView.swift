import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class PublicDashboardViewModel {
    var metrics: PublicRepoMetrics?
    var isLoading = false
    var error: String?

    private let apiClient: APIClient
    let owner: String
    let repoName: String

    init(owner: String, repoName: String, apiClient: APIClient) {
        self.owner = owner
        self.repoName = repoName
        self.apiClient = apiClient
    }

    func loadMetrics() async {
        isLoading = true
        error = nil
        do {
            metrics = try await apiClient.request(
                Endpoint(path: "/api/explore/\(owner)/\(repoName)", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

/// Decoded from /api/explore/[owner]/[repo]
struct PublicRepoMetrics: Decodable {
    let repoName: String
    let owner: String
    let totalCommits: Int?
    let totalDevelopers: Int?
    let averageGhostPercent: Double?
    let developers: [PublicDeveloperMetric]?

    struct PublicDeveloperMetric: Decodable, Identifiable {
        var id: String { name }
        let name: String
        let ghostPercent: Double
        let commits: Int
        let totalEffortHours: Double
    }
}

// MARK: - View

public struct PublicDashboardView: View {
    @State private var viewModel: PublicDashboardViewModel

    public init(owner: String, repoName: String, apiClient: APIClient) {
        _viewModel = State(initialValue: PublicDashboardViewModel(owner: owner, repoName: repoName, apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading {
                LoadingView(message: "Loading metrics...")
            } else if let error = viewModel.error {
                ErrorView(message: error) {
                    Task { await viewModel.loadMetrics() }
                }
            } else if let metrics = viewModel.metrics {
                metricsContent(metrics)
            }
        }
        .navigationTitle("\(viewModel.owner)/\(viewModel.repoName)")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadMetrics()
        }
    }

    @ViewBuilder
    private func metricsContent(_ metrics: PublicRepoMetrics) -> some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.large) {
                kpiSection(metrics)
                developersSection(metrics)
                chartPlaceholder
            }
            .padding(AppTheme.Spacing.medium)
        }
    }

    @ViewBuilder
    private func kpiSection(_ metrics: PublicRepoMetrics) -> some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible())
        ], spacing: AppTheme.Spacing.medium) {
            KPICard(
                title: "Avg Ghost%",
                value: metrics.averageGhostPercent.map { "\(Int($0))%" } ?? "--",
                icon: "gauge.medium"
            )
            KPICard(
                title: "Total Commits",
                value: metrics.totalCommits.map { "\($0)" } ?? "--",
                icon: "arrow.triangle.branch"
            )
            KPICard(
                title: "Developers",
                value: metrics.totalDevelopers.map { "\($0)" } ?? "--",
                icon: "person.2"
            )
            KPICard(
                title: "Repository",
                value: metrics.repoName,
                icon: "folder"
            )
        }
    }

    @ViewBuilder
    private func developersSection(_ metrics: PublicRepoMetrics) -> some View {
        if let developers = metrics.developers, !developers.isEmpty {
            VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
                Text("Developer Breakdown")
                    .font(.title3.bold())

                ForEach(developers) { dev in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(dev.name)
                                .font(.subheadline.bold())
                            Text("\(dev.commits) commits, \(String(format: "%.1f", dev.totalEffortHours))h effort")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Text("\(Int(dev.ghostPercent))%")
                            .font(.subheadline.bold().monospacedDigit())
                            .foregroundStyle(ghostColor(dev.ghostPercent))
                    }
                    .padding(AppTheme.Spacing.small)

                    if dev.id != developers.last?.id {
                        Divider()
                    }
                }
            }
            .padding(AppTheme.Spacing.medium)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    @ViewBuilder
    private var chartPlaceholder: some View {
        VStack(spacing: AppTheme.Spacing.small) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("Charts coming soon")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 200)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func ghostColor(_ percent: Double) -> Color {
        switch percent {
        case 120...: return .green
        case 100..<120: return .blue
        case 80..<100: return .orange
        default: return .red
        }
    }
}
