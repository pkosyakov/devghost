import SwiftUI
import Core
import SharedUI

// MARK: - Wizard Step

private enum WizardStep: Int, CaseIterable {
    case selectRepos = 0
    case configurePeriod = 1
    case confirm = 2

    var title: String {
        switch self {
        case .selectRepos: return "Select Repositories"
        case .configurePeriod: return "Analysis Period"
        case .confirm: return "Confirm & Start"
        }
    }

    var icon: String {
        switch self {
        case .selectRepos: return "folder.badge.plus"
        case .configurePeriod: return "calendar.badge.clock"
        case .confirm: return "checkmark.circle"
        }
    }
}

// MARK: - Analysis Period Mode

private enum AnalysisPeriodMode: String, CaseIterable, Identifiable {
    case allTime = "ALL_TIME"
    case selectedYears = "SELECTED_YEARS"
    case dateRange = "DATE_RANGE"
    case lastNCommits = "LAST_N_COMMITS"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .allTime: return "All Time"
        case .selectedYears: return "Selected Years"
        case .dateRange: return "Date Range"
        case .lastNCommits: return "Last N Commits"
        }
    }

    var icon: String {
        switch self {
        case .allTime: return "infinity"
        case .selectedYears: return "calendar"
        case .dateRange: return "calendar.badge.clock"
        case .lastNCommits: return "number"
        }
    }
}

// MARK: - ViewModel

@MainActor
@Observable
final class OrderCreateViewModel {
    // Step 1: Repos
    var availableRepos: [GitHubRepo] = []
    var selectedRepos: [GitHubRepo] = []
    var repoSearchQuery = ""
    var isLoadingRepos = false

    // Step 2: Period
    var periodMode: AnalysisPeriodMode = .allTime
    var selectedYears: Set<Int> = []
    var dateRangeStart = Calendar.current.date(byAdding: .year, value: -1, to: .now) ?? .now
    var dateRangeEnd = Date.now
    var lastNCommits = 100

    // Wizard state
    var currentStep: WizardStep = .selectRepos
    var isCreating = false
    var errorMessage: String?

    let apiClient: APIClient
    private let onComplete: () -> Void

    init(apiClient: APIClient, onComplete: @escaping () -> Void) {
        self.apiClient = apiClient
        self.onComplete = onComplete
    }

    var canProceed: Bool {
        switch currentStep {
        case .selectRepos: return !selectedRepos.isEmpty
        case .configurePeriod: return isPeriodValid
        case .confirm: return !isCreating
        }
    }

    private var isPeriodValid: Bool {
        switch periodMode {
        case .allTime: return true
        case .selectedYears: return !selectedYears.isEmpty
        case .dateRange: return dateRangeStart < dateRangeEnd
        case .lastNCommits: return lastNCommits > 0
        }
    }

    // MARK: - Repo Loading

    func fetchRepos() async {
        isLoadingRepos = true

        do {
            let endpoint = Endpoint(path: "/api/github/repos", method: .get)
            availableRepos = try await apiClient.request(endpoint)
        } catch {
            errorMessage = "Failed to load repositories."
        }

        isLoadingRepos = false
    }

    func searchRepos() async {
        guard !repoSearchQuery.trimmingCharacters(in: .whitespaces).isEmpty else {
            await fetchRepos()
            return
        }

        isLoadingRepos = true

        do {
            let endpoint = Endpoint(
                path: "/api/github/search",
                method: .get,
                queryItems: [URLQueryItem(name: "q", value: repoSearchQuery)]
            )
            availableRepos = try await apiClient.request(endpoint)
        } catch {
            errorMessage = "Search failed."
        }

        isLoadingRepos = false
    }

    func toggleRepo(_ repo: GitHubRepo) {
        if let index = selectedRepos.firstIndex(where: { $0.fullName == repo.fullName }) {
            selectedRepos.remove(at: index)
        } else {
            selectedRepos.append(repo)
        }
    }

    func isRepoSelected(_ repo: GitHubRepo) -> Bool {
        selectedRepos.contains(where: { $0.fullName == repo.fullName })
    }

    // MARK: - Navigation

    func goNext() {
        guard let nextStep = WizardStep(rawValue: currentStep.rawValue + 1) else {
            return
        }
        currentStep = nextStep
    }

