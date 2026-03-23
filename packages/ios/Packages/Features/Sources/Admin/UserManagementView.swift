import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class UserManagementViewModel {
    var users: [User] = []
    var filteredUsers: [User] = []
    var searchText = "" {
        didSet { filterUsers() }
    }
    var isLoading = false
    var error: String?

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadUsers() async {
        isLoading = true
        error = nil
        do {
            users = try await apiClient.request(
                Endpoint(path: "/api/admin/users", method: .get)
            )
            filterUsers()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func filterUsers() {
        if searchText.isEmpty {
            filteredUsers = users
        } else {
            let query = searchText.lowercased()
            filteredUsers = users.filter { user in
                (user.name?.lowercased().contains(query) ?? false) ||
                user.email.lowercased().contains(query)
            }
        }
    }
}

// MARK: - View

public struct UserManagementView: View {
    @State private var viewModel: UserManagementViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: UserManagementViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.users.isEmpty {
                LoadingView(message: "Loading users...")
            } else if let error = viewModel.error, viewModel.users.isEmpty {
                ErrorView(message: error) {
                    Task { await viewModel.loadUsers() }
                }
            } else if viewModel.filteredUsers.isEmpty && !viewModel.searchText.isEmpty {
                EmptyStateView(
                    icon: "magnifyingglass",
                    title: "No Results",
                    message: "No users match your search."
                )
            } else {
                userList
            }
        }
        .navigationTitle("Users")
        .searchable(text: $viewModel.searchText, prompt: "Search by name or email...")
        .refreshable {
            await viewModel.loadUsers()
        }
        .task {
            await viewModel.loadUsers()
        }
    }

    @ViewBuilder
    private var userList: some View {
        List(viewModel.filteredUsers, id: \.id) { user in
            UserRow(user: user)
        }
    }
}

private struct UserRow: View {
    let user: User

    var body: some View {
        HStack(spacing: AppTheme.Spacing.medium) {
            if let avatarUrl = user.image, let url = URL(string: avatarUrl) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.circle.fill")
                        .resizable()
                        .foregroundStyle(.secondary)
                }
                .frame(width: 40, height: 40)
                .clipShape(Circle())
            } else {
                Image(systemName: "person.circle.fill")
                    .resizable()
                    .frame(width: 40, height: 40)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(user.name ?? "Unnamed")
                    .font(.subheadline.bold())
                Text(user.email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let createdAt = user.createdAt {
                    Text("Joined \(createdAt, style: .date)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            StatusBadge(
                text: user.role.rawValue,
                style: user.role == .admin ? .warning : .neutral
            )
        }
        .padding(.vertical, 2)
    }
}
