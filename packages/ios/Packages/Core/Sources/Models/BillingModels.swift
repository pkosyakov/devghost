import Foundation

public struct BalanceInfo: Codable, Sendable {
    public let permanent: Int
    public let subscription: Int
    public let reserved: Int
    public let available: Int
    public let subscriptionExpiresAt: Date?
}

public struct BalanceResponse: Codable, Sendable {
    public let balance: BalanceInfo
    public let subscription: SubscriptionInfo?
}

public struct SubscriptionInfo: Codable, Identifiable, Sendable {
    public let id: String
    public let planName: String
    public let creditsPerMonth: Int
    public let priceUsd: Double
    public let status: String
    public let currentPeriodEnd: Date?

    public var name: String { planName }
}

public struct CreditPack: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let credits: Int
    public let priceUsd: Double
    public let appStoreProductId: String?
    public let sortOrder: Int?

    public var formattedPrice: String { String(format: "$%.2f", priceUsd) }
}

public struct CreditTransaction: Codable, Identifiable, Sendable {
    public let id: String
    public let type: String
    public let amount: Int
    public let wallet: String
    public let balanceAfter: Int
    public let description: String?
    public let createdAt: Date

    public var displayName: String {
        switch type {
        case "REGISTRATION": return "Registration Bonus"
        case "PACK_PURCHASE": return "Credit Pack Purchase"
        case "SUBSCRIPTION_RENEWAL": return "Subscription Renewal"
        case "SUBSCRIPTION_EXPIRY": return "Subscription Expired"
        case "PROMO_REDEMPTION": return "Promo Code Redeemed"
        case "REFERRAL_BONUS": return "Referral Bonus"
        case "REFERRAL_REWARD": return "Referral Reward"
        case "ANALYSIS_RESERVE": return "Analysis Reserved"
        case "ANALYSIS_DEBIT": return "Analysis Charged"
        case "ANALYSIS_RELEASE": return "Analysis Released"
        case "ADMIN_ADJUSTMENT": return "Admin Adjustment"
        default: return type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

public struct TransactionsResponse: Codable, Sendable {
    public let transactions: [CreditTransaction]
    public let pagination: Pagination
}

public struct Pagination: Codable, Sendable {
    public let page: Int
    public let pageSize: Int
    public let total: Int
    public let totalPages: Int
}
