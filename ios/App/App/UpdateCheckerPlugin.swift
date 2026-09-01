import Foundation
import Capacitor

/// Most mezi JS a UpdateCheckerem: tlačítko "Zkontrolovat aktualizace" ve
/// webu volá tohle, aby obešlo šestihodinovou pojistku v
/// UpdateChecker.checkAndPrompt (viz komentář tam) — bez ní by uživatel
/// musel čekat na další automatickou kontrolu při přepnutí do appky.
@objc(UpdateCheckerPlugin)
public class UpdateCheckerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "UpdateCheckerPlugin"
    public let jsName = "UpdateChecker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkNow", returnType: CAPPluginReturnPromise)
    ]

    /// Spustí kontrolu a rovnou vrátí JS zpátky — výsledek (nová verze /
    /// "máš nejnovější" / chyba) appka zobrazí sama nativním dialogem,
    /// není co posílat zpátky do webu.
    @objc func checkNow(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UpdateChecker.checkAndPrompt(force: true)
        }
        call.resolve()
    }
}
