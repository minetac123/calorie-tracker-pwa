import Foundation
import Capacitor

/// Most mezi JS a RestCountdownAudio: webová část zná jen čas, kdy pauza mezi
/// sériemi skončí, nativní strana z toho udělá zvukový odpočet, který přežije
/// zamčenou obrazovku (JS timery v pozadí ne).
@objc(RestAudioPlugin)
public class RestAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RestAudioPlugin"
    public let jsName = "RestAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "arm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    /// `restEndsAt` je epocha v **milisekundách** (Date.now() z JS), zatímco
    /// Date v Swiftu počítá v sekundách — bez dělení tisícem by odpočet
    /// vyšel někam do roku 56 000.
    @objc func arm(_ call: CAPPluginCall) {
        guard let restEndsAtMs = call.getDouble("restEndsAt") else {
            call.reject("Chybí parametr restEndsAt (epocha v milisekundách).")
            return
        }

        let restEndsAt = Date(timeIntervalSince1970: restEndsAtMs / 1000.0)
        RestCountdownAudio.arm(restEndsAt: restEndsAt)

        // Naplánování je asynchronní a JS na jeho výsledek stejně nečeká —
        // zvuk je doplněk, odpočet v UI běží nezávisle.
        call.resolve()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        RestCountdownAudio.cancel()
        call.resolve()
    }
}
