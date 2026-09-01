import Foundation
import AVFoundation

/// Zvukové odpočítávání posledních 5 sekund pauzy mezi sériemi.
///
/// Proč vlastní syntéza tónu a ne přibalený .caf/.wav soubor: v repozitáři
/// žádné zvukové assety nejsou a přidávat binárku kvůli dvěma pípnutím by
/// znamenalo další položku v .pbxproj (nejkřehčí soubor projektu). Sinusovka
/// se spočítá do PCM bufferu za zlomek milisekundy, takže se nic neušetří tím,
/// že by se načítala z disku.
///
/// Proč AVAudioEngine a ne Timer + AVAudioPlayer: v pozadí (zamčená obrazovka)
/// je běžný Timer škrcený a pípnutí by přišla pozdě nebo vůbec. Engine si drží
/// vlastní render thread a buffery se do fronty naskládají dopředu — od chvíle,
/// kdy odpočítávání nastavíme, je pořadí i délka bufferů dané, takže časování
/// určuje audio hardware (vzorkovací frekvence), ne scheduler aplikace.
/// Do doby odpočítávání hraje ticho — to je zároveň to, co drží proces vzhůru
/// (vyžaduje background mode "audio" v Info.plist).
enum RestCountdownAudio {

    // MARK: - Konfigurace

    private static let sampleRate: Double = 44_100

    /// Frekvence krátkých pípnutí (5…1) a delšího koncového tónu.
    private static let tickFrequency: Double = 880
    private static let goFrequency: Double = 1_320

    /// Pojistka proti absurdně dlouhé pauze — nechceme držet audio session
    /// (a tím i běh na pozadí) hodiny kvůli překlepu v JS.
    private static let maxLeadIn: TimeInterval = 30 * 60

    // MARK: - Stav

    /// Veškerý přístup ke stavu jde přes jednu sériovou frontu; arm() může
    /// přijít z JS mostu a teardown z audio completion handleru současně.
    private static let queue = DispatchQueue(label: "cz.fitai.rest-countdown-audio")

    private static var engine: AVAudioEngine?
    private static var player: AVAudioPlayerNode?
    private static var duckTimer: DispatchSourceTimer?

    /// Rozlišuje "běh", který si o úklid řekl, od toho, co už mezitím
    /// nahradilo nové arm() — jinak by pozdní completion handler shodil
    /// zvuk čerstvě nastavené pauzy.
    private static var generation: Int = 0

    // MARK: - Veřejné API

    /// Naplánuje pípání na posledních 5 sekund před `restEndsAt`.
    /// Opakované volání je bezpečné — předchozí plán se zahodí.
    static func arm(restEndsAt: Date) {
        queue.async { armLocked(restEndsAt: restEndsAt) }
    }

    /// Zruší čekající pípnutí a pustí audio session (uživatel přeskočil pauzu).
    static func cancel() {
        queue.async { teardownLocked() }
    }

    // MARK: - Implementace

    private static func armLocked(restEndsAt: Date) {
        teardownLocked()

        generation &+= 1
        let gen = generation

        let total = restEndsAt.timeIntervalSinceNow
        guard total > 0.1, total < maxLeadIn else { return }

        // Kolik pípnutí se ještě vejde — když se pauza armuje třeba 2 s před
        // koncem, odpočítáváme jen "2, 1, teď", ne celých pět.
        let ticks = min(5, Int(floor(total)))
        let leadIn = max(0, total - Double(ticks))

        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { return }

        // Nejdřív jen mícháme — kdybychom duckOthers zapnuli hned, hudba by
        // uživateli hrála potichu celou pauzu, ne jen poslední sekundy.
        guard activateSession(options: [.mixWithOthers]) else { return }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)

        do {
            try engine.start()
        } catch {
            // Zvuk je nadstandard, ne funkce appky — když se engine nerozjede,
            // mlčky nic nehrajeme, odpočet v UI běží dál.
            engine.detach(player)
            deactivateSession()
            return
        }

        RestCountdownAudio.engine = engine
        RestCountdownAudio.player = player

