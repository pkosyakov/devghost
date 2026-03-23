import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class ProfileViewModel {
    var user: User?
    var isLoading = false
    var error: String?
    var showEditSheet = false
    var editName = ""
    var isSaving = false
    var showLogoutConfirmation = false

    private let apiClient: APIClient
    private let authManager: AuthManager

    init(apiClient: APIClient, authManager: AuthManager) {
        self.apiClient = apiClient
        self.authManager = authManager
    }

    func loadProfile() async {
        isLoading = true
        error = nil
        do {
            user = try await apiClient.request(
                Endpoint(path: "/api/user/profile", method: .get)
            )
            editName = user?.name ?? ""
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func saveProfile() async {
        isSaving = true
        struct UpdateBody: Encodable {
            let name: String
        }
        do {
            user = try await apiClient.request(
                Endpoint(
                    path: "/api/user/profile",
                    method: .patch,
                    body: UpdateBody(name: editName)
                )
            )
            showEditSheet = false
        } catch {
            self.error = error.localizedDescription
        }
        isSaving = false
    }

    func logout() async {
        do {
            struct Empty: Decodable {}
            let _: Empty = try await apiClient.request(
                Endpoint(path: "/api/auth/mobile/logout", method: .post)
            )
        } catch {
            // Server logout failed — clear local state anyway
        }
        authManager.logout()
    }
}

// MARK: - View

public struct ProfileView: View {
    @State private var viewModel: ProfileViewModel
    private let apiClient: APIClient

    public init(apiClient: APIClient, authManager: AuthManager) {
        self.apiClient = apiClient
        _viewModel = State(initialValue: ProfileViewModel(apiClient: apiClient, authManager: authManager))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.user == nil {
                LoadingView(message: "Loading profile...")
            } else if let error = viewModel.error, viewModel.user == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadProfile() }
                }
            } else {
                contentView
            }
        }
        .navigationTitle("Profile")
        .sheet(isPresented: $viewModel.showEditSheet) {
            editSheet
        }
        .confirmationDialog(
            "Log Out",
            isPresented: $viewModel.showLogoutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Log Out", role: .destructive) {
                Task { await viewModel.logout() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Are you sure you want to log out?")
        }
        .task {
            await viewModel.loadProfile()
        }
    }

    @ViewBuilder
    private var contentView: some View {
        List {
            if let user = viewModel.user {
                userInfoSection(user)
            }
            navigationSection
            accountSection
        }
        .refreshable {
            await viewModel.loadProfile()
        }
    }

    @ViewBuilder
    private func userInfoSection(_ user: User) -> some View {
        Section {
            HStack(spacing: AppTheme.Spacing.medium) {
                if let avatarUrl = user.image, let url = URL(string: avatarUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Image(systemName: "person.circle.fill")
                            .resizable()
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 64, height: 64)
                    .clipShape(Circle())
                } else {
                    Image(systemName: "person.circle.fill")
                        .resizable()
                        .frame(width: 64, height: 64)
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(user.name ?? "Unknown")
                        .font(.headline)
                    Text(user.email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    StatusBadge(
                        text: user.role.rawValue,
                        style: user.role == .admin ? .warning : .neutral
                    )
                }
            }
            .padding(.vertical, AppTheme.Spacing.small)

            Button {
                viewModel.editName = viewModel.user?.name ?? ""
                viewModel.showEditSheet = true
            } label: {
                Label("Edit Profile", systemImage: "pencil")
            }
        }
    }

    @ViewBuilder
    private var navigationSection: some View {
        Section("Connected Services") {
            NavigationLink {
                GitHubConnectView(apiClient: apiClient)
            } label: {
                Label("GitHub", systemImage: "link")
            }

            NavigationLink {
                ReferralView(apiClient: apiClient)
            } label: {
                Label("Referrals", systemImage: "gift")
            }

            NavigationLink {
                SettingsView()
            } label: {
                Label("Settings", systemImage: "gear")
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        Section {
            Button(role: .destructive) {
                viewModel.showLogoutConfirmation = true
            } label: {
                Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private var editSheet: some View {
        NavigationStack {
            Form {
                Section("Display Name") {
                    TextField("Name", text: $viewModel.editName)
                        .textContentType(.name)
                }
            }
            .navigationTitle("Edit Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        viewModel.showEditSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await viewModel.saveProfile() }
                    } label: {
                        if viewModel.isSaving {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(viewModel.editName.trimmingCharacters(in: .whitespaces).isEmpty || viewModel.isSaving)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
