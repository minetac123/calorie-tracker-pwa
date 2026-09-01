import ActivityKit
import Foundation

/// Sdílený kontrakt mezi appkou a widget extensionem — soubor je proto
/// zkompilovaný do OBOU targetů. Kdyby se struktura lišila byť jen o jedno
/// pole, ActivityKit by data mezi procesy nedekódoval a Live Activity by
/// zůstala viset na staré hodnotě.
///
/// `@available` je povinné: hlavní appka se pořád staví s minimem iOS 15.0
/// (widget extension má 17.0), ale `ActivityAttributes` existuje až od 16.1 —
/// bez téhle anotace by se app target nezkompiloval.
@available(iOS 16.1, *)
struct WorkoutActivityAttributes: ActivityAttributes {
    /// Měnící se část tréninku. Vše je `Codable`, protože ActivityKit stav
    /// serializuje a posílá do jiného procesu (widget extension).
    public struct ContentState: Codable, Hashable {
        var exerciseName: String
        /// Volitelné — u prvního tréninku daného cviku ještě žádný "minule"
        /// neexistuje a řádek se v UI vynechá.
        var previousLift: String?
        /// Absolutní čas konce pauzy, ne zbývající sekundy: Live Activity si
        /// nesmí tikat vlastní časovač, takže odpočet musí umět dopočítat
        /// systém sám z pevného data.
        var restEndsAt: Date?
        var restTotalSec: Int
        var setsDone: Int
        var setsTarget: Int
    }

    /// Neměnné po dobu celé aktivity — slouží i k párování běžící aktivity
    /// s tréninkem ve webview po restartu appky.
    var sessionId: String
    var sessionTitle: String
}
