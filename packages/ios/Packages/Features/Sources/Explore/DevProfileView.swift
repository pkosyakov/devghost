import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class DevProfileViewModel {
    var profile: DeveloperProfile?
    var isLoading = false
    var error: String?

    private let apiClient: APIClient
    let slug: String

    init(slug: String, apiClient: APIClient) {
        self.slug = slug
        self.apiClient = apiClient
    }

    func loadProfile() async {
        isLoading = true
        error = nil
        do {
            profile = try await apiClient.request(
                Endpoint(path: "/api/dev/\(slug)", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - View

public struct DevProfileView: View {
    @State private var viewModel: DevProfileViewModel

    public init(slug: String, apiClient: APIClient) {
        _viewModel = State(initialValue: DevProfileViewModel(slug: slug, apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading {
                LoadingView(message: "Loading profile...")
            } else if let error = viewModel.error {
                ErrorView(message: error) {
                    Task { await viewModel.loadProfile() }
                }
            } else if let profile = viewModel.profile {
                profileContent(profile)
            }
        }
        .navigationTitle(viewModel.profile?.displayName ?? viewModel.slug)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadProfile()
        }
    }

    @ViewBuilder
    private func profileContent(_ profile: DeveloperProfile) -> some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.large) {
                headerSection(profile)
                statsSection(profile)
                reposSection(profile)
            }
            .padding(AppTheme.Spacing.medium)
        }
    }

    @ViewBuilder
    private func headerSection(_ profile: DeveloperProfile) -> some View {
        VStack(spacing: AppTheme.Spacing.medium) {
            if let avatarUrl = profile.avatarUrl, let url = URL(string: avatarUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFill()
                } placeholder: {
                    Image(systemName: "person.circle.fill")
                        .resizable()
                        .foregroundStyle(.secondary)
                }
                .frame(width: 96, height: 96)
                .clipShape(Circle())
            } else {
                Image(systemName: "person.circle.fill")
                    .resizable()
                    .frame(width: 96, height: 96)
                    .foregroundStyle(.secondary)
            }

            Text(profile.displayName)
                .font(.title2.bold())

            if let bio = profile.bio, !bio.isEmpty {
                Text(bio)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if let location = profile.location, !location.isEmpty {
                Label(location, systemImage: "mappin.and.ellipse")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(AppTheme.Spacing.large)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private func statsSection(_ profile: DeveloperProfile) -> some View {
        if let stats = profile.stats {
            LazyVGrid(columns: [
                GridItem(.flexible()),
                GridItem(.flexible()),
                GridItem(.flexible())
            ], spacing: AppTheme.Spacing.medium) {
                StatItem(title: "Ghost%", value: stats.avgGhostPercent.map { "\(Int($0))%" } ?? "--")
                StatItem(title: "Repos", value: "\(stats.repoCount ?? 0)")
                StatItem(title: "Commits", value: "\(stats.commitCount ?? 0)")
            }
        }
    }

    @ViewBuilder
    private func reposSection(_ profile: DeveloperProfile) -> some View {
        if let repos = profile.repos, !repos.isEmpty {
            VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
                Text("Public Repositories")
                    .font(.title3.bold())

                ForEach(repos, id: \.id) { repo in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(repo.repoFullName)
                                .font(.subheadline.bold())
                            if let ghostPercent = repo.ghostPercent {
                                Text("Ghost%: \(Int(ghostPercent))%")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(AppTheme.Spacing.small)

                    if repo.id != repos.last?.id {
                        Divider()
                    }
                }
            }
            .padding(AppTheme.Spacing.medium)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        } else {
            EmptyStateView(
                icon: "folder",
                title: "No Public Repos",
                message: "This developer has no published repositories yet."
            )
        }
    }
}

private struct StatItem: View {
    let title: String
    let value: String

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title3.bold().monospacedDigit())
                .foregroundStyle(AppTheme.Colors.primary)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
