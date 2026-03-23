import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class BillingViewModel {
    var balance: BalanceInfo?
    var packs: [CreditPack] = []
    var subscriptions: [SubscriptionInfo] = []
    var transactions: [CreditTransaction] = []
    var pagination: Pagination?
    var isLoading = false
    var error: String?
    var isRedeemingPromo = false
    var promoCode = ""
    var promoMessage: String?
    var promoError: String?
    var showPromoSheet = false

    private let apiClient: APIClient
    private var currentPage = 1
    private let pageSize = 20

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadAll() async {
        isLoading = true
        error = nil
        do {
            async let balanceReq: BalanceResponse = apiClient.request(
                Endpoint(path: "/api/billing/balance", method: .get)
            )
            async let packsReq: [CreditPack] = apiClient.request(
                Endpoint(path: "/api/billing/packs", method: .get)
            )
            async let subsReq: [SubscriptionInfo] = apiClient.request(
                Endpoint(path: "/api/billing/subscriptions", method: .get)
            )

            let (balanceResult, packsResult, subsResult) = try await (balanceReq, packsReq, subsReq)
            balance = balanceResult.balance
            packs = packsResult
            subscriptions = subsResult
            currentPage = 1
            try await loadTransactions(page: 1)
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func loadTransactions(page: Int) async throws {
        struct TransactionResponse: Decodable {
            let transactions: [CreditTransaction]
            let pagination: Pagination
        }
        let endpoint = Endpoint(
            path: "/api/billing/transactions",
            method: .get,
            queryItems: [
                URLQueryItem(name: "page", value: "\(page)"),
                URLQueryItem(name: "limit", value: "\(pageSize)")
            ]
        )
        let result: TransactionResponse = try await apiClient.request(endpoint)
        if page == 1 {
            transactions = result.transactions
        } else {
            transactions.append(contentsOf: result.transactions)
        }
        pagination = result.pagination
        currentPage = page
    }

    func loadNextPage() async {
        guard let pagination, currentPage < pagination.totalPages else { return }
        try? await loadTransactions(page: currentPage + 1)
    }

    func redeemPromo() async {
        guard !promoCode.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        isRedeemingPromo = true
        promoError = nil
        promoMessage = nil

        struct RedeemBody: Encodable {
            let code: String
        }
        struct RedeemResponse: Decodable {
            let credits: Int
            let message: String
        }

        do {
            let result: RedeemResponse = try await apiClient.request(
                Endpoint(
                    path: "/api/billing/redeem",
                    method: .post,
                    body: RedeemBody(code: promoCode.trimmingCharacters(in: .whitespaces))
                )
            )
            promoMessage = result.message
            promoCode = ""
            await loadAll()
        } catch {
            promoError = error.localizedDescription
        }
        isRedeemingPromo = false
    }
}

// MARK: - View

public struct BillingDashboardView: View {
    @State private var viewModel: BillingViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: BillingViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.balance == nil {
                LoadingView(message: "Loading billing info...")
            } else if let error = viewModel.error, viewModel.balance == nil {
                ErrorView(message: error) {
                    Task { await viewModel.loadAll() }
                }
            } else {
                contentView
            }
        }
        .navigationTitle("Billing")
        .sheet(isPresented: $viewModel.showPromoSheet) {
            promoSheet
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    viewModel.showPromoSheet = true
                } label: {
                    Image(systemName: "ticket")
                }
            }
        }
        .task {
            await viewModel.loadAll()
        }
    }

    @ViewBuilder
    private var contentView: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.large) {
                balanceCard
                packsSection
                subscriptionSection
                transactionSection
            }
            .padding(AppTheme.Spacing.medium)
        }
        .refreshable {
            await viewModel.loadAll()
        }
    }

    // MARK: - Balance Card

    @ViewBuilder
    private var balanceCard: some View {
        if let balance = viewModel.balance {
            VStack(spacing: AppTheme.Spacing.medium) {
                Text("\(balance.available)")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .foregroundStyle(AppTheme.Colors.primary)

                Text("Available Credits")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Divider()

                HStack(spacing: AppTheme.Spacing.large) {
                    VStack(spacing: 4) {
                        Text("\(balance.permanent)")
                            .font(.headline)
                        Text("Permanent")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 4) {
                        Text("\(balance.subscription)")
                            .font(.headline)
                        Text("Subscription")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 4) {
                        Text("\(balance.reserved)")
                            .font(.headline)
                        Text("Reserved")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let expires = balance.subscriptionExpiresAt {
                    Text("Subscription expires: \(expires, style: .date)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(AppTheme.Spacing.large)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    // MARK: - Credit Packs

    @ViewBuilder
    private var packsSection: some View {
        if !viewModel.packs.isEmpty {
            VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
                Text("Credit Packs")
                    .font(.title3.bold())

                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible())
                ], spacing: AppTheme.Spacing.medium) {
                    ForEach(viewModel.packs, id: \.id) { pack in
                        CreditPackCard(pack: pack) {
                            // StoreKit 2 purchase placeholder
                        }
                    }
                }
            }
        }
    }

    // MARK: - Subscriptions

    @ViewBuilder
    private var subscriptionSection: some View {
        if !viewModel.subscriptions.isEmpty {
            VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
                Text("Active Subscriptions")
                    .font(.title3.bold())

                ForEach(viewModel.subscriptions, id: \.id) { sub in
                    SubscriptionCard(subscription: sub)
                }
            }
        }
    }

    // MARK: - Transactions

    @ViewBuilder
    private var transactionSection: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
            Text("Transaction History")
                .font(.title3.bold())

            if viewModel.transactions.isEmpty {
                EmptyStateView(
                    icon: "clock",
                    title: "No Transactions",
                    message: "Your transaction history will appear here."
                )
            } else {
                LazyVStack(spacing: AppTheme.Spacing.small) {
                    ForEach(viewModel.transactions, id: \.id) { transaction in
                        TransactionRow(transaction: transaction)
                            .onAppear {
                                if transaction.id == viewModel.transactions.last?.id {
                                    Task { await viewModel.loadNextPage() }
                                }
                            }
                    }
                }
            }
        }
    }

    // MARK: - Promo Sheet

    @ViewBuilder
    private var promoSheet: some View {
        NavigationStack {
            VStack(spacing: AppTheme.Spacing.large) {
                Image(systemName: "ticket.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(AppTheme.Colors.primary)

                Text("Redeem Promo Code")
                    .font(.title2.bold())

                TextField("Enter promo code", text: $viewModel.promoCode)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()

                if let message = viewModel.promoMessage {
                    Label(message, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.subheadline)
                }

                if let error = viewModel.promoError {
                    Label(error, systemImage: "xmark.circle.fill")
                        .foregroundStyle(.red)
                        .font(.subheadline)
                }

                Button {
                    Task { await viewModel.redeemPromo() }
                } label: {
                    if viewModel.isRedeemingPromo {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Redeem")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.promoCode.trimmingCharacters(in: .whitespaces).isEmpty || viewModel.isRedeemingPromo)

                Spacer()
            }
            .padding(AppTheme.Spacing.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        viewModel.showPromoSheet = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Subviews

private struct CreditPackCard: View {
    let pack: CreditPack
    let onPurchase: () -> Void

    var body: some View {
        VStack(spacing: AppTheme.Spacing.small) {
            Text(pack.name)
                .font(.headline)
                .lineLimit(1)

            Text("\(pack.credits)")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(AppTheme.Colors.primary)

            Text("credits")
                .font(.caption)
                .foregroundStyle(.secondary)

            Button {
                onPurchase()
            } label: {
                Text(pack.formattedPrice)
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct SubscriptionCard: View {
    let subscription: SubscriptionInfo

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(subscription.name)
                    .font(.headline)
                Text("\(subscription.creditsPerMonth) credits/month")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StatusBadge(text: subscription.status, style: subscription.status == "active" ? .success : .neutral)
        }
        .padding(AppTheme.Spacing.medium)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct TransactionRow: View {
    let transaction: CreditTransaction

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(transaction.displayName)
                    .font(.subheadline.bold())
                if let description = transaction.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            Text(transaction.amount >= 0 ? "+\(transaction.amount)" : "\(transaction.amount)")
                .font(.subheadline.bold().monospacedDigit())
                .foregroundStyle(transaction.amount >= 0 ? .green : .red)

            Text(transaction.createdAt, style: .date)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, AppTheme.Spacing.small)
    }
}
