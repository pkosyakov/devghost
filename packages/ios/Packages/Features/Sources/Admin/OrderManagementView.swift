import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class OrderManagementViewModel {
    var orders: [Order] = []
    var isLoading = false
    var error: String?
    var orderToDelete: Order?
    var showDeleteConfirmation = false
    var isPerformingAction = false

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func loadOrders() async {
        isLoading = true
        error = nil
        do {
            orders = try await apiClient.request(
                Endpoint(path: "/api/admin/orders", method: .get)
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func deleteOrder(_ order: Order) async {
        isPerformingAction = true
        do {
            struct DeleteResponse: Decodable {}
            let _: DeleteResponse = try await apiClient.request(
                Endpoint(path: "/api/admin/orders/\(order.id)", method: .delete)
            )
            orders.removeAll { $0.id == order.id }
        } catch {
            self.error = error.localizedDescription
        }
        isPerformingAction = false
    }

    func rerunAnalysis(_ order: Order) async {
        isPerformingAction = true
        do {
            struct RerunResponse: Decodable {}
            let _: RerunResponse = try await apiClient.request(
                Endpoint(path: "/api/admin/orders/\(order.id)/rerun", method: .post)
            )
            await loadOrders()
        } catch {
            self.error = error.localizedDescription
        }
        isPerformingAction = false
    }
}

// MARK: - View

public struct OrderManagementView: View {
    @State private var viewModel: OrderManagementViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: OrderManagementViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.orders.isEmpty {
                LoadingView(message: "Loading orders...")
            } else if let error = viewModel.error, viewModel.orders.isEmpty {
                ErrorView(message: error) {
                    Task { await viewModel.loadOrders() }
                }
            } else if viewModel.orders.isEmpty {
                EmptyStateView(
                    icon: "doc.text",
                    title: "No Orders",
                    message: "No orders have been created yet."
                )
            } else {
                orderList
            }
        }
        .navigationTitle("Orders")
        .refreshable {
            await viewModel.loadOrders()
        }
        .confirmationDialog(
            "Delete Order",
            isPresented: $viewModel.showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            if let order = viewModel.orderToDelete {
                Button("Delete", role: .destructive) {
                    Task { await viewModel.deleteOrder(order) }
                }
            }
            Button("Cancel", role: .cancel) {
                viewModel.orderToDelete = nil
            }
        } message: {
            Text("This action cannot be undone. All analysis data for this order will be permanently deleted.")
        }
        .task {
            await viewModel.loadOrders()
        }
    }

    @ViewBuilder
    private var orderList: some View {
        List(viewModel.orders, id: \.id) { order in
            OrderAdminRow(order: order) {
                viewModel.orderToDelete = order
                viewModel.showDeleteConfirmation = true
            } onRerun: {
                Task { await viewModel.rerunAnalysis(order) }
            }
            .disabled(viewModel.isPerformingAction)
        }
    }
}

private struct OrderAdminRow: View {
    let order: Order
    let onDelete: () -> Void
    let onRerun: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.small) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(order.name ?? "Order #\(order.id.prefix(8))")
                        .font(.subheadline.bold())
                    if let userId = order.userId {
                        Text("User: \(userId.prefix(8))...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                StatusBadge(
                    text: order.status.rawValue,
                    style: statusStyle(for: order.status)
                )
            }

            HStack {
                Text(order.createdAt, style: .date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                Spacer()

                Menu {
                    Button {
                        onRerun()
                    } label: {
                        Label("Rerun Analysis", systemImage: "arrow.clockwise")
                    }

                    Button(role: .destructive) {
                        onDelete()
                    } label: {
                        Label("Delete Order", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func statusStyle(for status: OrderStatus) -> StatusBadge.Style {
        switch status {
        case .completed:
            return .success
        case .processing:
            return .info
        case .failed, .insufficientCredits:
            return .error
        default:
            return .neutral
        }
    }
}
