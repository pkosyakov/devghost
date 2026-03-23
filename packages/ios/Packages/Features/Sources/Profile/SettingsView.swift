import SwiftUI
import Core
import SharedUI

public struct SettingsView: View {
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true
    @State private var showDeleteAccountInfo = false

    public init() {}

    public var body: some View {
        List {
            notificationsSection
            aboutSection
            dangerZone
        }
        .navigationTitle("Settings")
        .alert("Delete Account", isPresented: $showDeleteAccountInfo) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Account deletion is handled through the web app. Please visit devghost.io/settings to request account deletion.")
        }
    }

    @ViewBuilder
    private var notificationsSection: some View {
        Section("Notifications") {
            Toggle(isOn: $notificationsEnabled) {
                Label("Push Notifications", systemImage: "bell.badge")
            }

            if notificationsEnabled {
                HStack {
                    Label("Analysis Complete", systemImage: "checkmark.circle")
                    Spacer()
                    Text("Enabled")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Label("Credit Alerts", systemImage: "exclamationmark.triangle")
                    Spacer()
                    Text("Enabled")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var aboutSection: some View {
        Section("About") {
            HStack {
                Label("Version", systemImage: "info.circle")
                Spacer()
                Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                    .foregroundStyle(.secondary)
            }

            HStack {
                Label("Build", systemImage: "hammer")
                Spacer()
                Text(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                    .foregroundStyle(.secondary)
            }

            Link(destination: URL(string: "https://devghost.io/terms")!) {
                Label("Terms of Service", systemImage: "doc.text")
            }

            Link(destination: URL(string: "https://devghost.io/privacy")!) {
                Label("Privacy Policy", systemImage: "hand.raised")
            }

            Link(destination: URL(string: "https://github.com/devghost")!) {
                Label("GitHub", systemImage: "link")
            }
        }
    }

    @ViewBuilder
    private var dangerZone: some View {
        Section {
            Button(role: .destructive) {
                showDeleteAccountInfo = true
            } label: {
                Label("Delete Account", systemImage: "trash")
                    .foregroundStyle(.red)
            }
        } footer: {
            Text("Account deletion must be performed through the web application.")
        }
    }
}
