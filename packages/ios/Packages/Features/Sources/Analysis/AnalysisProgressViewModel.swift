import Foundation
import Core

// MARK: - Progress Response

struct AnalysisProgressResponse: Codable {
    let jobId: String?
    let status: AnalysisJobStatus
    let progress: Double
    let processedCommits: Int
    let totalCommits: Int
    let currentRepo: String?
    let eta: Int?
}

// MARK: - ViewModel

@MainActor
@Observable
final class AnalysisProgressViewModel {
    private let apiClient: APIClient
    private let orderId: String
    private var timer: Timer?
    private static let pollingInterval: TimeInterval = 2.0

    var progress: AnalysisProgressResponse?
    var isLoading = false
    var errorMessage: String?

    var isCompleted: Bool {
        progress?.status == .completed
    }

    var isFailed: Bool {
        guard let status = progress?.status else { return false }
        return status.isTerminal && status != .completed
    }

    var progressFraction: Double {
        guard let progress else { return 0 }
        if isCompleted { return 1.0 }
        return min(max(progress.progress / 100.0, 0), 1.0)
    }

    // Expose orderId for external access if needed
    var currentOrderId: String { orderId }

    init(orderId: String, apiClient: APIClient = .shared) {
        self.orderId = orderId
        self.apiClient = apiClient
    }

    deinit {
        timer?.invalidate()
    }

    // MARK: - Polling

    func startPolling() {
        stopPolling()
        Task { await fetchProgress() }

        timer = Timer.scheduledTimer(withTimeInterval: Self.pollingInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.fetchProgress()
            }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: - Fetch

    @MainActor
    private func fetchProgress() async {
        // Stop polling on terminal status
        if let status = progress?.status, status.isTerminal {
            stopPolling()
            return
        }

        isLoading = progress == nil
        do {
            let endpoint = Endpoint(
                path: "/api/orders/\(orderId)/progress",
                method: .get
            )
            let response: AnalysisProgressResponse = try await apiClient.request(endpoint)
            progress = response
            errorMessage = nil

            if response.status.isTerminal {
                stopPolling()

                if isFailed {
                    errorMessage = "Analysis failed. The job ended with status: \(response.status.rawValue)."
                }
            }
        } catch {
            errorMessage = error.localizedDescription
            // Don't stop polling on transient network errors --
            // only stop on terminal job status.
        }
        isLoading = false
    }
}
