import SwiftUI
import Core

@main
struct DevGhostApp: App {
    @State private var authManager = AuthManager()
    @State private var apiClient: APIClient

    init() {
        let auth = AuthManager()
        let client = APIClient(baseURL: URL(string: "http://localhost:3000")!, authManager: auth)
        APIClient.shared = client
        _authManager = State(initialValue: auth)
        _apiClient = State(initialValue: client)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authManager)
                .environment(apiClient)
        }
    }
}
