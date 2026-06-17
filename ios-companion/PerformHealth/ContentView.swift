//
//  ContentView.swift
//  Minimal UI: connection status, last sync, a manual "Sync now"
//  button, and a Settings sheet for the endpoint + secret.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section("Status") {
                    LabeledContent("State", value: model.status)
                    LabeledContent("Last sync", value: model.lastSync.map { format($0) } ?? "Never")
                    if let err = model.lastError {
                        Text(err).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section("Connection") {
                    LabeledContent("Endpoint", value: short(AppSettings.endpoint))
                    LabeledContent("Configured", value: AppSettings.isConfigured ? "Yes" : "No")
                }

                Section {
                    Button {
                        Task { await model.syncNow() }
                    } label: {
                        HStack {
                            if model.isSyncing { ProgressView().padding(.trailing, 6) }
                            Text(model.isSyncing ? "Syncing…" : "Sync now")
                        }
                    }
                    .disabled(model.isSyncing || !AppSettings.isConfigured)
                }

                Section {
                    Text("This app reads Apple Health metrics and sends them to your dashboard. It runs syncs in the background when new data arrives.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Perform Health")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
    }

    private func format(_ d: Date) -> String {
        let f = DateFormatter(); f.dateStyle = .short; f.timeStyle = .short
        return f.string(from: d)
    }
    private func short(_ s: String) -> String {
        guard let u = URL(string: s), let host = u.host else { return s.isEmpty ? "—" : s }
        return host
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) var dismiss
    @State private var endpoint = AppSettings.endpoint
    @State private var secret = AppSettings.secret

    var body: some View {
        NavigationStack {
            Form {
                Section("Webhook URL") {
                    TextField("https://your-app.vercel.app/api/health-sync", text: $endpoint)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                Section("Sync secret") {
                    SecureField("HEALTH_SYNC_SECRET", text: $secret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Text("These must match the env vars set on Vercel. The secret protects your endpoint so only this app can write data.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        AppSettings.endpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
                        AppSettings.secret = secret.trimmingCharacters(in: .whitespacesAndNewlines)
                        AppSettings.backfillDone = false  // re-backfill after reconfig
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
