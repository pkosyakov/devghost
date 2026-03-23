import SwiftUI
import Core
import SharedUI

// MARK: - Models

struct MonitoringData: Decodable {
    let activeJobs: [MonitoringJob]
    let recentFailed: [FailedJob]
    let cache: CacheInfo

    struct MonitoringJob: Decodable, Identifiable {
        let id: String
        let status: String
        let progress: Int?
        let currentStep: String?
        let startedAt: Date?
        let orderId: String
        let orderName: String?
        let ownerEmail: String
    }

    struct FailedJob: Decodable, Identifiable {
        let id: String
        let error: String?
        let completedAt: Date?
        let orderId: String
        let orderName: String?
        let ownerEmail: String
    }

    struct CacheInfo: Decodable {
        let totalMb: Double
        let repos: Int
        let diffs: Int
        let llm: Int
        let available: Bool
    }
}

// MARK: - ViewModel

@MainActor
@Observable
final class MonitoringViewModel {
    var data: MonitoringData?
    var isLoading = false
    var error: String?

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadMonitoring() async {
        isLoading = true
        error = nil
        do {
            data = try await apiClient.request(
                Endpoint(path: "/api/admin/monitoring", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - View

public struct MonitoringView: View {
    @State private var viewModel: MonitoringViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: MonitoringViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.data == nil {
                LoadingView(message: "Loading monitoring data...")
            } else if let error = viewModel.error, viewModel.data == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadMonitoring() }
                }
            } else {
                contentView
            }
        }
        .navigationTitle("Monitoring")
        .refreshable {
            await viewModel.loadMonitoring()
        }
        .task {
            await viewModel.loadMonitoring()
        }
    }

    @ViewBuilder
    private var contentView: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.large) {
                if let data = viewModel.data {
                    kpiSection(data)
                    activeJobsSection(data.activeJobs)
                    failedJobsSection(data.recentFailed)
                }
            }
            .padding(AppTheme.Spacing.medium)
        }
    }

    @ViewBuilder
    private func kpiSection(_ data: MonitoringData) -> some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible())
        ], spacing: AppTheme.Spacing.medium) {
            KPICard(
                title: "Active Jobs",
                value: "\(data.activeJobs.count)",
                icon: "gearshape.2.fill",
                color: data.activeJobs.isEmpty ? .green : .blue
            )
            KPICard(
                title: "Recent Failures",
                value: "\(data.recentFailed.count)",
                icon: "exclamationmark.triangle.fill",
                color: data.recentFailed.isEmpty ? .green : .red
            )
            KPICard(
                title: "Cached Repos",
                value: "\(data.cache.repos)",
                icon: "folder.fill"
            )
            KPICard(
                title: "Cache Size",
                value: data.cache.available ? String(format: "%.1f MB", data.cache.totalMb) : "N/A",
                icon: "internaldrive"
            )
        }
    }

    @ViewBuilder
    private func activeJobsSection(_ jobs: [MonitoringData.MonitoringJob]) -> some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
            Text("Active Jobs")
                .font(.title3.bold())

            if jobs.isEmpty {
                HStack {
                    Image(systemName: "checkmark.circle")
                        .foregroundStyle(.green)
                    Text("No active jobs")
                        .foregroundStyle(.secondary)
                }
                .padding(AppTheme.Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            } else {
                ForEach(jobs) { job in
                    ActiveJobRow(job: job)
                }
            }
        }
    }

    @ViewBuilder
    private func failedJobsSection(_ jobs: [MonitoringData.FailedJob]) -> some View {
        if !jobs.isEmpty {
            VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
                Text("Recent Failures")
                    .font(.title3.bold())

                ForEach(jobs) { job in
                    FailedJobRow(job: job)
                }
            }
        }
    }
}

// MARK: - Rows

private struct ActiveJobRow: View {
    let job: MonitoringData.MonitoringJob

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
            HStack {
                Text(job.orderName ?? "Job \(job.id.prefix(8))")
                    .font(.subheadline.bold())

                Spacer()

                StatusBadge(
                    text: job.status,
                    style: job.status == "RUNNING" ? .info : .neutral
                )
            }

            if let step = job.currentStep {
                Text(step)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text(job.ownerEmail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                Spacer()

                if let progress = job.progress {
                    Text("\(progress)%")
                        .font(.caption.bold())
                        .foregroundStyle(AppTheme.Colors.primary)
                }

                if let startedAt = job.startedAt {
                    Text(startedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct FailedJobRow: View {
    let job: MonitoringData.FailedJob

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
            HStack {
                Text(job.orderName ?? "Job \(job.id.prefix(8))")
                    .font(.subheadline.bold())

                Spacer()

                StatusBadge(text: "FAILED", style: .error)
            }

            if let error = job.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            HStack {
                Text(job.ownerEmail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                Spacer()

                if let completedAt = job.completedAt {
                    Text(completedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
