import Foundation
import UIKit

/// Kontrola aktualizací proti veřejným GitHub Releases + instalace přes SideStore.
///
/// Appka se sideloaduje, takže nemá App Store, který by ji aktualizoval. Tohle
/// je náhrada: zeptá se GitHubu na nejnovější release, porovná ho s verzí, která
/// právě běží, a když je novější, nabídne instalaci jedním klepnutím.
///
/// SideStore stahuje .ipa přímo z předané URL, takže musí být veřejně dostupná
/// bez přihlášení — proto GitHub *Release asset*, ne artifact z Actions
/// (ten je za autentizací a SideStore by ho nestáhl).
///
/// Nic tu nepodepisuje ani neinstaluje samo — jen předá URL SideStoru, který
/// si .ipa podepíše uživatelovým Apple ID stejně jako při ruční instalaci.
enum UpdateChecker {

    // MARK: - Konfigurace

    /// Vlastník a název repozitáře, ze kterého se čtou releases.
    /// Kdybys projekt přesunul jinam, měň to tady.
    private static let repoOwner = "minetac123"
    private static let repoName = "calorie-tracker-pwa"

    /// Jak často se smí ptát. Bez tohohle by kontrola běžela při každém
    /// přepnutí do appky a uživatel by dostával dialog pořád dokola.
    private static let checkInterval: TimeInterval = 6 * 60 * 60 // 6 hodin
    private static let lastCheckKey = "UpdateChecker.lastCheck"

    // MARK: - Veřejné typy

    struct Release {
        /// Verze bez případného "v" na začátku, např. "2.40.0".
        let version: String
        /// Přímý odkaz na .ipa (nil, když release nemá .ipa přílohu).
        let ipaURL: URL?
        /// Stránka release na GitHubu — fallback, když SideStore chybí.
        let pageURL: URL
    }

    enum CheckError: LocalizedError {
        case badResponse(Int)
        case noReleaseFound
        case malformedPayload

        var errorDescription: String? {
            switch self {
            case .badResponse(let code): return "GitHub odpověděl \(code)."
            case .noReleaseFound: return "Repozitář zatím nemá žádný release."
            case .malformedPayload: return "Odpověď GitHubu nejde přečíst."
            }
        }
    }

    // MARK: - Verze běžící aplikace

    /// CFBundleShortVersionString, tedy MARKETING_VERSION z buildu.
    /// Workflow ji plní z APP_VERSION v api/_lib/version.js, takže sedí
    /// s tagem releasu — bez toho by porovnání nedávalo smysl.
    static var currentVersion: String {
        let raw = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return normalize(raw ?? "0")
    }

    // MARK: - Dotaz na GitHub

