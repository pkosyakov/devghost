import SwiftUI
import Core
import SharedUI

// MARK: - ViewModel

@MainActor
@Observable
final class CommitListViewModel {
    private let apiClient: APIClient
    private let orderId: String

    var commits: [CommitAnalysis] = []
    var isLoading = false
    var error: Error?
    var searchText = ""
    var selectedDeveloper: String?

    init(orderId: String, apiClient: APIClient = .shared) {
        self.orderId = orderId
        self.apiClient = apiClient
    }

    var filteredCommits: [CommitAnalysis] {
        var result = commits

        if let dev = selectedDeveloper, !dev.isEmpty {
            result = result.filter { $0.authorName == dev || $0.authorEmail == dev }
        }

        if !searchText.isEmpty {
            let query = searchText.lowercased()
            result = result.filter {
                $0.sha.lowercased().contains(query) ||
                ($0.message ?? "").lowercased().contains(query) ||
                ($0.authorName ?? "").lowercased().contains(query)
            }
        }

        return result
    }

    var uniqueDevelopers: [String] {
        Array(Set(commits.compactMap(\.authorName))).sorted()
    }

    func fetchCommits() async {
        isLoading = true
        error = nil
        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/commits",
                method: .get
            )
            commits = try await apiClient.request(endpoint)
            isLoading = false
        } catch {
            self.error = error
            isLoading = false
        }
    }
}

// MARK: - View

struct CommitListView: View {
    @State private var viewModel: CommitListViewModel
    @State private var selectedCommit: CommitAnalysis?

    init(orderId: String) {
        _viewModel = State(initialValue: CommitListViewModel(orderId: orderId))
    }

    var body: some View {
        Group {
            if viewModel.isLoading {
                LoadingView()
            } else if let error = viewModel.error {
                ErrorView(error: error) {
                    Task { await viewModel.fetchCommits() }
                }
            } else if viewModel.filteredCommits.isEmpty {
                ContentUnavailableView.search(text: viewModel.searchText)
            } else {
                commitList
            }
        }
        .navigationTitle("Commits")
        .searchable(text: $viewModel.searchText, prompt: "Search commits")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                developerFilter
            }
        }
        .sheet(item: $selectedCommit) { commit in
            CommitDetailSheet(commit: commit)
        }
        .task {
            await viewModel.fetchCommits()
        }
    }

    // MARK: - Subviews

    private var commitList: some View {
        List(viewModel.filteredCommits) { commit in
            CommitRow(commit: commit)
                .contentShape(Rectangle())
                .onTapGesture {
                    selectedCommit = commit
                }
        }
        .listStyle(.insetGrouped)
    }

    private var developerFilter: some View {
        Menu {
            Button("All Developers") {
                viewModel.selectedDeveloper = nil
            }
            Divider()
            ForEach(viewModel.uniqueDevelopers, id: \.self) { dev in
                Button {
                    viewModel.selectedDeveloper = dev
                } label: {
                    HStack {
                        Text(dev)
                        if viewModel.selectedDeveloper == dev {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "person.crop.circle")
                .symbolVariant(viewModel.selectedDeveloper != nil ? .fill : .none)
        }
    }
}

// MARK: - Commit Row

private struct CommitRow: View {
    let commit: CommitAnalysis

    private var shortSha: String {
        String(commit.sha.prefix(7))
    }

    private var formattedDate: String {
        if let date = commit.date ?? commit.committedAt {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: date)
        }
        return "—"
    }

    var body: some View {
        HStack(spacing: AppTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: AppTheme.Spacing.xs) {
                    Text(shortSha)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)

                    Text(commit.authorName ?? "Unknown")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(commit.message ?? "No message")
                    .font(.subheadline)
                    .lineLimit(1)

                Text(formattedDate)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            Text(String(format: "%.1fh", commit.effort))
                .font(.headline.monospacedDigit())
                .foregroundStyle(AppTheme.Colors.accent)
        }
        .padding(.vertical, AppTheme.Spacing.xs)
    }
}

// MARK: - Commit Detail Sheet

private struct CommitDetailSheet: View {
    let commit: CommitAnalysis
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.Spacing.lg) {
                    // Header
                    VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
                        Text(commit.sha)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)

                        Text(commit.message ?? "No message")
                            .font(.body)
                    }

                    Divider()

                    // Metadata
                    LazyVGrid(
                        columns: [GridItem(.flexible()), GridItem(.flexible())],
                        spacing: AppTheme.Spacing.md
                    ) {
                        metadataItem(title: "Author", value: commit.authorName ?? "Unknown")
                        metadataItem(title: "Estimated Hours", value: String(format: "%.2f", commit.effort))
                        metadataItem(title: "Files Changed", value: "\(commit.totalFilesChanged)")
                        metadataItem(title: "Additions", value: "+\(commit.additions ?? 0)")
                        metadataItem(title: "Deletions", value: "-\(commit.deletions ?? 0)")
                    }

                    // Reasoning
                    if let reasoning = commit.reasoning, !reasoning.isEmpty {
                        Divider()

                        VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
                            Label("LLM Reasoning", systemImage: "brain")
                                .font(.headline)

                            Text(reasoning)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }

                    // File list
                    if let files = commit.files, !files.isEmpty {
                        Divider()

                        VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
                            Label("Files", systemImage: "doc.text")
                                .font(.headline)

                            ForEach(files, id: \.filename) { file in
                                Text("\(file.filename) (+\(file.additions)/-\(file.deletions))")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .padding(AppTheme.Spacing.md)
            }
            .navigationTitle("Commit Detail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func metadataItem(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Text(value)
                .font(.subheadline)
        }
    }
}
