//
//  AppModel.swift
//  Orchestrates authorization, background delivery, and syncing.
//  Observable so the UI can show status.
//

import Foundation
import Combine

@MainActor
final class AppModel: ObservableObject {
    @Published var status: String = "Idle"
    @Published var lastSync: Date? = AppSettings.lastSync
    @Published var lastError: String? = AppSettings.lastError
    @Published var isSyncing = false

    private let health = HealthManager()
    private let sync = SyncService()

    func bootstrap() async {
        do {
            status = "Requesting Health access…"
            try await health.requestAuthorization()
        } catch {
            lastError = "Health access: \(error.localizedDescription)"
            AppSettings.lastError = lastError
        }
        // Background updates → sync today's snapshot whenever data changes.
        health.enableBackgroundDelivery { [weak self] in
            Task { await self?.syncRecent(days: 1, silent: true) }
        }
        // First run backfills history so trend charts have data.
        if AppSettings.isConfigured && !AppSettings.backfillDone {
            await syncRecent(days: 30, silent: false)
            AppSettings.backfillDone = true
        } else {
            await syncRecent(days: 2, silent: false)
        }
    }

    func syncNow() async { await syncRecent(days: 7, silent: false) }

    func syncRecent(days: Int, silent: Bool) async {
        guard AppSettings.isConfigured else {
            if !silent { status = "Not configured — open Settings" }
            return
        }
        if isSyncing { return }
        isSyncing = true
        if !silent { status = "Collecting \(days) day(s)…" }

        var snapshots: [DayMetrics] = []
        let cal = Calendar.current
        for offset in 0..<days {
            guard let d = cal.date(byAdding: .day, value: -offset, to: Date()) else { continue }
            let snap = await health.snapshot(for: d)
            snapshots.append(snap)
        }

        do {
            if !silent { status = "Uploading…" }
            try await sync.send(snapshots)
            lastSync = Date()
            lastError = nil
            AppSettings.lastSync = lastSync
            AppSettings.lastError = nil
            status = "Synced ✓"
        } catch {
            lastError = error.localizedDescription
            AppSettings.lastError = lastError
            status = "Sync failed"
        }
        isSyncing = false
    }
}