    /// Zjistí nejnovější release. Doběhne vždy na hlavním vlákně.
    static func fetchLatestRelease(completion: @escaping (Result<Release, Error>) -> Void) {
        let endpoint = "https://api.github.com/repos/\(repoOwner)/\(repoName)/releases/latest"
        guard let url = URL(string: endpoint) else {
            finish(.failure(CheckError.malformedPayload), completion)
            return
        }

        var request = URLRequest(url: url)
        // GitHub doporučuje explicitní Accept; bez něj může vrátit jinou podobu JSONu.
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                finish(.failure(error), completion)
                return
            }
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                // 404 znamená "žádný release", ne poruchu — rozlišeno kvůli hlášce.
                let err: Error = http.statusCode == 404 ? CheckError.noReleaseFound
                                                        : CheckError.badResponse(http.statusCode)
                finish(.failure(err), completion)
                return
            }
            guard
                let data = data,
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let tag = json["tag_name"] as? String
            else {
                finish(.failure(CheckError.malformedPayload), completion)
                return
            }

            let assets = json["assets"] as? [[String: Any]] ?? []
            let ipaAsset = assets.first { asset in
                (asset["name"] as? String)?.lowercased().hasSuffix(".ipa") == true
            }
            let ipaURL = (ipaAsset?["browser_download_url"] as? String).flatMap(URL.init(string:))

            let pageURLString = json["html_url"] as? String
                ?? "https://github.com/\(repoOwner)/\(repoName)/releases/latest"
            guard let pageURL = URL(string: pageURLString) else {
                finish(.failure(CheckError.malformedPayload), completion)
                return
            }

            finish(.success(Release(version: normalize(tag), ipaURL: ipaURL, pageURL: pageURL)),
                   completion)
        }.resume()
    }

    // MARK: - Porovnání verzí

    /// Odstraní "v" na začátku a ořeže bílé znaky: "v2.40.0" -> "2.40.0".
    static func normalize(_ version: String) -> String {
        var v = version.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.lowercased().hasPrefix("v") { v.removeFirst() }
        return v
    }

    /// Porovnání po číselných částech, ne po textu — jinak by "2.10.0"
    /// vyšlo jako starší než "2.9.0", protože znak "1" je menší než "9".
    /// Různě dlouhé verze se doplní nulami ("2.4" == "2.4.0").
    static func isVersion(_ candidate: String, newerThan current: String) -> Bool {
        let a = numericComponents(candidate)
        let b = numericComponents(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    private static func numericComponents(_ version: String) -> [Int] {
        // Bere jen vedoucí číslice každé části, takže "1.2.0-beta3" -> [1, 2, 0].
        normalize(version).split(separator: ".").map { part in
            Int(part.prefix { $0.isNumber }) ?? 0
        }
    }

    // MARK: - Spuštění instalace

    /// URL, kterou rozumí SideStore i AltStore: schéma://install?url=<odkaz na .ipa>
    static func installURL(scheme: String, ipaURL: URL) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "install"
        components.queryItems = [URLQueryItem(name: "url", value: ipaURL.absoluteString)]
        return components.url
    }

    /// Otevře SideStore (nebo AltStore) s odkazem na .ipa. Když ani jeden
    /// nereaguje, otevře stránku releasu v prohlížeči, ať uživatel neskončí
    /// u tlačítka, které nic neudělá.
    ///
    /// `canOpenURL` u cizích schémat funguje jen tehdy, když jsou uvedená
    /// v LSApplicationQueriesSchemes v Info.plist — jinak vrací false i pro
    /// nainstalovanou appku a fallback by se spouštěl vždycky.
    static func startInstall(_ release: Release) {
        let app = UIApplication.shared

        if let ipaURL = release.ipaURL {
            for scheme in ["sidestore", "altstore"] {
                if let url = installURL(scheme: scheme, ipaURL: ipaURL), app.canOpenURL(url) {
                    app.open(url, options: [:], completionHandler: nil)
                    return
                }
            }
        }

        app.open(release.pageURL, options: [:], completionHandler: nil)
    }

    // MARK: - Kompletní kontrola i s dialogem

    /// Zkontroluje aktualizaci a případně nabídne instalaci.
    /// - Parameter force: true = ignoruje šestihodinový odstup (pro tlačítko
    ///   „zkontrolovat aktualizace" a pro hlášení chyb, které se jinak mlčí).
    static func checkAndPrompt(force: Bool = false) {
        if !force && !shouldCheckNow() { return }
        markChecked()

        fetchLatestRelease { result in
            switch result {
            case .failure(let error):
                // Při automatické kontrole se mlčí: uživatel o ni nepožádal a
                // dialog „nepodařilo se zjistit aktualizace" po startu je jen otrava.
                if force { presentAlert(title: "Kontrola se nepovedla",
                                        message: error.localizedDescription) }

            case .success(let release):
                guard isVersion(release.version, newerThan: currentVersion) else {
                    if force { presentAlert(title: "Máš nejnovější verzi",
                                            message: "Běží ti \(currentVersion).") }
                    return
                }
                presentUpdatePrompt(for: release)
            }
        }
    }

    private static func presentUpdatePrompt(for release: Release) {
        let alert = UIAlertController(
            title: "K dispozici je nová verze (\(release.version))",
            message: release.ipaURL == nil
                ? "Release nemá přiloženou .ipa, otevřu ti stránku na GitHubu."
                : "Teď máš \(currentVersion). Aktualizace se otevře v SideStore.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Aktualizovat", style: .default) { _ in
            startInstall(release)
        })
        alert.addAction(UIAlertAction(title: "Později", style: .cancel))
        present(alert)
    }

    private static func presentAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert)
    }

    /// Hledá nejvýš položený view controller, aby se dialog neztratil pod
    /// Capacitorovým webview nebo pod už otevřeným modálem.
    private static func present(_ viewController: UIViewController) {
        guard let root = keyWindow()?.rootViewController else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        top.present(viewController, animated: true)
    }

    private static func keyWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
    }

    // MARK: - Omezení frekvence

    private static func shouldCheckNow() -> Bool {
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        guard last > 0 else { return true }
        return Date().timeIntervalSince1970 - last >= checkInterval
    }

    private static func markChecked() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastCheckKey)
    }

    /// URLSession volá zpátky na vlastním vlákně, ale volající sahá na UI.
    private static func finish(_ result: Result<Release, Error>,
                               _ completion: @escaping (Result<Release, Error>) -> Void) {
        DispatchQueue.main.async { completion(result) }
    }
}
