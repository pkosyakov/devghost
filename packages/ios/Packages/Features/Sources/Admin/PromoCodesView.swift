import SwiftUI
import Core
import SharedUI

// MARK: - Models

struct PromoCode: Decodable, Identifiable {
    let id: String
    let code: String
    let credits: Int
    let maxRedemptions: Int?
    let redemptionCount: Int
    let isActive: Bool
    let expiresAt: Date
    let description: String?
    let createdAt: Date
}

struct PromoCodesResponse: Decodable {
    let promoCodes: [PromoCode]
    let pagination: Pagination

    struct Pagination: Decodable {
        let page: Int
        let pageSize: Int
        let total: Int
        let totalPages: Int
    }
}

struct CreatePromoCodeRequest: Encodable, Sendable {
    let code: String
    let credits: Int
    let maxRedemptions: Int?
    let expiresAt: String
    let description: String?
}

struct DeactivateRequest: Encodable, Sendable {
    let isActive: Bool
}

// MARK: - ViewModel

@MainActor
@Observable
final class PromoCodesViewModel {
    var promoCodes: [PromoCode] = []
    var isLoading = false
    var error: String?
    var showCreateSheet = false

    // Create form
    var newCode = ""
    var newCredits = 100
    var newMaxRedemptions: Int? = nil
    var newExpiresAt = Calendar.current.date(byAdding: .month, value: 1, to: Date())!
    var newDescription = ""
    var isCreating = false

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadPromoCodes() async {
        isLoading = true
        error = nil
        do {
            let response: PromoCodesResponse = try await apiClient.request(
                Endpoint(path: "/api/admin/promo-codes", method: .get)
            )
            promoCodes = response.promoCodes
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func createPromoCode() async {
        isCreating = true
        error = nil
        do {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            let request = CreatePromoCodeRequest(
                code: newCode.uppercased(),
                credits: newCredits,
                maxRedemptions: newMaxRedemptions,
                expiresAt: formatter.string(from: newExpiresAt),
                description: newDescription.isEmpty ? nil : newDescription
            )
            struct CreateResponse: Decodable {}
            let _: CreateResponse = try await apiClient.request(
                Endpoint(path: "/api/admin/promo-codes", method: .post, body: request)
            )
            resetCreateForm()
            showCreateSheet = false
            await loadPromoCodes()
        } catch {
            self.error = error.localizedDescription
        }
        isCreating = false
    }

    func deactivate(_ promoCode: PromoCode) async {
        error = nil
        do {
            let body = DeactivateRequest(isActive: false)
            struct PatchResponse: Decodable {}
            let _: PatchResponse = try await apiClient.request(
                Endpoint(
                    path: "/api/admin/promo-codes/\(promoCode.id)",
                    method: .patch,
                    body: body
                )
            )
            await loadPromoCodes()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func resetCreateForm() {
        newCode = ""
        newCredits = 100
        newMaxRedemptions = nil
        newExpiresAt = Calendar.current.date(byAdding: .month, value: 1, to: Date())!
        newDescription = ""
    }
}

// MARK: - View

public struct PromoCodesView: View {
    @State private var viewModel: PromoCodesViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: PromoCodesViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.promoCodes.isEmpty {
                LoadingView(message: "Loading promo codes...")
            } else if let error = viewModel.error, viewModel.promoCodes.isEmpty {
                ErrorView(message: error) {
                    Task { await viewModel.loadPromoCodes() }
                }
            } else if viewModel.promoCodes.isEmpty {
                EmptyStateView(
                    icon: "tag",
                    title: "No Promo Codes",
                    message: "Create your first promo code."
                )
            } else {
                promoList
            }
        }
        .navigationTitle("Promo Codes")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.showCreateSheet = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $viewModel.showCreateSheet) {
            createSheet
        }
        .refreshable {
            await viewModel.loadPromoCodes()
        }
        .task {
            await viewModel.loadPromoCodes()
        }
    }

    @ViewBuilder
    private var promoList: some View {
        List(viewModel.promoCodes) { promo in
            PromoCodeRow(promo: promo)
                .swipeActions(edge: .trailing) {
                    if promo.isActive {
                        Button("Deactivate") {
                            Task { await viewModel.deactivate(promo) }
                        }
                        .tint(.red)
                    }
                }
        }
    }

    @ViewBuilder
    private var createSheet: some View {
        NavigationStack {
            Form {
                Section("Code") {
                    TextField("Code (e.g. WELCOME50)", text: $viewModel.newCode)
                        .autocapitalization(.allCharacters)
                        .autocorrectionDisabled()
                }

                Section("Value") {
                    Stepper("Credits: \(viewModel.newCredits)", value: $viewModel.newCredits, in: 1...10000, step: 10)
                }

                Section("Limits") {
                    Toggle("Unlimited Redemptions", isOn: Binding(
                        get: { viewModel.newMaxRedemptions == nil },
                        set: { viewModel.newMaxRedemptions = $0 ? nil : 100 }
                    ))
                    if let max = viewModel.newMaxRedemptions {
                        Stepper("Max Redemptions: \(max)", value: Binding(
                            get: { viewModel.newMaxRedemptions ?? 100 },
                            set: { viewModel.newMaxRedemptions = $0 }
                        ), in: 1...100000)
                    }
                    DatePicker("Expires", selection: $viewModel.newExpiresAt, displayedComponents: .date)
                }

                Section("Description") {
                    TextField("Optional description", text: $viewModel.newDescription)
                }

                if let error = viewModel.error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle("New Promo Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        viewModel.showCreateSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await viewModel.createPromoCode() }
                    } label: {
                        if viewModel.isCreating {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("Create")
                        }
                    }
                    .disabled(viewModel.newCode.isEmpty || viewModel.isCreating)
                }
            }
        }
    }
}

// MARK: - Row

private struct PromoCodeRow: View {
    let promo: PromoCode

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
            HStack {
                Text(promo.code)
                    .font(.subheadline.bold().monospaced())

                Spacer()

                StatusBadge(
                    text: promo.isActive ? "Active" : "Inactive",
                    style: promo.isActive ? .success : .neutral
                )
            }

            HStack(spacing: AppTheme.Spacing.medium) {
                Label("\(promo.credits) credits", systemImage: "creditcard")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Label(
                    "\(promo.redemptionCount)/\(promo.maxRedemptions.map(String.init) ?? "inf")",
                    systemImage: "person.2"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            HStack {
                if let desc = promo.description {
                    Text(desc)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }

                Spacer()

                Text("Expires \(promo.expiresAt, style: .date)")
                    .font(.caption2)
                    .foregroundStyle(promo.expiresAt < Date() ? .red : .tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
