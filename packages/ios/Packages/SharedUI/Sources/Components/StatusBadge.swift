import SwiftUI
import Core

public struct StatusBadge: View {
    public enum Style {
        case success, warning, error, info, neutral

        var color: Color {
            switch self {
            case .success: .green
            case .warning: .orange
            case .error: .red
            case .info: .blue
            case .neutral: .gray
            }
        }
    }

    private let text: String
    private let badgeColor: Color

    public init(status: OrderStatus) {
        self.text = status.displayName
        switch status {
        case .completed: self.badgeColor = .green
        case .processing: self.badgeColor = .blue
        case .failed, .insufficientCredits: self.badgeColor = .red
        case .draft: self.badgeColor = .gray
        case .developersLoaded, .readyForAnalysis: self.badgeColor = .orange
        }
    }

    public init(text: String, style: Style) {
        self.text = text
        self.badgeColor = style.color
    }

    public var body: some View {
        Text(text)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(badgeColor.opacity(0.15))
            .foregroundStyle(badgeColor)
            .clipShape(Capsule())
    }
}
