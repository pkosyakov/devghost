import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class RegisterViewModel {
    var name = ""
    var email = ""
    var password = ""
    var confirmPassword = ""
    var isLoading = false
    var errorMessage: String?

    let apiClient: APIClient
    let authManager: AuthManager

    init(apiClient: APIClient, authManager: AuthManager) {
        self.apiClient = apiClient
        self.authManager = authManager
    }

    var isFormValid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !email.trimmingCharacters(in: .whitespaces).isEmpty
            && password.count >= 8
            && password == confirmPassword
    }

    var passwordMismatch: Bool {
        !confirmPassword.isEmpty && password != confirmPassword
    }

    var passwordTooShort: Bool {
        !password.isEmpty && password.count < 8
    }

    func register() async {
        guard isFormValid else { return }

        isLoading = true
        errorMessage = nil

        do {
            // Step 1: Register
            let registerBody = RegisterRequest(
                name: name.trimmingCharacters(in: .whitespaces),
                email: email.trimmingCharacters(in: .whitespaces).lowercased(),
                password: password
            )

            let registerEndpoint = Endpoint(
                path: "/api/auth/register",
                method: .post,
                body: registerBody
            )

            let _: RegisterResponse = try await apiClient.request(registerEndpoint)

            // Step 2: Auto-login after registration
            let loginBody = LoginAfterRegisterRequest(
                email: email.trimmingCharacters(in: .whitespaces).lowercased(),
                password: password,
                deviceId: authManager.deviceId
            )

            let loginEndpoint = Endpoint(
                path: "/api/auth/mobile/login",
                method: .post,
                body: loginBody
            )

            let authResponse: AuthResponse = try await apiClient.request(loginEndpoint)
            try authManager.saveTokens(
                accessToken: authResponse.accessToken,
                refreshToken: authResponse.refreshToken,
                expiresIn: authResponse.expiresIn
            )
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Registration failed. Please try again."
        }

        isLoading = false
    }
}

// MARK: - Request / Response

private struct RegisterRequest: Encodable {
    let name: String
    let email: String
    let password: String
}

private struct RegisterResponse: Decodable {
    let id: String
    let email: String
    let name: String
}

private struct LoginAfterRegisterRequest: Encodable {
    let email: String
    let password: String
    let deviceId: String
}

// MARK: - View

public struct RegisterView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: RegisterViewModel

    public init(apiClient: APIClient, authManager: AuthManager) {
        _viewModel = State(initialValue: RegisterViewModel(
            apiClient: apiClient,
            authManager: authManager
        ))
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.xl) {
                headerSection
                formSection
                registerButton
                loginLink
            }
            .padding(.horizontal, AppTheme.Spacing.lg)
            .padding(.top, AppTheme.Spacing.lg)
        }
        .navigationTitle("Create Account")
        .navigationBarTitleDisplayMode(.large)
        .navigationBarBackButtonHidden()
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .fontWeight(.semibold)
                }
            }
        }
    }

    // MARK: - Subviews

    private var headerSection: some View {
        VStack(spacing: AppTheme.Spacing.sm) {
            Image(systemName: "person.badge.plus")
                .font(.system(size: 44))
                .foregroundStyle(AppTheme.Colors.primary)

            Text("Get started with DevGhost")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, AppTheme.Spacing.md)
    }

    private var formSection: some View {
        VStack(spacing: AppTheme.Spacing.md) {
            if let error = viewModel.errorMessage {
                errorBanner(error)
            }

            fieldGroup(label: "Name", systemImage: "person") {
                TextField("Your name", text: $viewModel.name)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
            }

            fieldGroup(label: "Email", systemImage: "envelope") {
                TextField("you@example.com", text: $viewModel.email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            fieldGroup(label: "Password", systemImage: "lock") {
                SecureField("Minimum 8 characters", text: $viewModel.password)
                    .textContentType(.newPassword)
            }

            if viewModel.passwordTooShort {
                validationHint("Password must be at least 8 characters", icon: "xmark.circle.fill")
            }

            fieldGroup(label: "Confirm Password", systemImage: "lock.fill") {
                SecureField("Repeat your password", text: $viewModel.confirmPassword)
                    .textContentType(.newPassword)
            }

            if viewModel.passwordMismatch {
                validationHint("Passwords do not match", icon: "xmark.circle.fill")
            }
        }
    }

    private var registerButton: some View {
        Button {
            Task { await viewModel.register() }
        } label: {
            Group {
                if viewModel.isLoading {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text("Create Account")
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

    private var loginLink: some View {
        HStack(spacing: AppTheme.Spacing.xs) {
            Text("Already have an account?")
                .foregroundStyle(.secondary)

            Button("Sign In") {
                dismiss()
            }
            .fontWeight(.semibold)
        }
        .font(.subheadline)
    }

    // MARK: - Helpers

    private func fieldGroup<Content: View>(
        label: String,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
            Label(label, systemImage: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)

            content()
                .padding(AppTheme.Spacing.md)
                .background(AppTheme.Colors.surfaceSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func validationHint(_ text: String, icon: String) -> some View {
        HStack(spacing: AppTheme.Spacing.xs) {
            Image(systemName: icon)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, AppTheme.Spacing.xs)
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
