import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class GitHubViewModel {
    var connectionStatus: GitHubConnectionStatus?
    var isLoading = false
    var error: String?
    var showDisconnectConfirmation = false
    var isDisconnecting = false

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    var isConnected: Bool {
        connectionStatus?.isConnected ?? false
    }

    func loadStatus() async {
        isLoading = true
        error = nil
        do {
            connectionStatus = try await apiClient.request(
                Endpoint(path: "/api/github/connect", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func disconnect() async {
        isDisconnecting = true
        do {
            let _: EmptyResponse = try await apiClient.request(
                Endpoint(path: "/api/github/connect", method: .delete)
            )
            connectionStatus = GitHubConnectionStatus(isConnected: false, username: nil, avatarUrl: nil)
        } catch {
            self.error = error.localizedDescription
        }
        isDisconnecting = false
    }
}

private struct EmptyResponse: Decodable {}

// MARK: - View

public struct GitHubConnectView: View {
    @State private var viewModel: GitHubViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: GitHubViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.connectionStatus == nil {
                LoadingView(message: "Checking GitHub connection...")
            } else if let error = viewModel.error, viewModel.connectionStatus == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadStatus() }
                }
            } else {
                contentView
            }
        }
        .navigationTitle("GitHub")
        .confirmationDialog(
            "Disconnect GitHub",
            isPresented: $viewModel.showDisconnectConfirmation,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await viewModel.disconnect() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove your GitHub connection. You can reconnect at any time.")
        }
        .task {
            await viewModel.loadStatus()
        }
    }

    @ViewBuilder
    private var contentView: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.extraLarge) {
                statusCard
                actionSection
                infoSection
            }
            .padding(AppTheme.Spacing.medium)
        }
    }

    @ViewBuilder
    private var statusCard: some View {
        VStack(spacing: AppTheme.Spacing.medium) {
            if viewModel.isConnected, let status = viewModel.connectionStatus {
                if let avatarUrl = status.avatarUrl, let url = URL(string: avatarUrl) {
                    AsyncImage(url: url) { image in
                        image
                            .resizable()
                            .scaledToFill()
                    } placeholder: {
                        Image(systemName: "person.circle.fill")
                            .resizable()
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 80, height: 80)
                    .clipShape(Circle())
                }

                if let username = status.username {
                    Text(username)
                        .font(.title2.bold())
                }

                Label("Connected", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            } else {
                Image(systemName: "link.badge.plus")
                    .font(.system(size: 48))
                    .foregroundStyle(.secondary)

                Text("Not Connected")
                    .font(.title2.bold())

                Text("Connect your GitHub account to access your repositories and analyze commit history.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(AppTheme.Spacing.large)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private var actionSection: some View {
        if viewModel.isConnected {
            Button(role: .destructive) {
                viewModel.showDisconnectConfirmation = true
            } label: {
                Label {
                    if viewModel.isDisconnecting {
                        ProgressView()
                    } else {
                        Text("Disconnect GitHub")
                    }
                } icon: {
                    Image(systemName: "xmark.circle")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isDisconnecting)
        } else {
            VStack(spacing: AppTheme.Spacing.medium) {
                Button {
                    // ASWebAuthenticationSession placeholder
                    // In production, this would initiate GitHub OAuth flow
                } label: {
                    Label("Connect with GitHub", systemImage: "link")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Text("OAuth authentication will open in a browser window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var infoSection: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
            Text("About GitHub Integration")
                .font(.headline)

            InfoRow(icon: "lock.shield", text: "Your token is stored securely on the server and never exposed to the client.")
            InfoRow(icon: "book.closed", text: "Access to your public and private repositories for analysis.")
            InfoRow(icon: "person.2", text: "Read contributor information for commit attribution.")
            InfoRow(icon: "arrow.counterclockwise", text: "You can disconnect and reconnect at any time.")
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct InfoRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: AppTheme.Spacing.small) {
            Image(systemName: icon)
                .foregroundStyle(AppTheme.Colors.primary)
                .frame(width: 24)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}
