//
//  HealthManager.swift
//  All HealthKit access: authorization, background delivery, and
//  building a per-day metrics snapshot for the dashboard.
//

import Foundation
import HealthKit

struct DayMetrics: Codable {
    var day: String                       // "YYYY-MM-DD"

    var sleep_total_min: Int?
    var sleep_rem_min: Int?
    var sleep_core_min: Int?
    var sleep_deep_min: Int?
    var sleep_awake_min: Int?
    var sleep_start: String?
    var sleep_end: String?

    var resting_hr: Double?
    var walking_hr: Double?
    var hrv: Double?
    var cardio_recovery: Double?
    var heart_rate_min: Double?
    var heart_rate_avg: Double?

    var vo2max: Double?

    var spo2: Double?
    var respiratory_rate: Double?
    var wrist_temp_deviation: Double?

    var active_energy: Double?
    var resting_energy: Double?
    var exercise_min: Int?
    var stand_hours: Int?
    var steps: Int?
    var distance_km: Double?
    var flights: Int?

    var training_load: Double?

    var weight_kg: Double?
    var body_fat_pct: Double?
    var bmi: Double?

    var workouts: [Workout]?

    struct Workout: Codable {
        var type: String
        var minutes: Double
        var kcal: Double?
        var avgHr: Double?
    }
}

final class HealthManager {
    let store = HKHealthStore()

