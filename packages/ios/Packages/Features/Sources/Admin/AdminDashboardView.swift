import SwiftUI
import Core
import SharedUI

// MARK: - Models

struct AdminStats: Decodable {
    let totalUsers: Int
    let totalOrders: Int
    let activeAnalyses: Int
    let revenue: Double?
}

// MARK: - ViewModel

@MainActor
@Observable
final class AdminViewModel {
    var stats: AdminStats?
    var isLoading = false
    var error: String?

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadStats() async {
        isLoading = true
        error = nil
        do {
            stats = try await apiClient.request(
                Endpoint(path: "/api/admin/stats", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - View

public struct AdminDashboardView: View {
    @State private var viewModel: AdminViewModel
    private let apiClient: APIClient

    public init(apiClient: APIClient) {
        self.apiClient = apiClient
        _viewModel = State(initialValue: AdminViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.stats == nil {
                LoadingView(message: "Loading admin stats...")
            } else if let error = viewModel.error, viewModel.stats == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadStats() }
                }
            } else {
                contentView
            }
        }
        .navigationTitle("Admin")
        .task {
            await viewModel.loadStats()
        }
    }

    @ViewBuilder
    private var contentView: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.large) {
                statsGrid
                managementSection
            }
            .padding(AppTheme.Spacing.medium)
        }
        .refreshable {
            await viewModel.loadStats()
        }
    }

    @ViewBuilder
    private var statsGrid: some View {
        if let stats = viewModel.stats {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: AppTheme.Spacing.medium) {
                KPICard(
                    title: "Total Users",
                    value: "\(stats.totalUsers)",
                    icon: "person.2.fill"
                )
                KPICard(
                    title: "Total Orders",
                    value: "\(stats.totalOrders)",
                    icon: "doc.text.fill"
                )
                KPICard(
                    title: "Active Analyses",
                    value: "\(stats.activeAnalyses)",
                    icon: "gearshape.2.fill"
                )
                KPICard(
                    title: "Revenue",
                    value: stats.revenue.map { String(format: "$%.0f", $0) } ?? "--",
                    icon: "dollarsign.circle.fill"
                )
            }
        }
    }

    @ViewBuilder
    private var managementSection: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
            Text("Management")
                .font(.title3.bold())

            NavigationLink {
                UserManagementView(apiClient: apiClient)
            } label: {
                ManagementRow(
                    icon: "person.2",
                    title: "User Management",
                    subtitle: "View and manage users"
                )
            }
            .buttonStyle(.plain)

            NavigationLink {
                OrderManagementView(apiClient: apiClient)
            } label: {
                ManagementRow(
                    icon: "doc.text",
                    title: "Order Management",
                    subtitle: "View and manage all orders"
                )
            }
            .buttonStyle(.plain)

            NavigationLink {
                LLMSettingsView(apiClient: apiClient)
            } label: {
                ManagementRow(
                    icon: "cpu",
                    title: "LLM Settings",
                    subtitle: "Configure LLM provider and model"
                )
            }
            .buttonStyle(.plain)

            NavigationLink {
                PromoCodesView(apiClient: apiClient)
            } label: {
                ManagementRow(
                    icon: "tag",
                    title: "Promo Codes",
                    subtitle: "Create and manage promo codes"
                )
            }
            .buttonStyle(.plain)

            NavigationLink {
                MonitoringView(apiClient: apiClient)
            } label: {
                ManagementRow(
                    icon: "waveform.path.ecg",
                    title: "Monitoring",
                    subtitle: "System health and active jobs"
                )
            }
            .buttonStyle(.plain)

            NavigationLink {
                AuditLogView(apiClient: apiClient)
            } label: {
                ManagementRow(
                    icon: "list.bullet.clipboard",
                    title: "Audit Log",
                    subtitle: "User action history"
                )
            }
            .buttonStyle(.plain)
        }
    }
}

private struct ManagementRow: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: AppTheme.Spacing.medium) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(AppTheme.Colors.primary)
                .frame(width: 40, height: 40)
                .background(AppTheme.Colors.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.bold())
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
