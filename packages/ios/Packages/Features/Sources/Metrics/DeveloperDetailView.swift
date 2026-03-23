import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class DeveloperDetailViewModel {
    private let apiClient: APIClient
    let orderId: String
    let developer: DeveloperMetric

    var timelineData: [EffortTimelineEntry] = []
    var settings: DeveloperSettings?
    var isLoadingTimeline = false
    var isLoadingSettings = false
    var isSavingSettings = false
    var error: Error?

    init(developer: DeveloperMetric, orderId: String, apiClient: APIClient = .shared) {
        self.developer = developer
        self.orderId = orderId
        self.apiClient = apiClient
    }

    func fetchTimeline() async {
        isLoadingTimeline = true
        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/effort-timeline",
                method: .get
            )
            let allEntries: [EffortTimelineEntry] = try await apiClient.request(endpoint)
            timelineData = allEntries.filter { $0.developer == developer.name }
            isLoadingTimeline = false
        } catch {
            self.error = error
            isLoadingTimeline = false
        }
    }

    func fetchSettings() async {
        isLoadingSettings = true
        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/developer-settings",
                method: .get
            )
            let allSettings: [DeveloperSettings] = try await apiClient.request(endpoint)
            settings = allSettings.first { $0.developerId == developer.email }
            isLoadingSettings = false
        } catch {
            self.error = error
            isLoadingSettings = false
        }
    }

    func saveSettings(share: Double?, excluded: Bool) async {
        isSavingSettings = true
        do {
            let body = DeveloperSettingsPatch(
                developerId: developer.email,
                share: share,
                isExcluded: excluded
            )
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/developer-settings",
                method: .patch,
                body: body
            )
            let _: [DeveloperSettings] = try await apiClient.request(endpoint)
            await fetchSettings()
            isSavingSettings = false
        } catch {
            self.error = error
            isSavingSettings = false
        }
    }
}

// MARK: - Patch Model

private struct DeveloperSettingsPatch: Encodable {
    let developerId: String
    let share: Double?
    let isExcluded: Bool
}

// MARK: - View

struct DeveloperDetailView: View {
    @State private var viewModel: DeveloperDetailViewModel
    @State private var showSettings = false

    init(developer: DeveloperMetric, orderId: String) {
        _viewModel = State(
            initialValue: DeveloperDetailViewModel(developer: developer, orderId: orderId)
        )
    }

    private var developer: DeveloperMetric { viewModel.developer }

    var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.lg) {
                headerSection
                kpiCards
                timelineSection
                distributionSection
            }
            .padding(AppTheme.Spacing.md)
        }
        .navigationTitle(developer.name)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            DeveloperSettingsSheet(viewModel: viewModel)
        }
        .task {
            await viewModel.fetchTimeline()
            await viewModel.fetchSettings()
        }
    }

    // MARK: - Subviews

    private var headerSection: some View {
        VStack(spacing: AppTheme.Spacing.sm) {
            GhostGauge(percent: developer.ghostPercent, size: 96)

            Text(developer.email)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if let adjusted = developer.adjustedGhostPercent {
                Text("Adjusted: \(adjusted, specifier: "%.1f")%")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(AppTheme.Spacing.md)
    }

    private var kpiCards: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible()),
                GridItem(.flexible())
            ],
            spacing: AppTheme.Spacing.md
        ) {
            KPICard(
                title: "Ghost%",
                value: String(format: "%.1f%%", developer.ghostPercent),
                icon: "ghost"
            )
            KPICard(
                title: "Hours",
                value: String(format: "%.1f", developer.totalEffortHours),
                icon: "clock"
            )
            KPICard(
                title: "Commits",
                value: "\(developer.commitCount)",
                icon: "point.3.filled.connected.trianglepath.dotted"
            )
            KPICard(
                title: "Work Days",
                value: "\(developer.workDays)",
                icon: "calendar"
            )
        }
    }

    @ViewBuilder
    private var timelineSection: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
            Text("Effort Timeline")
                .font(.headline)

            if viewModel.isLoadingTimeline {
                LoadingView()
                    .frame(height: 200)
            } else if viewModel.timelineData.isEmpty {
                ContentUnavailableView(
                    "No Timeline Data",
                    systemImage: "chart.xyaxis.line",
                    description: Text("No effort data available for this developer.")
                )
                .frame(height: 200)
            } else {
                EffortTimelineChart(
                    data: viewModel.timelineData.map { entry in
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

    @ViewBuilder
    private var distributionSection: some View {
        if !viewModel.timelineData.isEmpty {
            VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
                Text("Effort Distribution")
                    .font(.headline)

                DeveloperDistributionChart(
                    data: [
                        DeveloperDistributionChart.DataPoint(
                            name: developer.name,
                            totalEffortHours: developer.totalEffortHours,
                            commitCount: developer.commitCount,
                            share: developer.share ?? 1.0
                        )
                    ]
                )
            }
        }
    }
}

// MARK: - Settings Sheet

private struct DeveloperSettingsSheet: View {
    let viewModel: DeveloperDetailViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var shareOverride: Double = 1.0
    @State private var useCustomShare = false
    @State private var excluded = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Share Override") {
                    Toggle("Custom Share", isOn: $useCustomShare)

                    if useCustomShare {
                        HStack {
                            Slider(value: $shareOverride, in: 0.01...1.0, step: 0.01)
                            Text("\(Int(shareOverride * 100))%")
                                .monospacedDigit()
                                .frame(width: 44, alignment: .trailing)
                        }
                    }
                }

                Section("Exclusion") {
                    Toggle("Exclude from Analysis", isOn: $excluded)
                }

                if let error = viewModel.error {
                    Section {
                        Text(error.localizedDescription)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("Developer Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await viewModel.saveSettings(
                                share: useCustomShare ? shareOverride : nil,
                                excluded: excluded
                            )
                            if viewModel.error == nil {
                                dismiss()
                            }
                        }
                    }
                    .disabled(viewModel.isSavingSettings)
                }
            }
            .onAppear {
                if let settings = viewModel.settings {
                    if settings.share != 1.0 && !settings.shareAutoCalculated {
                        useCustomShare = true
                        shareOverride = settings.share
                    }
                    excluded = settings.isExcluded
                }
            }
        }
        .presentationDetents([.medium])
    }
}