    func goBack() {
        guard let prevStep = WizardStep(rawValue: currentStep.rawValue - 1) else {
            return
        }
        currentStep = prevStep
    }

    // MARK: - Create Order

    func createAndAnalyze() async {
        isCreating = true
        errorMessage = nil

        do {
            // Build request body
            let body = CreateOrderRequest(
                selectedRepos: selectedRepos.map { RepoSelection(fullName: $0.fullName, cloneUrl: "https://github.com/\($0.fullName).git") },
                analysisPeriod: buildAnalysisPeriod()
            )

            // Step 1: Create order
            let createEndpoint = Endpoint(
                path: "/api/orders",
                method: .post,
                body: body
            )
            let order: Order = try await apiClient.request(createEndpoint)

            // Step 2: Extract developers
            let devsEndpoint = Endpoint(
                path: "/api/orders/\(order.id)/developers",
                method: .post
            )
            let _: SuccessResponse = try await apiClient.request(devsEndpoint)

            // Step 3: Start analysis
            let analyzeEndpoint = Endpoint(
                path: "/api/orders/\(order.id)/analyze",
                method: .post
            )
            let _: SuccessResponse = try await apiClient.request(analyzeEndpoint)

            onComplete()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "Failed to create order."
        }

        isCreating = false
    }

    private func buildAnalysisPeriod() -> AnalysisPeriod {
        switch periodMode {
        case .allTime:
            return AnalysisPeriod(mode: "ALL_TIME")
        case .selectedYears:
            return AnalysisPeriod(
                mode: "SELECTED_YEARS",
                years: Array(selectedYears).sorted()
            )
        case .dateRange:
            return AnalysisPeriod(
                mode: "DATE_RANGE",
                startDate: dateRangeStart,
                endDate: dateRangeEnd
            )
        case .lastNCommits:
            return AnalysisPeriod(
                mode: "LAST_N_COMMITS",
                lastN: lastNCommits
            )
        }
    }
}

// MARK: - Request Types

private struct CreateOrderRequest: Encodable {
    let selectedRepos: [RepoSelection]
    let analysisPeriod: AnalysisPeriod
}

private struct RepoSelection: Encodable {
    let fullName: String
    let cloneUrl: String
}

private struct AnalysisPeriod: Encodable {
    let mode: String
    var years: [Int]?
    var startDate: Date?
    var endDate: Date?
    var lastN: Int?
}

private struct SuccessResponse: Decodable {
    let success: Bool
}

// MARK: - View

