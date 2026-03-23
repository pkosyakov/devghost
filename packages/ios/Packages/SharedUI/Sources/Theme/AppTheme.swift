import SwiftUI

public enum AppTheme {
    // MARK: - Colors
    public enum Colors {
        public static let primary = Color.accentColor
        public static let surfaceSecondary = Color.gray.opacity(0.1)
        public static let secondaryBackground = Color.secondary.opacity(0.1)

        public static let ghostExcellent = Color.green
        public static let ghostGood = Color.green
        public static let ghostWarning = Color.yellow
        public static let ghostLow = Color.red
        public static let ghostNA = Color.gray

        public static let accent = Color.accentColor
        public static let background = Color(.systemGroupedBackground)
        public static let cardBackground = Color(.secondarySystemGroupedBackground)
        public static let secondaryText = Color.secondary
    }

    // MARK: - Spacing
    public enum Spacing {
        public static let xs: CGFloat = 4
        public static let sm: CGFloat = 8
        public static let small: CGFloat = 8
        public static let md: CGFloat = 16
        public static let medium: CGFloat = 16
        public static let lg: CGFloat = 24
        public static let large: CGFloat = 24
        public static let xl: CGFloat = 32
        public static let extraLarge: CGFloat = 32
        public static let xxl: CGFloat = 48
    }

    // MARK: - Corner Radius
    public enum CornerRadius {
        public static let sm: CGFloat = 8
        public static let md: CGFloat = 12
        public static let lg: CGFloat = 16
    }
}
