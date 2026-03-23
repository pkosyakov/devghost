import SwiftUI
import Core
import SharedUI

// MARK: - Detail Tab

enum OrderDetailTab: String, CaseIterable, Identifiable {
    case metrics = "Metrics"
    case developers = "Developers"
    case commits = "Commits"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .metrics: return "chart.bar.fill"
        case .developers: return "person.2.fill"
        case .commits: return "arrow.triangle.branch"
        }
    }
}

// MARK: - ViewModel

@MainActor
@Observable
final class OrderDetailViewModel {
    var order: Order?
    var metrics: [GhostMetric] = []
    var selectedTab: OrderDetailTab = .metrics
    var isLoading = false
    var isMetricsLoading = false
    var errorMessage: String?
    var isReanalyzing = false

    private let orderId: String
    let apiClient: APIClient

    init(orderId: String, apiClient: APIClient) {
        self.orderId = orderId
        self.apiClient = apiClient
    }

    func fetchOrder() async {
        isLoading = order == nil
        errorMessage = nil

        do {
            let endpoint = Endpoint(path: "/api/orders/\(orderId)", method: .get)
            order = try await apiClient.request(endpoint)

            if order?.status == .completed {
                await fetchMetrics()
            }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Failed to load order details."
        }

        isLoading = false
    }

    func fetchMetrics() async {
        isMetricsLoading = true

        do {
            let endpoint = Endpoint(path: "/api/orders/\(orderId)/metrics", method: .get)
            metrics = try await apiClient.request(endpoint)
        } catch {
            // Non-fatal: metrics may not be available yet
            metrics = []
        }

        isMetricsLoading = false
    }

    func reanalyze() async {
        isReanalyzing = true

        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/analyze",
                method: .post
            )
            let _: SuccessResponse = try await apiClient.request(endpoint)
            await fetchOrder()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Failed to start re-analysis."
        }

        isReanalyzing = false
    }
}

private struct SuccessResponse: Decodable {
    let success: Bool
}

// MARK: - View

public struct OrderDetailView: View {
    @State private var viewModel: OrderDetailViewModel

    public init(orderId: String, apiClient: APIClient) {
        _viewModel = State(initialValue: OrderDetailViewModel(
            orderId: orderId,
            apiClient: apiClient
        ))
    }