public struct OrderCreateView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: OrderCreateViewModel

    public init(apiClient: APIClient, onComplete: @escaping () -> Void) {
        _viewModel = State(initialValue: OrderCreateViewModel(
            apiClient: apiClient,
            onComplete: onComplete
        ))
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                stepIndicator
                Divider()
                stepContent
                Divider()
                bottomBar
            }
            .navigationTitle(viewModel.currentStep.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                await viewModel.fetchRepos()
            }
        }
    }

    // MARK: - Step Indicator

    private var stepIndicator: some View {
        HStack(spacing: 0) {
            ForEach(WizardStep.allCases, id: \.rawValue) { step in
                stepDot(step)
                if step.rawValue < WizardStep.allCases.count - 1 {
                    stepConnector(completed: step.rawValue < viewModel.currentStep.rawValue)
                }
            }
        }
        .padding(.horizontal, AppTheme.Spacing.xl)
        .padding(.vertical, AppTheme.Spacing.md)
    }

    private func stepDot(_ step: WizardStep) -> some View {
        let isActive = step == viewModel.currentStep
        let isCompleted = step.rawValue < viewModel.currentStep.rawValue

        return VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(isActive || isCompleted ? AppTheme.Colors.primary : Color.gray.opacity(0.3))
                    .frame(width: 32, height: 32)

                if isCompleted {
                    Image(systemName: "checkmark")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                } else {
                    Image(systemName: step.icon)
                        .font(.caption2)
                        .foregroundStyle(isActive ? .white : .secondary)
                }
            }

            Text(step.title)
                .font(.caption2)
                .foregroundStyle(isActive ? .primary : .secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }

    private func stepConnector(completed: Bool) -> some View {
        Rectangle()
            .fill(completed ? AppTheme.Colors.primary : Color.gray.opacity(0.3))
            .frame(height: 2)
            .frame(maxWidth: .infinity)
            .padding(.bottom, 16) // Align with dot center
    }

    // MARK: - Step Content

    @ViewBuilder
    private var stepContent: some View {
        switch viewModel.currentStep {
        case .selectRepos:
            repoSelectionStep
        case .configurePeriod:
            periodConfigStep
        case .confirm:
            confirmStep
        }
    }

    // MARK: - Step 1: Repository Selection

    private var repoSelectionStep: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack(spacing: AppTheme.Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)

                TextField("Search repositories...", text: $viewModel.repoSearchQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit {
                        Task { await viewModel.searchRepos() }
                    }

                if !viewModel.repoSearchQuery.isEmpty {
                    Button {
                        viewModel.repoSearchQuery = ""
                        Task { await viewModel.fetchRepos() }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(AppTheme.Spacing.md)
            .background(AppTheme.Colors.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(AppTheme.Spacing.md)

            // Selected count
            if !viewModel.selectedRepos.isEmpty {
                HStack {
                    Text("\(viewModel.selectedRepos.count) selected")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.Colors.primary)
                    Spacer()
                    Button("Clear All") {
                        viewModel.selectedRepos.removeAll()
                    }
                    .font(.subheadline)
                }
                .padding(.horizontal, AppTheme.Spacing.md)
                .padding(.bottom, AppTheme.Spacing.sm)
            }

            // Repo list
            if viewModel.isLoadingRepos {
                Spacer()
                ProgressView("Loading repos...")
                Spacer()
            } else {
                List {
                    ForEach(viewModel.availableRepos, id: \.fullName) { repo in
                        repoRow(repo)
                    }
                }
                .listStyle(.plain)
            }
        }
    }

    private func repoRow(_ repo: GitHubRepo) -> some View {
        let isSelected = viewModel.isRepoSelected(repo)

        return Button {
            viewModel.toggleRepo(repo)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.fullName)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)

                    if let description = repo.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }

                    HStack(spacing: AppTheme.Spacing.md) {
                        if let language = repo.language {
                            Label(language, systemImage: "chevron.left.forwardslash.chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        if let stars = repo.stargazersCount, stars > 0 {
                            Label("\(stars)", systemImage: "star.fill")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Spacer()

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? AppTheme.Colors.primary : .secondary)
            }
        }
    }

    // MARK: - Step 2: Period Configuration

    private var periodConfigStep: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.lg) {
                // Mode selector
                VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
                    Text("Analysis Period")
                        .font(.headline)

                    ForEach(AnalysisPeriodMode.allCases) { mode in
                        periodModeRow(mode)
                    }
                }

                // Period-specific options
                periodOptions
            }
            .padding(AppTheme.Spacing.md)
        }
    }

    private func periodModeRow(_ mode: AnalysisPeriodMode) -> some View {
        let isSelected = viewModel.periodMode == mode

        return Button {
            viewModel.periodMode = mode
        } label: {
            HStack(spacing: AppTheme.Spacing.md) {
                Image(systemName: mode.icon)
                    .font(.body)
                    .frame(width: 24)
                    .foregroundStyle(isSelected ? AppTheme.Colors.primary : .secondary)

                Text(mode.label)
                    .font(.subheadline)
                    .foregroundStyle(.primary)

                Spacer()

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? AppTheme.Colors.primary : .secondary)
            }
            .padding(AppTheme.Spacing.md)
            .background(isSelected ? AppTheme.Colors.primary.opacity(0.08) : AppTheme.Colors.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private var periodOptions: some View {
        switch viewModel.periodMode {
        case .allTime:
            EmptyView()

        case .selectedYears:
            yearSelector

        case .dateRange:
            VStack(spacing: AppTheme.Spacing.md) {
                DatePicker("From", selection: $viewModel.dateRangeStart, displayedComponents: .date)
                DatePicker("To", selection: $viewModel.dateRangeEnd, displayedComponents: .date)
            }
            .padding(AppTheme.Spacing.md)
            .background(AppTheme.Colors.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))

        case .lastNCommits:
            VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
                Text("Number of recent commits")
                    .font(.subheadline.weight(.medium))

                HStack {
                    TextField("100", value: $viewModel.lastNCommits, format: .number)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 100)

                    Stepper("", value: $viewModel.lastNCommits, in: 1...10000, step: 50)
                        .labelsHidden()
                }
            }
            .padding(AppTheme.Spacing.md)
            .background(AppTheme.Colors.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private var yearSelector: some View {
        let currentYear = Calendar.current.component(.year, from: .now)
        let years = Array((currentYear - 9)...currentYear).reversed()

        return LazyVGrid(columns: [
            GridItem(.adaptive(minimum: 70), spacing: AppTheme.Spacing.sm)
        ], spacing: AppTheme.Spacing.sm) {
            ForEach(years, id: \.self) { year in
                let isSelected = viewModel.selectedYears.contains(year)

                Button {
                    if isSelected {
                        viewModel.selectedYears.remove(year)
                    } else {
                        viewModel.selectedYears.insert(year)
                    }
                } label: {
                    Text(String(year))
                        .font(.subheadline.weight(isSelected ? .semibold : .regular))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, AppTheme.Spacing.sm)
                        .background(isSelected ? AppTheme.Colors.primary : AppTheme.Colors.surfaceSecondary)
                        .foregroundStyle(isSelected ? .white : .primary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    // MARK: - Step 3: Confirm

    private var confirmStep: some View {
        ScrollView {
            VStack(spacing: AppTheme.Spacing.lg) {
                if let error = viewModel.errorMessage {
                    errorBanner(error)
                }

                // Repositories summary
                summarySection(title: "Repositories", icon: "folder.fill") {
                    ForEach(viewModel.selectedRepos, id: \.fullName) { repo in
                        HStack(spacing: AppTheme.Spacing.sm) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.caption)

                            Text(repo.fullName)
                                .font(.subheadline)
                        }
                    }
                }

                // Period summary
                summarySection(title: "Analysis Period", icon: "calendar") {
                    HStack(spacing: AppTheme.Spacing.sm) {
                        Image(systemName: viewModel.periodMode.icon)
                            .foregroundStyle(AppTheme.Colors.primary)
                            .font(.caption)

                        Text(periodSummaryText)
                            .font(.subheadline)
                    }
                }

                // Info note
                HStack(spacing: AppTheme.Spacing.sm) {
                    Image(systemName: "info.circle.fill")
                        .foregroundStyle(AppTheme.Colors.primary)

                    Text("The analysis will extract developers, estimate commit effort via LLM, and calculate Ghost% productivity metrics.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(AppTheme.Spacing.md)
                .background(AppTheme.Colors.primary.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .padding(AppTheme.Spacing.md)
        }
    }

    private var periodSummaryText: String {
        switch viewModel.periodMode {
        case .allTime:
            return "All Time"
        case .selectedYears:
            let years = viewModel.selectedYears.sorted()
            return years.map(String.init).joined(separator: ", ")
        case .dateRange:
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            return "\(formatter.string(from: viewModel.dateRangeStart)) - \(formatter.string(from: viewModel.dateRangeEnd))"
        case .lastNCommits:
            return "Last \(viewModel.lastNCommits) commits"
        }
    }

    private func summarySection<Content: View>(
        title: String,
        icon: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: AppTheme.Spacing.sm) {
            Label(title, systemImage: icon)
                .font(.headline)

            VStack(alignment: .leading, spacing: AppTheme.Spacing.xs) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(AppTheme.Spacing.md)
            .background(AppTheme.Colors.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
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

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        HStack(spacing: AppTheme.Spacing.md) {
            if viewModel.currentStep != .selectRepos {
                Button {
                    viewModel.goBack()
                } label: {
                    Label("Back", systemImage: "chevron.left")
                        .frame(maxWidth: .infinity)
                        .padding(AppTheme.Spacing.md)
                }
                .buttonStyle(.bordered)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }

            Button {
                if viewModel.currentStep == .confirm {
                    Task {
                        await viewModel.createAndAnalyze()
                        if viewModel.errorMessage == nil {
                            dismiss()
                        }
                    }
                } else {
                    viewModel.goNext()
                }
            } label: {
                Group {
                    if viewModel.isCreating {
                        ProgressView()
                            .tint(.white)
                    } else if viewModel.currentStep == .confirm {
                        Label("Start Analysis", systemImage: "play.fill")
                    } else {
                        Label("Continue", systemImage: "chevron.right")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(AppTheme.Spacing.md)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppTheme.Colors.primary)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .disabled(!viewModel.canProceed)
        }
        .padding(AppTheme.Spacing.md)
    }
}
