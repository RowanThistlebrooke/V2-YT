//
//  PerformHealthApp.swift
//  PerformHealth — Apple Watch → Dashboard companion
//
//  Reads HealthKit metrics and POSTs them to your Vercel
//  /api/health-sync endpoint, which writes them to Supabase
//  for the dashboard (health.html) to display.
//

import SwiftUI

@main
struct PerformHealthApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .task {
                    // On launch: ask for HealthKit permission, register
                    // background delivery, and do an initial sync.
                    await model.bootstrap()
                }
        }
    }
}
