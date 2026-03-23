import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class MetricsViewModel {
    private let apiClient: APIClient
    let orderId: String

    var selectedPeriod: PeriodType = .allTime
    var metrics: MetricsResponse?
    var isLoading = false
    var error: Error?

    init(orderId: String, apiClient: APIClient = .shared) {
        self.orderId = orderId
        self.apiClient = apiClient
    }

    var summary: MetricsSummary? { metrics?.summary }
    var developers: [DeveloperMetric] { metrics?.developers ?? [] }

    func fetchMetrics() async {
        isLoading = true
        error = nil
        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/metrics",
                method: .get,
                queryItems: [URLQueryItem(name: "period", value: selectedPeriod.rawValue)]
            )
            metrics = try await apiClient.request(endpoint)
            isLoading = false
        } catch {
            self.error = error
            isLoading = false
        }
    }

    func fetchEffortTimeline() async -> [EffortTimelineEntry] {
        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/effort-timeline",
                method: .get
            )
            let entries: [EffortTimelineEntry] = try await apiClient.request(endpoint)
            return entries
        } catch {
            return []
        }
    }
}

// MARK: - Response Models

struct MetricsResponse: Codable {
    let developers: [DeveloperMetric]
    let summary: MetricsSummary
}

struct DeveloperMetric: Codable, Identifiable {
    var id: String { email }
    let name: String
    let email: String
    let ghostPercent: Double
    let adjustedGhostPercent: Double?
    let workDays: Int
    let totalEffortHours: Double
    let commitCount: Int
    let share: Double?
}

struct MetricsSummary: Codable {
    let avgGhostPercent: Double
    let totalCommits: Int
    let totalEffort: Double
    let activeDevelopers: Int
}

struct EffortTimelineEntry: Codable, Identifiable {
    var id: String { "\(date)-\(developer)" }
    let date: String
    let effort: Double
    let developer: String
}

// MARK: - View

struct MetricsView: View {
    @State private var viewModel: MetricsViewModel
    @State private var timelineData: [EffortTimelineEntry] = []

    init(orderId: String) {
        _viewModel = State(initialValue: MetricsViewModel(orderId: orderId))
    }

    private var ghostEligiblePeriods: [PeriodType] {
        PeriodType.allCases.filter(\.isGhostEligible)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.lg) {
                periodPicker
                contentSection
            }
            .padding(AppTheme.Spacing.md)
        }
        .navigationTitle("Metrics")
        .task {
            await viewModel.fetchMetrics()
            timelineData = await viewModel.fetchEffortTimeline()
        }
        .onChange(of: viewModel.selectedPeriod) { _, _ in
            Task { await viewModel.fetchMetrics() }
        }
    }

    // MARK: - Subviews

    @ViewBuilder
    private var periodPicker: some View {
        Picker("Period", selection: $viewModel.selectedPeriod) {
            ForEach(ghostEligiblePeriods, id: \.self) { period in
                Text(period.displayName).tag(period)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private var contentSection: some View {
        if viewModel.isLoading {
            LoadingView()
        } else if let error = viewModel.error {
            ErrorView(error: error) {
                Task { await viewModel.fetchMetrics() }
            }
        } else if let summary = viewModel.summary {
            kpiSection(summary: summary)
            chartSection
            developerNavigationLink
        } else {
            ContentUnavailableView(
                "No Metrics",
                systemImage: "chart.bar.xaxis",
                description: Text("Run an analysis to see metrics.")
            )
        }
    }

    private func kpiSection(summary: MetricsSummary) -> some View {
        GhostKPICardsView(
            avgGhostPercent: summary.avgGhostPercent,
            totalCommits: summary.totalCommits,
            totalEffort: summary.totalEffort,
            activeDevelopers: summary.activeDevelopers
        )
    }

    @ViewBuilder
    private var chartSection: some View {
        VStack(spacing: AppTheme.Spacing.lg) {
            if !viewModel.developers.isEmpty {
                GhostBubbleChart(
                    data: viewModel.developers.map { dev in
                        GhostBubbleChart.DataPoint(
                            name: dev.name,
                            ghostPercent: dev.ghostPercent,
                            commitCount: dev.commitCount,
                            totalEffortHours: dev.totalEffortHours
                        )
                    }
                )
            }

            if !timelineData.isEmpty {
                EffortTimelineChart(
                    data: timelineData.map { entry in
                        EffortTimelineChart.DataPoint(
                            date: entry.date,
                            effort: entry.effort,
                            developer: entry.developer
                        )
                    }
                )
            }
        }
    }

    private var developerNavigationLink: some View {
        NavigationLink {
            DeveloperListView(viewModel: viewModel)
        } label: {
            HStack {
                Label("All Developers", systemImage: "person.3")
                Spacer()
                Text("\(viewModel.developers.count)")
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(AppTheme.Spacing.md)
            .background(AppTheme.Colors.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}
