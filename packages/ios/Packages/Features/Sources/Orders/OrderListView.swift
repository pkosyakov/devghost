import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class OrderListViewModel {
    var orders: [Order] = []
    var isLoading = false
    var errorMessage: String?

    let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func fetchOrders() async {
        isLoading = orders.isEmpty
        errorMessage = nil

        do {
            let endpoint = Endpoint(path: "/api/orders", method: .get)
            orders = try await apiClient.request(endpoint)
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Failed to load orders."
        }

        isLoading = false
    }
}

// MARK: - View

public struct OrderListView: View {
    @State private var viewModel: OrderListViewModel
    @State private var showCreate = false

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: OrderListViewModel(apiClient: apiClient))
    }

    public var body: some View {
        content
            .navigationTitle("Orders")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showCreate = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.title3)
                    }
                }
            }
            .sheet(isPresented: $showCreate) {
                OrderCreateView(apiClient: viewModel.apiClient) {
                    Task { await viewModel.fetchOrders() }
                }
            }
            .task {
                await viewModel.fetchOrders()
            }
            .refreshable {
                await viewModel.fetchOrders()
            }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            LoadingView(message: "Loading orders...")
        } else if let error = viewModel.errorMessage, viewModel.orders.isEmpty {
            ErrorView(message: error) {
                Task { await viewModel.fetchOrders() }
            }
        } else if viewModel.orders.isEmpty {
            EmptyStateView(
                icon: "doc.text.magnifyingglass",
                title: "No Orders Yet",
                message: "Create your first analysis order to measure developer productivity."
            )
        } else {
            orderList
        }
    }

    private var orderList: some View {
        List {
            ForEach(viewModel.orders) { order in
                NavigationLink(value: order.id) {
                    OrderRowView(order: order)
                }
                .listRowInsets(EdgeInsets(
                    top: AppTheme.Spacing.sm,
                    leading: AppTheme.Spacing.md,
                    bottom: AppTheme.Spacing.sm,
                    trailing: AppTheme.Spacing.md
                ))
            }
        }
        .listStyle(.plain)
        .navigationDestination(for: String.self) { orderId in
            OrderDetailView(orderId: orderId, apiClient: viewModel.apiClient)
        }
    }
}

