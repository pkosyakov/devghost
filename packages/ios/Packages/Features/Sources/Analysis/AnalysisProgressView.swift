import SwiftUI
import Core
import SharedUI

// MARK: - View

struct AnalysisProgressView: View {
    @State private var viewModel: AnalysisProgressViewModel
    @Environment(\.dismiss) private var dismiss

    let onCompleted: (() -> Void)?
    let onRetry: (() async -> Void)?

    init(
        orderId: String,
        onCompleted: (() -> Void)? = nil,
        onRetry: (() async -> Void)? = nil
    ) {
        _viewModel = State(initialValue: AnalysisProgressViewModel(orderId: orderId))
        self.onCompleted = onCompleted
        self.onRetry = onRetry
    }

    var body: some View {
        VStack(spacing: AppTheme.Spacing.xl) {
            Spacer()
            progressIndicator
            statusInfo
            detailsSection
            Spacer()
            actionButtons
        }
        .padding(AppTheme.Spacing.lg)
        .navigationTitle("Analysis")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
        .onChange(of: viewModel.isCompleted) { _, completed in
            if completed {
                onCompleted?()
            }
        }
    }

    // MARK: - Subviews

    private var progressIndicator: some View {
        ZStack {
            Circle()
                .stroke(AppTheme.Colors.secondaryBackground, lineWidth: 8)
                .frame(width: 160, height: 160)

            Circle()
                .trim(from: 0, to: viewModel.progressFraction)
                .stroke(
                    progressColor,
                    style: StrokeStyle(lineWidth: 8, lineCap: .round)
                )
                .frame(width: 160, height: 160)
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut(duration: 0.5), value: viewModel.progressFraction)

            VStack(spacing: 4) {
                if viewModel.isFailed {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(.red)
                } else if viewModel.isCompleted {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(.green)
                } else {
                    Text("\(Int(viewModel.progressFraction * 100))%")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .monospacedDigit()
                }
            }
        }
    }

    private var progressColor: Color {
        if viewModel.isFailed { return .red }
        if viewModel.isCompleted { return .green }
        return AppTheme.Colors.accent
    }

    @ViewBuilder
    private var statusInfo: some View {
        VStack(spacing: AppTheme.Spacing.sm) {
            if let status = viewModel.progress?.status {
                StatusBadge(text: status.displayName, style: status.isTerminal ? (status == .completed ? .success : .error) : .info)
            }

            if let currentRepo = viewModel.progress?.currentRepo {
                Label(currentRepo, systemImage: "folder")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var detailsSection: some View {
        if let progress = viewModel.progress {
            VStack(spacing: AppTheme.Spacing.md) {
                detailRow(
                    icon: "point.3.filled.connected.trianglepath.dotted",
                    title: "Commits",
                    value: "\(progress.processedCommits) / \(progress.totalCommits)"
                )

                if let eta = progress.eta {
                    detailRow(
                        icon: "clock",
                        title: "ETA",
                        value: formatETA(eta)
                    )
                }
            }
            .padding(AppTheme.Spacing.md)
            .background(AppTheme.Colors.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    private func detailRow(icon: String, title: String, value: String) -> some View {
        HStack {
            Label(title, systemImage: icon)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.monospacedDigit())
                .fontWeight(.medium)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        if viewModel.isCompleted {
            Button {
                dismiss()
                onCompleted?()
            } label: {
                Label("View Results", systemImage: "chart.bar.xaxis")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else if viewModel.isFailed {
            VStack(spacing: AppTheme.Spacing.sm) {
                if let errorMessage = viewModel.errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                if let onRetry {
                    Button {
                        Task { await onRetry() }
                    } label: {
                        Label("Retry Analysis", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }

                Button("Dismiss") {
                    dismiss()
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
        }
    }

    // MARK: - Helpers

    private func formatETA(_ seconds: Int) -> String {
        if seconds < 60 {
            return "\(seconds)s"
        } else if seconds < 3600 {
            let min = seconds / 60
            let sec = seconds % 60
            return "\(min)m \(sec)s"
        } else {
            let hr = seconds / 3600
            let min = (seconds % 3600) / 60
            return "\(hr)h \(min)m"
        }
    }
}
