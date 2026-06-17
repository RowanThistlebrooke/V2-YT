//
//  SyncService.swift
//  Encodes DayMetrics and POSTs them to /api/health-sync.
//

import Foundation

enum SyncError: LocalizedError {
    case notConfigured
    case badURL
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Set the endpoint URL and secret in Settings first."
        case .badURL: return "Endpoint URL is invalid."
        case .http(let code, let msg): return "Server \(code): \(msg)"
        }
    }
}

struct SyncService {
    func send(_ days: [DayMetrics]) async throws {
        guard AppSettings.isConfigured else { throw SyncError.notConfigured }
        guard let url = URL(string: AppSettings.endpoint) else { throw SyncError.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + AppSettings.secret, forHTTPHeaderField: "Authorization")

        let enc = JSONEncoder()
        // Drop nil fields so we never overwrite good data with null.
        req.httpBody = try enc.encode(days)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw SyncError.http(0, "no response")
        }
        guard (200...299).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw SyncError.http(http.statusCode, body)
        }
    }
}
