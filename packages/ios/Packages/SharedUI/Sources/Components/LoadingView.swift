import SwiftUI

public struct LoadingView: View {
    let message: String

    public init(_ message: String = "Loading...") {
        self.message = message
    }

    public init(message: String) {
        self.message = message
    }

    public var body: some View {
        VStack(spacing: AppTheme.Spacing.md) {
            ProgressView()
                .controlSize(.large)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
