import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class ExploreViewModel {
    var repos: [PublicRepo] = []
    var filteredRepos: [PublicRepo] = []
    var searchText = "" {
        didSet { filterRepos() }
    }
    var isLoading = false
    var error: String?

    let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadRepos() async {
        isLoading = true
        error = nil
        do {
            repos = try await apiClient.request(
                Endpoint(path: "/api/explore", method: .get)
            )
            filterRepos()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func filterRepos() {
        if searchText.isEmpty {
            filteredRepos = repos
        } else {
            let query = searchText.lowercased()
            filteredRepos = repos.filter { repo in
                repo.resolvedName.lowercased().contains(query) ||
                repo.resolvedOwner.lowercased().contains(query)
            }
        }
    }
}

// MARK: - View

public struct ExploreView: View {
    @State private var viewModel: ExploreViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: ExploreViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.repos.isEmpty {
                LoadingView(message: "Loading public repos...")
            } else if let error = viewModel.error, viewModel.repos.isEmpty {
                ErrorView(message: error) {
                    Task { await viewModel.loadRepos() }
                }
            } else if viewModel.filteredRepos.isEmpty && !viewModel.searchText.isEmpty {
                EmptyStateView(
                    icon: "magnifyingglass",
                    title: "No Results",
                    message: "No repositories match your search."
                )
            } else if viewModel.repos.isEmpty {
                EmptyStateView(
                    icon: "globe",
                    title: "No Public Repos",
                    message: "Published repositories will appear here."
                )
            } else {
                repoList
            }
        }
        .navigationTitle("Explore")
        .searchable(text: $viewModel.searchText, prompt: "Search repositories...")
        .refreshable {
            await viewModel.loadRepos()
        }
        .task {
            await viewModel.loadRepos()
        }
    }

    @ViewBuilder
    private var repoList: some View {
        ScrollView {
            LazyVStack(spacing: AppTheme.Spacing.small) {
                ForEach(viewModel.filteredRepos, id: \.id) { repo in
                    NavigationLink {
                        PublicDashboardView(owner: repo.resolvedOwner, repoName: repo.resolvedName, apiClient: viewModel.apiClient)
                    } label: {
                        PublicRepoRow(repo: repo)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(AppTheme.Spacing.medium)
        }
    }
}

// MARK: - Subviews

private struct PublicRepoRow: View {
    let repo: PublicRepo

    var body: some View {
        HStack(spacing: AppTheme.Spacing.medium) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Text(repo.resolvedOwner)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("/")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Text(repo.resolvedName)
                        .font(.subheadline.bold())
                }

                if let description = repo.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                HStack(spacing: AppTheme.Spacing.medium) {
                    if let stars = repo.stars {
                        Label("\(stars)", systemImage: "star.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    if let language = repo.language {
                        Label(language, systemImage: "chevron.left.forwardslash.chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            if let ghostPercent = repo.ghostPercent {
                GhostBadge(percent: ghostPercent)
            }

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct GhostBadge: View {
    let percent: Double

    private var color: Color {
        switch percent {
        case 120...: return .green
        case 100..<120: return .blue
        case 80..<100: return .orange
        default: return .red
        }
    }

    var body: some View {
        Text("\(Int(percent))%")
            .font(.caption.bold().monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color, in: Capsule())
    }
}
