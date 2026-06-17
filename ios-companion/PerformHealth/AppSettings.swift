//
//  AppSettings.swift
//  Stores the webhook URL + sync secret (in UserDefaults) and the
//  last-sync status. Edit these from the Settings screen in the app.
//

import Foundation

enum SettingsKey {
    static let endpoint = "endpointURL"
    static let secret   = "syncSecret"
    static let lastSync = "lastSyncAt"
    static let lastError = "lastSyncError"
    static let backfillDone = "backfillDone"
}

struct AppSettings {
    static var endpoint: String {
        get { UserDefaults.standard.string(forKey: SettingsKey.endpoint) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: SettingsKey.endpoint) }
    }
    static var secret: String {
        get { UserDefaults.standard.string(forKey: SettingsKey.secret) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: SettingsKey.secret) }
    }
    static var lastSync: Date? {
        get { UserDefaults.standard.object(forKey: SettingsKey.lastSync) as? Date }
        set { UserDefaults.standard.set(newValue, forKey: SettingsKey.lastSync) }
    }
    static var lastError: String? {
        get { UserDefaults.standard.string(forKey: SettingsKey.lastError) }
        set { UserDefaults.standard.set(newValue, forKey: SettingsKey.lastError) }
    }
    static var backfillDone: Bool {
        get { UserDefaults.standard.bool(forKey: SettingsKey.backfillDone) }
        set { UserDefaults.standard.set(newValue, forKey: SettingsKey.backfillDone) }
    }

    static var isConfigured: Bool {
        guard let url = URL(string: endpoint), url.scheme?.hasPrefix("http") == true else { return false }
        return !secret.isEmpty
    }
}
