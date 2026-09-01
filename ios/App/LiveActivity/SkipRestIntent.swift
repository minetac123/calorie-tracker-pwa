import ActivityKit
import AppIntents
import Foundation

/// Tlačítko "Přeskočit pauzu" na zamykací obrazovce.
///
/// App Intent nemá jak zavolat JS ve webview — proto se přeskočení jen zapíše
/// jako časové razítko a appka si ho vyzvedne
/// (`WorkoutLiveActivity.consumeSkipRequest`) ve chvíli, kdy se příště dostane
/// do popředí. Razítko, ne bool, aby šlo poznat staré neposlané požadavky od
/// čerstvých.
///
/// `LiveActivityIntent` (iOS 17) je tu schválně místo holého `AppIntent`:
/// zaručuje spuštění **v procesu appky**, takže se smí sáhnout na běžící
/// Activity — a hlavně je `UserDefaults.standard` rovnou paměť appky.
///
/// Proto tu záměrně NENÍ App Group: ta by potřebovala entitlement v
/// provisioning profilu, jenže appka se sideloaduje přes SideStore na free
/// Apple ID, kde se App Groups běžně přepisují nebo zahazují (a build je
/// navíc staví s prázdným CODE_SIGN_ENTITLEMENTS). Zápis by pak tiše mizel.
@available(iOS 17.0, *)
struct SkipRestIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Přeskočit pauzu"
    static var description = IntentDescription("Ukončí odpočet pauzy mezi sériemi.")

    static let skipKey = "skipRestRequestedAt"

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.skipKey)

        // Zároveň se pauza ukončí i vizuálně, aby uživatel nečekal na to, až se
        // appka probudí a stav dotlačí přes plugin.
        for activity in Activity<WorkoutActivityAttributes>.activities {
            var state = activity.content.state
            state.restEndsAt = nil
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }

        return .result()
    }
}
