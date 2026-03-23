import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class ReferralViewModel {
    var referralInfo: ReferralInfo?
    var isLoading = false
    var error: String?
    var showCopiedToast = false

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadReferralInfo() async {
        isLoading = true
        error = nil
        do {
            referralInfo = try await apiClient.request(
                Endpoint(path: "/api/referral", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func copyReferralCode() {
        guard let code = referralInfo?.referralCode else { return }
        UIPasteboard.general.string = code
        showCopiedToast = true
    }
}

// MARK: - View

public struct ReferralView: View {
    @State private var viewModel: ReferralViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: ReferralViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.referralInfo == nil {
                LoadingView(message: "Loading referral info...")
            } else if let error = viewModel.error, viewModel.referralInfo == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadReferralInfo() }
                }
            } else if let info = viewModel.referralInfo {
                contentView(info)
            }
        }
        .navigationTitle("Referrals")
        .overlay(alignment: .bottom) {
            if viewModel.showCopiedToast {
                copiedToast
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            withAnimation { viewModel.showCopiedToast = false }
                        }
                    }
            }
        }
        .animation(.easeInOut, value: viewModel.showCopiedToast)
        .task {
            await viewModel.loadReferralInfo()
        }
    }

    @ViewBuilder
    private func contentView(_ info: ReferralInfo) -> some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.large) {
                referralCodeCard(info)
                statsSection(info.stats)
                referralsList(info.referrals)
            }
            .padding(AppTheme.Spacing.medium)
        }
    }

    @ViewBuilder
    private func referralCodeCard(_ info: ReferralInfo) -> some View {
        VStack(spacing: AppTheme.Spacing.medium) {
            Image(systemName: "gift.fill")
                .font(.system(size: 36))
                .foregroundStyle(AppTheme.Colors.primary)

            Text("Your Referral Code")
                .font(.headline)

            Text(info.referralCode)
                .font(.system(.title2, design: .monospaced).bold())
                .padding(.horizontal, AppTheme.Spacing.large)
                .padding(.vertical, AppTheme.Spacing.small)
                .background(AppTheme.Colors.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))

            Button {
                viewModel.copyReferralCode()
            } label: {
                Label("Copy Code", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)

            Text("Share this code with friends. Both of you earn credits when they sign up.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(AppTheme.Spacing.large)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private func statsSection(_ stats: ReferralStats) -> some View {
        HStack(spacing: AppTheme.Spacing.medium) {
            VStack(spacing: 4) {
                Text("\(stats.totalReferred)")
                    .font(.title2.bold().monospacedDigit())
                    .foregroundStyle(AppTheme.Colors.primary)
                Text("Referred")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(AppTheme.Spacing.medium)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))

            VStack(spacing: 4) {
                Text("\(stats.totalCreditsEarned)")
                    .font(.title2.bold().monospacedDigit())
                    .foregroundStyle(AppTheme.Colors.primary)
                Text("Credits Earned")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(AppTheme.Spacing.medium)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    @ViewBuilder
    private func referralsList(_ referrals: [ReferralEntry]) -> some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
            Text("Referral History")
                .font(.title3.bold())

            if referrals.isEmpty {
                EmptyStateView(
                    icon: "person.badge.plus",
                    title: "No Referrals Yet",
                    message: "Share your code to start earning credits."
                )
            } else {
                ForEach(referrals, id: \.id) { entry in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.referredEmail ?? "User")
                                .font(.subheadline.bold())
                            Text(entry.createdAt, style: .date)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        if let credits = entry.creditsEarned {
                            Text("+\(credits)")
                                .font(.subheadline.bold().monospacedDigit())
                                .foregroundStyle(.green)
                        }

                        if let status = entry.status {
                            StatusBadge(
                                text: status,
                                style: status == "completed" ? .success : .neutral
                            )
                        }
                    }
                    .padding(.vertical, AppTheme.Spacing.small)

                    if entry.id != referrals.last?.id {
                        Divider()
                    }
                }
            }
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var copiedToast: some View {
        Label("Copied to clipboard", systemImage: "checkmark.circle.fill")
            .font(.subheadline.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, AppTheme.Spacing.large)
            .padding(.vertical, AppTheme.Spacing.medium)
            .background(.green, in: Capsule())
            .padding(.bottom, AppTheme.Spacing.large)
    }
}
