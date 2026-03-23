import SwiftUI
import Core
import SharedUI

// MARK: - Sort Option

enum DeveloperSortOption: String, CaseIterable {
    case ghostPercent = "Ghost%"
    case name = "Name"
    case commits = "Commits"
    case effort = "Effort"
}

// MARK: - View

struct DeveloperListView: View {
    let viewModel: MetricsViewModel

    @State private var sortOption: DeveloperSortOption = .ghostPercent
    @State private var sortAscending = false
    @State private var searchText = ""

    private var filteredDevelopers: [DeveloperMetric] {
        let filtered: [DeveloperMetric]
        if searchText.isEmpty {
            filtered = viewModel.developers
        } else {
            let query = searchText.lowercased()
            filtered = viewModel.developers.filter {
                $0.name.lowercased().contains(query) ||
                $0.email.lowercased().contains(query)
            }
        }

        return filtered.sorted { lhs, rhs in
            let result: Bool
            switch sortOption {
            case .ghostPercent:
                result = lhs.ghostPercent < rhs.ghostPercent
            case .name:
                result = lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            case .commits:
                result = lhs.commitCount < rhs.commitCount
            case .effort:
                result = lhs.totalEffortHours < rhs.totalEffortHours
            }
            return sortAscending ? result : !result
        }
    }

    var body: some View {
        List(filteredDevelopers) { developer in
            NavigationLink {
                DeveloperDetailView(
                    developer: developer,
                    orderId: viewModel.orderId
                )
            } label: {
                DeveloperRow(developer: developer)
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $searchText, prompt: "Search developers")
        .navigationTitle("Developers")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                sortMenu
            }
        }
    }

    // MARK: - Sort Menu

    private var sortMenu: some View {
        Menu {
            ForEach(DeveloperSortOption.allCases, id: \.self) { option in
                Button {
                    if sortOption == option {
                        sortAscending.toggle()
                    } else {
                        sortOption = option
                        sortAscending = false
                    }
                } label: {
                    HStack {
                        Text(option.rawValue)
                        if sortOption == option {
                            Image(systemName: sortAscending ? "arrow.up" : "arrow.down")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
        }
    }
}

// MARK: - Developer Row

private struct DeveloperRow: View {
    let developer: DeveloperMetric

    var body: some View {
        HStack(spacing: AppTheme.Spacing.md) {
            GhostGauge(
                percent: developer.ghostPercent,
                size: 48
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(developer.name)
                    .font(.headline)

                Text(developer.email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Label("\(developer.commitCount)", systemImage: "point.3.filled.connected.trianglepath.dotted")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Label("\(developer.workDays)d", systemImage: "calendar")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, AppTheme.Spacing.xs)
    }
}