    // Types we read. Guarded ones (cardio recovery, wrist temp) are added
    // only when the OS supports them.
    private var readTypes: Set<HKObjectType> {
        var t: Set<HKObjectType> = [
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!,
            HKObjectType.quantityType(forIdentifier: .restingHeartRate)!,
            HKObjectType.quantityType(forIdentifier: .walkingHeartRateAverage)!,
            HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            HKObjectType.quantityType(forIdentifier: .heartRate)!,
            HKObjectType.quantityType(forIdentifier: .vo2Max)!,
            HKObjectType.quantityType(forIdentifier: .oxygenSaturation)!,
            HKObjectType.quantityType(forIdentifier: .respiratoryRate)!,
            HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKObjectType.quantityType(forIdentifier: .basalEnergyBurned)!,
            HKObjectType.quantityType(forIdentifier: .appleExerciseTime)!,
            HKObjectType.quantityType(forIdentifier: .stepCount)!,
            HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning)!,
            HKObjectType.quantityType(forIdentifier: .flightsClimbed)!,
            HKObjectType.quantityType(forIdentifier: .bodyMass)!,
            HKObjectType.quantityType(forIdentifier: .bodyFatPercentage)!,
            HKObjectType.quantityType(forIdentifier: .bodyMassIndex)!,
            HKObjectType.workoutType(),
            HKObjectType.activitySummaryType(),
        ]
        if let cr = HKObjectType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) { t.insert(cr) }
        if let wt = HKObjectType.quantityType(forIdentifier: .appleSleepingWristTemperature) { t.insert(wt) }
        return t
    }

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    // Wake the app in the background when key data changes; the closure
    // should kick off a sync.
    func enableBackgroundDelivery(onUpdate: @escaping () -> Void) {
        let triggers: [HKQuantityTypeIdentifier] = [.activeEnergyBurned, .heartRate, .stepCount]
        for id in triggers {
            guard let type = HKObjectType.quantityType(forIdentifier: id) else { continue }
            let q = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, _ in
                onUpdate()
                completion()
            }
            store.execute(q)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            let q = HKObserverQuery(sampleType: sleep, predicate: nil) { _, completion, _ in
                onUpdate()
                completion()
            }
            store.execute(q)
            store.enableBackgroundDelivery(for: sleep, frequency: .hourly) { _, _ in }
        }
    }

    // MARK: - Snapshot for a given day

    func snapshot(for date: Date) async -> DayMetrics {
        let cal = Calendar.current
        let dayStart = cal.startOfDay(for: date)
        let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart)!

        var m = DayMetrics(day: Self.dayString(dayStart))

        // Cumulative (sum over the day)
        m.active_energy  = await sum(.activeEnergyBurned, unit: .kilocalorie(), dayStart, dayEnd)
        m.resting_energy = await sum(.basalEnergyBurned, unit: .kilocalorie(), dayStart, dayEnd)
        m.exercise_min   = await sum(.appleExerciseTime, unit: .minute(), dayStart, dayEnd).map { Int($0.rounded()) }
        m.steps          = await sum(.stepCount, unit: .count(), dayStart, dayEnd).map { Int($0.rounded()) }
        m.distance_km    = await sum(.distanceWalkingRunning, unit: .meterUnit(with: .kilo), dayStart, dayEnd)
        m.flights        = await sum(.flightsClimbed, unit: .count(), dayStart, dayEnd).map { Int($0.rounded()) }

        // Latest sample within the day (daily-computed metrics)
        m.resting_hr = await latest(.restingHeartRate, unit: hrUnit, dayStart, dayEnd)
        m.walking_hr = await latest(.walkingHeartRateAverage, unit: hrUnit, dayStart, dayEnd)
        m.hrv        = await latest(.heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), dayStart, dayEnd)
        m.respiratory_rate = await latest(.respiratoryRate, unit: HKUnit.count().unitDivided(by: .minute()), dayStart, dayEnd)
        m.spo2       = (await latest(.oxygenSaturation, unit: .percent(), dayStart, dayEnd)).map { $0 * 100 }

        // Heart rate range overnight (use the whole day window)
        m.heart_rate_min = await stat(.heartRate, unit: hrUnit, dayStart, dayEnd, option: .discreteMin)
        m.heart_rate_avg = await stat(.heartRate, unit: hrUnit, dayStart, dayEnd, option: .discreteAverage)

        // Infrequent / most-recent-ever metrics
        m.vo2max       = await mostRecent(.vo2Max, unit: vo2Unit)
        m.weight_kg    = await mostRecent(.bodyMass, unit: .gramUnit(with: .kilo))
        m.body_fat_pct = (await mostRecent(.bodyFatPercentage, unit: .percent())).map { $0 * 100 }
        m.bmi          = await mostRecent(.bodyMassIndex, unit: .count())

        // OS-guarded
        if HKObjectType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) != nil {
            m.cardio_recovery = await latest(.heartRateRecoveryOneMinute, unit: hrUnit, dayStart, dayEnd)
        }
        if HKObjectType.quantityType(forIdentifier: .appleSleepingWristTemperature) != nil {
            m.wrist_temp_deviation = await latest(.appleSleepingWristTemperature, unit: .degreeCelsius(), dayStart, dayEnd)
        }

        // Activity rings (stand hours come from the summary)
        if let summary = await activitySummary(for: dayStart) {
            let standUnit = HKUnit.count()
            m.stand_hours = Int(summary.appleStandHours.doubleValue(for: standUnit).rounded())
            // exercise/active from summary are authoritative if present
            let exMin = summary.appleExerciseTime.doubleValue(for: .minute())
            if exMin > 0 { m.exercise_min = Int(exMin.rounded()) }
        }

        // Sleep (look at the night that ENDS on this day → previous 18:00 to noon)
        let sleepWindowStart = cal.date(byAdding: .hour, value: -6, to: dayStart)!  // prev 18:00
        let sleepWindowEnd   = cal.date(byAdding: .hour, value: 12, to: dayStart)!  // today noon
        await fillSleep(&m, sleepWindowStart, sleepWindowEnd)

        // Workouts for the day + training-load proxy
        m.workouts = await workouts(dayStart, dayEnd)
        m.training_load = trainingLoadProxy(active: m.active_energy, exercise: m.exercise_min, workouts: m.workouts)

        return m
    }

    // MARK: - Units

    private let hrUnit = HKUnit.count().unitDivided(by: .minute())
    private var vo2Unit: HKUnit {
        HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute()))
    }

    // MARK: - Query helpers

    private func sum(_ id: HKQuantityTypeIdentifier, unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        await stat(id, unit: unit, start, end, option: .cumulativeSum)
    }

    private func stat(_ id: HKQuantityTypeIdentifier, unit: HKUnit, _ start: Date, _ end: Date,
                      option: HKStatisticsOptions) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { return nil }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await withCheckedContinuation { cont in
            let q = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: pred, options: option) { _, res, _ in
                let qty: HKQuantity?
                switch option {
                case .cumulativeSum:     qty = res?.sumQuantity()
                case .discreteAverage:   qty = res?.averageQuantity()
                case .discreteMin:       qty = res?.minimumQuantity()
                case .discreteMax:       qty = res?.maximumQuantity()
                default:                 qty = res?.averageQuantity()
                }
                cont.resume(returning: qty?.doubleValue(for: unit))
            }
            store.execute(q)
        }
    }

    private func latest(_ id: HKQuantityTypeIdentifier, unit: HKUnit, _ start: Date, _ end: Date) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { return nil }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return await fetchLatest(type: type, predicate: pred, unit: unit)
    }

    private func mostRecent(_ id: HKQuantityTypeIdentifier, unit: HKUnit) async -> Double? {
        guard let type = HKObjectType.quantityType(forIdentifier: id) else { return nil }
        return await fetchLatest(type: type, predicate: nil, unit: unit)
    }

    private func fetchLatest(type: HKQuantityType, predicate: NSPredicate?, unit: HKUnit) async -> Double? {
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        return await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                let v = (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit)
                cont.resume(returning: v)
            }
            store.execute(q)
        }
    }

    private func fillSleep(_ m: inout DayMetrics, _ start: Date, _ end: Date) async {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return }
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
        let samples: [HKCategorySample] = await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, s, _ in
                cont.resume(returning: (s as? [HKCategorySample]) ?? [])
            }
            store.execute(q)
        }
        guard !samples.isEmpty else { return }

        var rem = 0.0, core = 0.0, deep = 0.0, awake = 0.0
        var asleepStart: Date?, asleepEnd: Date?
        for s in samples {
            let mins = s.endDate.timeIntervalSince(s.startDate) / 60.0
            switch s.value {
            case HKCategoryValueSleepAnalysis.asleepREM.rawValue:    rem += mins
            case HKCategoryValueSleepAnalysis.asleepCore.rawValue:   core += mins
            case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:   deep += mins
            case HKCategoryValueSleepAnalysis.awake.rawValue:        awake += mins
            case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue: core += mins
            default: continue
            }
            if s.value != HKCategoryValueSleepAnalysis.awake.rawValue {
                if asleepStart == nil || s.startDate < asleepStart! { asleepStart = s.startDate }
                if asleepEnd == nil || s.endDate > asleepEnd! { asleepEnd = s.endDate }
            }
        }
        let total = rem + core + deep
        if total > 0 {
            m.sleep_rem_min = Int(rem.rounded())
            m.sleep_core_min = Int(core.rounded())
            m.sleep_deep_min = Int(deep.rounded())
            m.sleep_awake_min = Int(awake.rounded())
            m.sleep_total_min = Int(total.rounded())
            m.sleep_start = asleepStart.map { Self.iso($0) }
            m.sleep_end = asleepEnd.map { Self.iso($0) }
        }
    }

    private func workouts(_ start: Date, _ end: Date) async -> [DayMetrics.Workout] {
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let items: [HKWorkout] = await withCheckedContinuation { cont in
            let q = HKSampleQuery(sampleType: .workoutType(), predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, s, _ in
                cont.resume(returning: (s as? [HKWorkout]) ?? [])
            }
            store.execute(q)
        }
        return items.map { w in
            let kcal = w.statistics(for: HKQuantityType(.activeEnergyBurned))?
                .sumQuantity()?.doubleValue(for: .kilocalorie())
            let avgHr = w.statistics(for: HKQuantityType(.heartRate))?
                .averageQuantity()?.doubleValue(for: hrUnit)
            return .init(type: Self.workoutName(w.workoutActivityType),
                         minutes: w.duration / 60.0,
                         kcal: kcal.map { ($0 * 10).rounded() / 10 },
                         avgHr: avgHr.map { ($0).rounded() })
        }
    }

    private func activitySummary(for day: Date) async -> HKActivitySummary? {
        let cal = Calendar.current
        var comps = cal.dateComponents([.year, .month, .day], from: day)
        comps.calendar = cal
        let pred = HKQuery.predicate(forActivitySummariesBetweenStart: comps, end: comps)
        return await withCheckedContinuation { cont in
            let q = HKActivitySummaryQuery(predicate: pred) { _, summaries, _ in
                cont.resume(returning: summaries?.first)
            }
            store.execute(q)
        }
    }

    // Proxy "training load" when the OS doesn't expose a readable value:
    // weighted blend of active energy + exercise minutes + workout effort.
    private func trainingLoadProxy(active: Double?, exercise: Int?, workouts: [DayMetrics.Workout]?) -> Double? {
        let ae = active ?? 0
        let ex = Double(exercise ?? 0)
        let wkMin = (workouts ?? []).reduce(0.0) { $0 + $1.minutes }
        let score = ae * 0.02 + ex * 0.5 + wkMin * 0.3
        return score > 0 ? (score * 10).rounded() / 10 : nil
    }

    // MARK: - Formatting

    static func dayString(_ d: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
    static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: d)
    }

    static func workoutName(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .running: return "Running"
        case .walking: return "Walking"
        case .cycling: return "Cycling"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "Strength"
        case .highIntensityIntervalTraining: return "HIIT"
        case .swimming: return "Swimming"
        case .yoga: return "Yoga"
        case .hiking: return "Hiking"
        case .rowing: return "Rowing"
        case .elliptical: return "Elliptical"
        default: return "Workout"
        }
    }
}
