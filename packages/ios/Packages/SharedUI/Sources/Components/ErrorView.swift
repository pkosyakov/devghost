import SwiftUI

public struct ErrorView: View {
    let message: String
    let retryAction: (() -> Void)?

    public init(_ message: String, retryAction: (() -> Void)? = nil) {
        self.message = message
        self.retryAction = retryAction
    }

    public init(message: String, retryAction: (() -> Void)? = nil) {
        self.message = message
        self.retryAction = retryAction
    }

    public init(error: Error, retryAction: (() -> Void)? = nil) {
        self.message = error.localizedDescription
        self.retryAction = retryAction
    }

    public var body: some View {
        ContentUnavailableView {
            Label("Error", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retryAction {
                Button("Try Again", action: retryAction)
                    .buttonStyle(.bordered)
            }
        }
    }
}