        // Ticho po celý zbytek pauzy: jeden vteřinový buffer zařazený do fronty
        // opakovaně (buffer lze naplánovat vícekrát, nekopíruje se), plus
        // zbytek pod sekundu jako první, kratší kus.
        let secondOfSilence = makeBuffer(format: format, seconds: 1, frequency: nil)
        let fraction = leadIn - floor(leadIn)
        if fraction > 0.005, let partial = makeBuffer(format: format, seconds: fraction, frequency: nil) {
            player.scheduleBuffer(partial, completionHandler: nil)
        }
        if let secondOfSilence = secondOfSilence {
            for _ in 0..<Int(floor(leadIn)) {
                player.scheduleBuffer(secondOfSilence, completionHandler: nil)
            }
        }

        // Každé pípnutí je vteřinový buffer: krátký tón a zbytek ticho, takže
        // rozestupy drží samotná délka bufferu — žádný další časovač.
        if ticks > 0, let tick = makeBuffer(format: format, seconds: 1, frequency: tickFrequency, toneSeconds: 0.12) {
            for _ in 0..<ticks {
                player.scheduleBuffer(tick, completionHandler: nil)
            }
        }

        if let go = makeBuffer(format: format, seconds: 0.6, frequency: goFrequency, toneSeconds: 0.45) {
            player.scheduleBuffer(go) {
                queue.async {
                    guard generation == gen else { return }
                    teardownLocked()
                }
            }
        }

        player.play()

        // Ducking zapneme až těsně před prvním pípnutím. V tuhle chvíli už
        // engine hraje (byť ticho), takže proces neusnul a timer spolehlivě
        // dojede i se zamčenou obrazovkou.
        if leadIn > 0.5 {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + (leadIn - 0.5))
            timer.setEventHandler {
                guard generation == gen else { return }
                _ = activateSession(options: [.duckOthers])
            }
            duckTimer = timer
            timer.resume()
        } else {
            _ = activateSession(options: [.duckOthers])
        }
    }

    private static func teardownLocked() {
        duckTimer?.cancel()
        duckTimer = nil

        player?.stop()
        if let engine = engine {
            engine.stop()
            if let player = player {
                engine.detach(player)
            }
        }
        player = nil
        engine = nil

        deactivateSession()
    }

    // MARK: - Audio session

    @discardableResult
    private static func activateSession(options: AVAudioSession.CategoryOptions) -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: options)
            try session.setActive(true)
            return true
        } catch {
            return false
        }
    }

    /// TOHLE je nejdůležitější řádek celého souboru: bez
    /// .notifyOthersOnDeactivation se cizí přehrávač nedozví, že jsme skončili,
    /// a uživateli zůstane hudba ztlumená (duckovaná) klidně navždy — dokud
    /// sám nepřepne skladbu. Deaktivaci proto děláme i na všech chybových
    /// cestách, ne jen po úspěšném doběhnutí odpočtu.
    private static func deactivateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // Session mohla být už neaktivní — není co řešit.
        }
    }

    // MARK: - Syntéza tónu

    /// Vyrobí mono buffer dané délky. `frequency == nil` znamená ticho,
    /// jinak se na začátek vloží sinusovka dlouhá `toneSeconds` a zbytek
    /// je ticho.
    private static func makeBuffer(format: AVAudioFormat,
                                   seconds: Double,
                                   frequency: Double?,
                                   toneSeconds: Double = 0) -> AVAudioPCMBuffer? {
        let frameCount = AVAudioFrameCount(max(1, Int(seconds * sampleRate)))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        buffer.frameLength = frameCount

        guard let channel = buffer.floatChannelData?[0] else { return nil }
        for i in 0..<Int(frameCount) {
            channel[i] = 0
        }

        guard let frequency = frequency, toneSeconds > 0 else { return buffer }

        let toneFrames = min(Int(frameCount), Int(toneSeconds * sampleRate))
        guard toneFrames > 0 else { return buffer }

        // Krátký náběh a doběh hlasitosti — skok z nuly na plnou amplitudu
        // je v reproduktoru slyšet jako lupnutí.
        let ramp = max(1, Int(0.005 * sampleRate))
        let step = 2.0 * Double.pi * frequency / sampleRate

        for i in 0..<toneFrames {
            var gain = 0.6
            if i < ramp {
                gain *= Double(i) / Double(ramp)
            } else if i > toneFrames - ramp {
                gain *= Double(toneFrames - i) / Double(ramp)
            }
            channel[i] = Float(sin(step * Double(i)) * gain)
        }

        return buffer
    }
}
