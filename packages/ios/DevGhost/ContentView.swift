import SwiftUI
import Core
import SharedUI
import Features

struct ContentView: View {
    @Environment(AuthManager.self) private var authManager
    @Environment(APIClient.self) private var apiClient

    var body: some View {
        Group {
            if authManager.isAuthenticated {
                mainTabView
            } else {
                LoginView(apiClient: apiClient, authManager: authManager)
            }
        }
        .animation(.easeInOut, value: authManager.isAuthenticated)
    }

    @ViewBuilder
    private var mainTabView: some View {
        TabView {
            Tab("Orders", systemImage: "house.fill") {
                NavigationStack {
                    OrderListView(apiClient: apiClient)
                }
            }

            Tab("Explore", systemImage: "globe") {
                NavigationStack {
                    ExploreView(apiClient: apiClient)
                }
            }

            Tab("Billing", systemImage: "creditcard.fill") {
                NavigationStack {
                    BillingDashboardView(apiClient: apiClient)
                }
            }

            Tab("Profile", systemImage: "person.fill") {
                NavigationStack {
                    ProfileView(apiClient: apiClient, authManager: authManager)
                }
            }

            if authManager.currentUser?.role == .admin {
                Tab("Admin", systemImage: "gear") {
                    NavigationStack {
                        AdminDashboardView(apiClient: apiClient)
                    }
                }
            }
        }
    }
}
