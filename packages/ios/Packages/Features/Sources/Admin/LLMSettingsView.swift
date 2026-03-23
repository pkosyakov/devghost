import SwiftUI
import Core
import SharedUI

// MARK: - Models

struct LLMSettings: Decodable {
    let llmProvider: String
    let ollamaUrl: String
    let ollamaModel: String
    let openrouterApiKey: String
    let openrouterModel: String
    let openrouterKeySource: String
    let openrouterProviderOrder: String
    let openrouterProviderIgnore: String
    let openrouterAllowFallbacks: Bool
    let openrouterRequireParameters: Bool
    let openrouterInputPrice: Double
    let openrouterOutputPrice: Double
}

struct LLMSettingsUpdate: Encodable, Sendable {
    var llmProvider: String?
    var ollamaUrl: String?
    var ollamaModel: String?
    var openrouterApiKey: String?
    var openrouterModel: String?
    var openrouterProviderOrder: String?
    var openrouterProviderIgnore: String?
    var openrouterAllowFallbacks: Bool?
    var openrouterRequireParameters: Bool?
}

// MARK: - ViewModel

@MainActor
@Observable
final class LLMSettingsViewModel {
    var settings: LLMSettings?
    var isLoading = false
    var isSaving = false
    var error: String?
    var saveSuccess = false

    // Form fields
    var provider = "ollama"
    var ollamaUrl = "http://localhost:11434"
    var ollamaModel = ""
    var openrouterApiKey = ""
    var openrouterModel = ""
    var openrouterProviderOrder = ""
    var openrouterProviderIgnore = ""
    var allowFallbacks = true
    var requireParameters = true

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadSettings() async {
        isLoading = true
        error = nil
        do {
            let loaded: LLMSettings = try await apiClient.request(
                Endpoint(path: "/api/admin/llm-settings", method: .get)
            )
            settings = loaded
            provider = loaded.llmProvider
            ollamaUrl = loaded.ollamaUrl
            ollamaModel = loaded.ollamaModel
            openrouterApiKey = loaded.openrouterApiKey
            openrouterModel = loaded.openrouterModel
            openrouterProviderOrder = loaded.openrouterProviderOrder
            openrouterProviderIgnore = loaded.openrouterProviderIgnore
            allowFallbacks = loaded.openrouterAllowFallbacks
            requireParameters = loaded.openrouterRequireParameters
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func saveSettings() async {
        isSaving = true
        error = nil
        saveSuccess = false
        do {
            let update = LLMSettingsUpdate(
                llmProvider: provider,
                ollamaUrl: ollamaUrl,
                ollamaModel: ollamaModel,
                openrouterApiKey: openrouterApiKey.isEmpty ? nil : openrouterApiKey,
                openrouterModel: openrouterModel,
                openrouterProviderOrder: openrouterProviderOrder,
                openrouterProviderIgnore: openrouterProviderIgnore,
                openrouterAllowFallbacks: allowFallbacks,
                openrouterRequireParameters: requireParameters
            )
            let saved: LLMSettings = try await apiClient.request(
                Endpoint(path: "/api/admin/llm-settings", method: .patch, body: update)
            )
            settings = saved
            saveSuccess = true
        } catch {
            self.error = error.localizedDescription
        }
        isSaving = false
    }
}

// MARK: - View

public struct LLMSettingsView: View {
    @State private var viewModel: LLMSettingsViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: LLMSettingsViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.settings == nil {
                LoadingView(message: "Loading LLM settings...")
            } else if let error = viewModel.error, viewModel.settings == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadSettings() }
                }
            } else {
                settingsForm
            }
        }
        .navigationTitle("LLM Settings")
        .task {
            await viewModel.loadSettings()
        }
    }

    @ViewBuilder
    private var settingsForm: some View {
        Form {
            Section("Provider") {
                Picker("Provider", selection: $viewModel.provider) {
                    Text("Ollama").tag("ollama")
                    Text("OpenRouter").tag("openrouter")
                }
                .pickerStyle(.segmented)
            }

            if viewModel.provider == "ollama" {
                Section("Ollama Configuration") {
                    TextField("URL", text: $viewModel.ollamaUrl)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                    TextField("Model", text: $viewModel.ollamaModel)
                        .autocapitalization(.none)
                }
            }

            if viewModel.provider == "openrouter" {
                Section("OpenRouter Configuration") {
                    TextField("Model", text: $viewModel.openrouterModel)
                        .autocapitalization(.none)
                    SecureField("API Key", text: $viewModel.openrouterApiKey)
                    if let source = viewModel.settings?.openrouterKeySource, source != "none" {
                        HStack {
                            Text("Key source")
                                .foregroundStyle(.secondary)
                            Spacer()
                            StatusBadge(
                                text: source.uppercased(),
                                style: source == "db" ? .success : .info
                            )
                        }
                    }
                }

                Section("Routing") {
                    TextField("Provider Order (CSV)", text: $viewModel.openrouterProviderOrder)
                        .autocapitalization(.none)
                    TextField("Provider Ignore (CSV)", text: $viewModel.openrouterProviderIgnore)
                        .autocapitalization(.none)
                    Toggle("Allow Fallbacks", isOn: $viewModel.allowFallbacks)
                    Toggle("Require Parameters", isOn: $viewModel.requireParameters)
                }
            }

            Section {
                Button {
                    Task { await viewModel.saveSettings() }
                } label: {
                    HStack {
                        Spacer()
                        if viewModel.isSaving {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("Save Settings")
                        }
                        Spacer()
                    }
                }
                .disabled(viewModel.isSaving)
            }

            if viewModel.saveSuccess {
                Section {
                    Label("Settings saved successfully", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }

            if let error = viewModel.error, viewModel.settings != nil {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
        }
    }
}
