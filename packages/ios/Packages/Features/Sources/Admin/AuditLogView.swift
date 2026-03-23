import SwiftUI
import Core
import SharedUI

// MARK: - Models

struct AuditEntry: Decodable, Identifiable {
    let id: String
    let action: String
    let userEmail: String?
    let userId: String?
    let targetType: String?
    let targetId: String?
    let details: AuditDetails?
    let createdAt: Date
}

struct AuditDetails: Decodable {
    // Flexible container — details vary per action
    // We decode the raw JSON and expose it as key-value pairs for display
    private let storage: [String: AnyCodable]

    var pairs: [(key: String, value: String)] {
        storage.compactMap { key, value in
            (key: key, value: value.displayString)
        }
        .sorted { $0.key < $1.key }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        storage = (try? container.decode([String: AnyCodable].self)) ?? [:]
    }
}

private struct AnyCodable: Decodable {
    let displayString: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self) {
            displayString = str
        } else if let int = try? container.decode(Int.self) {
            displayString = "\(int)"
        } else if let dbl = try? container.decode(Double.self) {
            displayString = String(format: "%.2f", dbl)
        } else if let bool = try? container.decode(Bool.self) {
            displayString = bool ? "true" : "false"
        } else {
            displayString = "..."
        }
    }
}

struct AuditLogResponse: Decodable {
    let entries: [AuditEntry]
    let pagination: Pagination

    struct Pagination: Decodable {
        let page: Int
        let pageSize: Int
        let total: Int
        let totalPages: Int
    }
}

// MARK: - ViewModel

@MainActor
@Observable
final class AuditLogViewModel {
    var entries: [AuditEntry] = []
    var isLoading = false
    var isLoadingMore = false
    var error: String?
    var searchText = ""

    private var currentPage = 1
    private var totalPages = 1
    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    var canLoadMore: Bool {
        currentPage < totalPages
    }

    func loadEntries() async {
        isLoading = true
        error = nil
        currentPage = 1
        do {
            let response = try await fetchPage(1)
            entries = response.entries
            totalPages = response.pagination.totalPages
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    func loadMore() async {
        guard canLoadMore, !isLoadingMore else { return }
        isLoadingMore = true
        let nextPage = currentPage + 1
        do {
            let response = try await fetchPage(nextPage)
            entries.append(contentsOf: response.entries)
            currentPage = nextPage
            totalPages = response.pagination.totalPages
        } catch {
            self.error = error.localizedDescription
        }
        isLoadingMore = false
    }

    private func fetchPage(_ page: Int) async throws -> AuditLogResponse {
        var queryItems = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "pageSize", value: "30"),
        ]
        if !searchText.isEmpty {
            queryItems.append(URLQueryItem(name: "action", value: searchText))
        }
        return try await apiClient.request(
            Endpoint(
                path: "/api/admin/audit",
                method: .get,
                queryItems: queryItems
            )
        )
    }
}

// MARK: - View

public struct AuditLogView: View {
    @State private var viewModel: AuditLogViewModel

    public init(apiClient: APIClient) {
        _viewModel = State(initialValue: AuditLogViewModel(apiClient: apiClient))
    }

    public var body: some View {
        Group {
            if viewModel.isLoading && viewModel.entries.isEmpty {
                LoadingView(message: "Loading audit log...")
            } else if let error = viewModel.error, viewModel.entries.isEmpty {
                ErrorView(message: error) {
                    Task { await viewModel.loadEntries() }
                }
            } else if viewModel.entries.isEmpty {
                EmptyStateView(
                    icon: "list.bullet.clipboard",
                    title: "No Audit Entries",
                    message: "No audit log entries found."
                )
            } else {
                entryList
            }
        }
        .navigationTitle("Audit Log")
        .searchable(text: $viewModel.searchText, prompt: "Filter by action...")
        .onSubmit(of: .search) {
            Task { await viewModel.loadEntries() }
        }
        .refreshable {
            await viewModel.loadEntries()
        }
        .task {
            await viewModel.loadEntries()
        }
    }

    @ViewBuilder
    private var entryList: some View {
        List {
            ForEach(viewModel.entries) { entry in
                AuditEntryRow(entry: entry)
            }

            if viewModel.canLoadMore {
                HStack {
                    Spacer()
                    if viewModel.isLoadingMore {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Button("Load More") {
                            Task { await viewModel.loadMore() }
                        }
                        .font(.subheadline)
                    }
                    Spacer()
                }
                .listRowSeparator(.hidden)
                .task {
                    await viewModel.loadMore()
                }
            }
        }
    }
}

// MARK: - Row

private struct AuditEntryRow: View {
    let entry: AuditEntry

    var body: some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
            HStack {
                Image(systemName: iconForAction(entry.action))
                    .font(.caption)
                    .foregroundStyle(colorForAction(entry.action))

                Text(entry.action)
                    .font(.subheadline.bold().monospaced())
                    .lineLimit(1)

                Spacer()

                Text(entry.createdAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if let email = entry.userEmail {
                Text(email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let targetType = entry.targetType {
                HStack(spacing: 4) {
                    Text(targetType)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    if let targetId = entry.targetId {
                        Text(targetId.prefix(12) + (targetId.count > 12 ? "..." : ""))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            if let details = entry.details, !details.pairs.isEmpty {
                HStack(spacing: AppTheme.Spacing.small) {
                    ForEach(details.pairs.prefix(3), id: \.key) { pair in
                        Text("\(pair.key): \(pair.value)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func iconForAction(_ action: String) -> String {
        if action.contains("delete") || action.contains("deactivate") {
            return "trash"
        } else if action.contains("create") {
            return "plus.circle"
        } else if action.contains("update") || action.contains("settings") {
            return "pencil.circle"
        } else if action.contains("login") || action.contains("auth") {
            return "person.badge.key"
        } else {
            return "doc.text"
        }
    }

    private func colorForAction(_ action: String) -> Color {
        if action.contains("delete") || action.contains("deactivate") {
            return .red
        } else if action.contains("create") {
            return .green
        } else if action.contains("update") || action.contains("settings") {
            return .orange
        } else {
            return .secondary
        }
    }
}
