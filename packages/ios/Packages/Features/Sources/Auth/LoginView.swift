import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class LoginViewModel {
    var email = ""
    var password = ""
    var isLoading = false
    var errorMessage: String?

    let apiClient: APIClient
    let authManager: AuthManager

    init(apiClient: APIClient, authManager: AuthManager) {
        self.apiClient = apiClient
        self.authManager = authManager
    }

    var isFormValid: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.isEmpty
    }

    func login() async {
        guard isFormValid else { return }

        isLoading = true
        errorMessage = nil

        do {
            let body = LoginRequest(
                email: email.trimmingCharacters(in: .whitespaces).lowercased(),
                password: password,
                deviceId: authManager.deviceId
            )

            let endpoint = Endpoint(
                path: "/api/auth/mobile/login",
                method: .post,
                body: body
            )

            let response: AuthResponse = try await apiClient.request(endpoint)
            try authManager.saveTokens(
                accessToken: response.accessToken,
                refreshToken: response.refreshToken,
                expiresIn: response.expiresIn
            )
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Connection failed. Please check your network and try again."
        }

        isLoading = false
    }
}

// MARK: - Request / Response

private struct LoginRequest: Encodable {
    let email: String
    let password: String
    let deviceId: String
}

struct AuthResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
}

// MARK: - View

public struct LoginView: View {
    @State private var viewModel: LoginViewModel
    @State private var showRegister = false

    public init(apiClient: APIClient, authManager: AuthManager) {
        _viewModel = State(initialValue: LoginViewModel(
            apiClient: apiClient,
            authManager: authManager
        ))
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: AppTheme.Spacing.xl) {
                    headerSection
                    formSection
                    loginButton
                    registerLink
                }
                .padding(.horizontal, AppTheme.Spacing.lg)
                .padding(.top, AppTheme.Spacing.xxl)
            }
            .navigationTitle("Sign In")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(isPresented: $showRegister) {
                RegisterView(
                    apiClient: viewModel.apiClient,
                    authManager: viewModel.authManager
                )
            }
        }
    }

    // MARK: - Subviews

    private var headerSection: some View {
        VStack(spacing: AppTheme.Spacing.sm) {
            Image(systemName: "ghost.fill")
                .font(.system(size: 56))
                .foregroundStyle(AppTheme.Colors.primary)

            Text("DevGhost")
                .font(.title.bold())
                .foregroundStyle(AppTheme.Colors.primary)

            Text("Developer Efficiency Analytics")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, AppTheme.Spacing.lg)
    }

    private var formSection: some View {
        VStack(spacing: AppTheme.Spacing.md) {
            if let error = viewModel.errorMessage {
                errorBanner(error)
            }

            VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
                Text("Email")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)

                TextField("you@example.com", text: $viewModel.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(AppTheme.Spacing.md)
                    .background(AppTheme.Colors.surfaceSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
                Text("Password")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)

                SecureField("Enter your password", text: $viewModel.password)
                    .textContentType(.password)
                    .padding(AppTheme.Spacing.md)
                    .background(AppTheme.Colors.surfaceSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private var loginButton: some View {
        Button {
            Task { await viewModel.login() }
        } label: {
            Group {
                if viewModel.isLoading {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text("Sign In")
                        .font(.headline)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(AppTheme.Spacing.md)
        }
        .buttonStyle(.borderedProminent)
        .tint(AppTheme.Colors.primary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .disabled(!viewModel.isFormValid || viewModel.isLoading)
    }

    private var registerLink: some View {
        HStack(spacing: AppTheme.Spacing.xs) {
            Text("Don't have an account?")
                .foregroundStyle(.secondary)

            Button("Create one") {
                showRegister = true
            }
            .fontWeight(.semibold)
        }
        .font(.subheadline)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: AppTheme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(AppTheme.Spacing.md)
        .background(Color.red.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