    public var body: some View {
        content
            .navigationTitle("Order Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let order = viewModel.order,
                   order.status == .completed || order.status == .failed {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await viewModel.reanalyze() }
                        } label: {
                            if viewModel.isReanalyzing {
                                ProgressView()
                            } else {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                        .disabled(viewModel.isReanalyzing)
                    }
                }
            }
            .task {
                await viewModel.fetchOrder()
            }
            .refreshable {
                await viewModel.fetchOrder()
            }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            LoadingView(message: "Loading order...")
        } else if let error = viewModel.errorMessage, viewModel.order == nil {
            ErrorView(message: error) {
                Task { await viewModel.fetchOrder() }
            }
        } else if let order = viewModel.order {
            orderContent(order)
        }
    }

    private func orderContent(_ order: Order) -> some View {
        VStack(spacing: 0) {
            orderHeader(order)
            tabPicker
            tabContent(order)
        }
    }

    // MARK: - Header

    private func orderHeader(_ order: Order) -> some View {
        VStack(spacing: AppTheme.Spacing.sm) {
            HStack {
                StatusBadge(status: order.status)
                Spacer()
                Text(order.createdAt.formatted(.dateTime.month(.abbreviated).day().year()))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let repos = order.selectedRepos, !repos.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(repos, id: \.fullName) { repo in
                        HStack(spacing: AppTheme.Spacing.xs) {
                            Image(systemName: "folder.fill")
                                .font(.caption)
                                .foregroundStyle(AppTheme.Colors.primary)
                            Text(repo.fullName)
                                .font(.subheadline)
                                .lineLimit(1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if order.status == .processing {
                processingBanner
            }
        }
        .padding(AppTheme.Spacing.md)
        .background(AppTheme.Colors.surfaceSecondary)
    }

    private var processingBanner: some View {
        HStack(spacing: AppTheme.Spacing.sm) {
            ProgressView()
                .controlSize(.small)
            Text("Analysis in progress...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(AppTheme.Spacing.sm)
        .background(AppTheme.Colors.primary.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - Tab Picker

    private var tabPicker: some View {
        Picker("Section", selection: $viewModel.selectedTab) {
            ForEach(OrderDetailTab.allCases) { tab in
                Label(tab.rawValue, systemImage: tab.icon)
                    .tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .padding(AppTheme.Spacing.md)
    }

    // MARK: - Tab Content

    @ViewBuilder
    private func tabContent(_ order: Order) -> some View {
        switch viewModel.selectedTab {
        case .metrics:
            metricsTab(order)
        case .developers:
            developersTab(order)
        case .commits:
            commitsTab(order)
        }
    }

    // MARK: - Metrics Tab

    @ViewBuilder
    private func metricsTab(_ order: Order) -> some View {
        if order.status != .completed {
            EmptyStateView(
                icon: "chart.bar",
                title: "No Metrics Yet",
                message: "Metrics will appear after the analysis completes."
            )
        } else if viewModel.isMetricsLoading {
            LoadingView(message: "Loading metrics...")
        } else if viewModel.metrics.isEmpty {
            EmptyStateView(
                icon: "chart.bar",
                title: "No Metrics",
                message: "No metric data available for this order."
            )
        } else {
            ScrollView {
                VStack(spacing: AppTheme.Spacing.lg) {
                    GhostKPICardsView(
                        avgGhostPercent: viewModel.metrics.isEmpty ? nil : viewModel.metrics.map(\.ghostPercent).reduce(0, +) / Double(viewModel.metrics.count),
                        developerCount: viewModel.metrics.count,
                        commitCount: viewModel.metrics.map(\.commitCount).reduce(0, +),
                        workDays: viewModel.metrics.map(\.actualWorkDays).max() ?? 0
                    )

                    metricsList
                }
                .padding(AppTheme.Spacing.md)
            }
        }
    }

    private var metricsList: some View {
        VStack(spacing: AppTheme.Spacing.sm) {
            Text("Developer Breakdown")
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(viewModel.metrics) { metric in
                developerMetricRow(metric)
            }
        }
    }

    private func developerMetricRow(_ metric: GhostMetric) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(metric.developerName)
                    .font(.subheadline.weight(.medium))

                Text("\(metric.commitCount) commits")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            GhostGauge(percent: metric.ghostPercent, size: .compact)
        }
        .padding(AppTheme.Spacing.md)
        .background(AppTheme.Colors.surfaceSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Developers Tab

    @ViewBuilder
    private func developersTab(_ order: Order) -> some View {
        if let devs = order.selectedDevelopers, !devs.isEmpty {
            List {
                ForEach(devs, id: \.email) { dev in
                    HStack {
                        Image(systemName: "person.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.secondary)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(dev.name)
                                .font(.subheadline.weight(.medium))

                            Text(dev.email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        if let commits = dev.commitCount {
                            Text("\(commits)")
                                .font(.caption.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .listStyle(.plain)
        } else {
            EmptyStateView(
                icon: "person.2",
                title: "No Developers",
                message: "Developers will be extracted during analysis."
            )
        }
    }

    // MARK: - Commits Tab

    @ViewBuilder
    private func commitsTab(_ order: Order) -> some View {
        if order.status == .completed {
            // Placeholder: in a full implementation, this would fetch from
            // GET /api/orders/[id]/commits and display commit analysis details.
            EmptyStateView(
                icon: "arrow.triangle.branch",
                title: "Commit Details",
                message: "Commit-level analysis data is available in the web dashboard."
            )
        } else {
            EmptyStateView(
                icon: "arrow.triangle.branch",
                title: "No Commits",
                message: "Commit data will appear after analysis completes."
            )
        }
    }
}
