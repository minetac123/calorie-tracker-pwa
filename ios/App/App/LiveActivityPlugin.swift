import ActivityKit
import Capacitor
import Foundation

/// Most mezi JS tréninkem a ActivityKitem. Stav tréninku vlastní webview,
/// nativní strana je jen "displej" — proto plugin neřeší žádnou logiku sérií
/// a jen překlápí hodnoty z JS do běžící Live Activity.
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "WorkoutLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeSkipRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    /// Musí sedět se `SkipRestIntent.skipKey`. Píše se do `UserDefaults.standard`
    /// a ne do App Group — `LiveActivityIntent` běží v procesu appky, takže je
    /// to tentýž kontejner, a App Group by na sideloadu s free Apple ID
    /// nemusela projít (viz komentář v SkipRestIntent.swift).
    private static let skipKey = "skipRestRequestedAt"

    /// Držíme si referenci, protože `Activity.request` je jediné místo, kde ji
    /// dostaneme; bez ní by update/end neměly co adresovat. Typ je schovaný za
    /// `Any`, aby se property nemusela značit `@available` (uloženou property
    /// v CAPPlugin nejde availability-guardovat).
    private var currentActivityBox: Any?

    @available(iOS 16.2, *)
    private var currentActivity: Activity<WorkoutActivityAttributes>? {
        get { currentActivityBox as? Activity<WorkoutActivityAttributes> }
        set { currentActivityBox = newValue }
    }

    // MARK: - JS API

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activity vyžaduje iOS 16.2 nebo novější.")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Živé aktivity jsou pro tuto appku vypnuté v Nastavení.")
            return
        }
        guard let sessionId = call.getString("sessionId"),
              let exerciseName = call.getString("exerciseName") else {
            call.reject("Chybí povinné parametry sessionId a exerciseName.")
            return
        }

        let attributes = WorkoutActivityAttributes(
            sessionId: sessionId,
            sessionTitle: call.getString("sessionTitle") ?? "Trénink"
        )
        let state = Self.contentState(from: call, exerciseName: exerciseName)

        Task { @MainActor in
            // Dvě souběžné aktivity by uživateli zůstaly viset na zamykačce,
            // takže případnou předchozí nejdřív ukončíme.
            await self.endAllActivities(dismiss: true)
            do {
                let activity = try Activity<WorkoutActivityAttributes>.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: nil),
                    pushType: nil
                )
                self.currentActivity = activity
                call.resolve(["activityId": activity.id])
            } catch {
                call.reject("Live Activity se nepodařilo spustit: \(error.localizedDescription)")
            }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activity vyžaduje iOS 16.2 nebo novější.")
            return
        }
        guard let exerciseName = call.getString("exerciseName") else {
            call.reject("Chybí povinný parametr exerciseName.")
            return
        }

        let state = Self.contentState(from: call, exerciseName: exerciseName)

        Task { @MainActor in
            // Po restartu appky je `currentActivity` prázdná, ale systém si
            // aktivitu drží dál — proto se dohledá i v `Activity.activities`.
            let activity = self.currentActivity ?? Activity<WorkoutActivityAttributes>.activities.first
            guard let activity else {
                call.reject("Žádná běžící Live Activity k aktualizaci.")
                return
            }
            self.currentActivity = activity
            await activity.update(ActivityContent(state: state, staleDate: nil))
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.reject("Live Activity vyžaduje iOS 16.2 nebo novější.")
            return
        }
        Task { @MainActor in
            await self.endAllActivities(dismiss: true)
            call.resolve()
        }
    }

    /// Diagnostika pro tlačítko v Nastavení. Live Activity umí selhat několika
    /// způsoby, které jsou zvenčí k nerozeznání (widget se při sideloadu
    /// odstranil, uživatel má Live Activities vypnuté v Nastavení, starý iOS) —
    /// bez tohohle by se to muselo hádat, jako u kontroly aktualizací.
    @objc func status(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else {
            call.resolve([
                "supported": false,
                "enabled": false,
                "running": 0,
                "reason": "Vyžaduje iOS 16.2 nebo novější."
            ])
            return
        }
        call.resolve([
            "supported": true,
            "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
            "running": Activity<WorkoutActivityAttributes>.activities.count,
            "reason": ""
        ])
    }

    /// Vyzvedne a smaže požadavek na přeskočení pauzy, který na zamykačce zapsal
    /// `SkipRestIntent`. Čte se jednorázově, aby se stejný stisk nezpracoval
    /// dvakrát při dalším přechodu do popředí.
    @objc func consumeSkipRequest(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        let requested = defaults.object(forKey: Self.skipKey) != nil
        if requested {
            defaults.removeObject(forKey: Self.skipKey)
        }
        call.resolve(["skipRequested": requested])
    }

    // MARK: - Pomocné

    @available(iOS 16.2, *)
    private func endAllActivities(dismiss: Bool) async {
        let policy: ActivityUIDismissalPolicy = dismiss ? .immediate : .default
        for activity in Activity<WorkoutActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: policy)
        }
        currentActivity = nil
    }

    @available(iOS 16.2, *)
    private static func contentState(
        from call: CAPPluginCall,
        exerciseName: String
    ) -> WorkoutActivityAttributes.ContentState {
        var previousLift = call.getString("previousLift")
        if previousLift?.isEmpty == true { previousLift = nil }

        return WorkoutActivityAttributes.ContentState(
            exerciseName: exerciseName,
            previousLift: previousLift,
            restEndsAt: date(fromEpochMillis: call.getDouble("restEndsAt")),
            restTotalSec: call.getInt("restTotalSec") ?? 0,
            setsDone: call.getInt("setsDone") ?? 0,
            setsTarget: call.getInt("setsTarget") ?? 0
        )
    }

    /// JS posílá `Date.now()`, tedy milisekundy — `Date(timeIntervalSince1970:)`
    /// bere sekundy, bez dělení by pauza končila někdy v roce 57 000.
    private static func date(fromEpochMillis millis: Double?) -> Date? {
        guard let millis, millis > 0 else { return nil }
        return Date(timeIntervalSince1970: millis / 1000.0)
    }
}
