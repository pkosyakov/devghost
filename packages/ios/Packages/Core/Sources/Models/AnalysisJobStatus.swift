import Foundation

public enum AnalysisJobStatus: String, Codable, Sendable {
    case pending = "PENDING"
    case running = "RUNNING"
    case llmComplete = "LLM_COMPLETE"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case failedRetryable = "FAILED_RETRYABLE"
    case failedFatal = "FAILED_FATAL"
    case cancelled = "CANCELLED"

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .failedFatal, .cancelled: true
        default: false
        }
    }

    public var isRetrying: Bool { self == .failedRetryable }

    public var displayName: String {
        switch self {
        case .pending: "Pending"
        case .running: "Running"
        case .llmComplete: "Processing Results"
        case .completed: "Completed"
        case .failed: "Failed"
        case .failedRetryable: "Retrying..."
        case .failedFatal: "Failed (Fatal)"
        case .cancelled: "Cancelled"
        }
    }
}
