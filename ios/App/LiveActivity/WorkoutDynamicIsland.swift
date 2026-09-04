import ActivityKit
import SwiftUI
import WidgetKit

/// Prezentace Live Activity v Dynamic Islandu.
///
/// Vyčleněno z `WorkoutLiveActivity` jako enum bez instancí — `DynamicIsland`
/// builder se tím drží čitelný a jednotlivé regiony jdou upravovat odděleně.
///
/// Napříč všemi variantami platí dvě pravidla:
/// 1. Odpočet vždy přes `Text(timerInterval:countsDown:)`. Extension se probouzí
///    jen při update stavu, takže předpočítaný string by na displeji zamrznul —
///    tenhle `Text` si systém dotikává sám, bez push updatů.
/// 2. `restEndsAt == nil` (a stejně tak už prošlý čas) znamená, že pauza neběží.
///    Místo prázdného časovače se ukazuje název cviku, resp. pomlčka.
@available(iOS 17.0, *)
enum WorkoutDynamicIsland {

    // MARK: - Sdílené pomocné kusy

    /// Rozsah pro odpočet, nebo `nil` když pauza neběží.
    ///
    /// Horní mez musí být v budoucnosti — `Date()...end` s prošlým `end` je
    /// neplatný `ClosedRange` a shodilo by to widget.
    private static func restRange(
        _ context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> ClosedRange<Date>? {
        guard let end = context.state.restEndsAt, end > Date() else { return nil }
        return Date()...end
    }

    /// Monospaced číslice, aby text při odpočtu neposkakoval do stran.
    private static func countdown(_ range: ClosedRange<Date>) -> some View {
        Text(timerInterval: range, countsDown: true)
            .monospacedDigit()
            .lineLimit(1)
    }

    // MARK: - Expanded

    @ViewBuilder
    static func expandedLeading(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Pauza", systemImage: "timer")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)

            if let range = restRange(context) {
                countdown(range)
                    .font(.system(size: 26, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(maxWidth: 90, alignment: .leading)
            } else {
                Text("—")
                    .font(.system(size: 26, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, 4)
    }

    @ViewBuilder
    static func expandedTrailing(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text("Série")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Text("\(context.state.setsDone)/\(context.state.setsTarget)")
                .font(.system(size: 22, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
        }
        .padding(.trailing, 4)
    }

    @ViewBuilder
    static func expandedCenter(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        VStack(spacing: 1) {
            Text(context.state.exerciseName)
                .font(.caption)
                .fontWeight(.medium)
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(context.attributes.sessionTitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .multilineTextAlignment(.center)
    }

    @ViewBuilder
    static func expandedBottom(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        // Spodní region je nepovinný doplněk — když "minule" chybí a pauza
        // neběží, zůstane schválně prázdný, ať Island nezabírá zbytečnou výšku.
        // Prázdný řetězec se musí chovat jako chybějící historie, jinak by se
        // ukázalo holé "Minule: " bez hodnoty (plugin sice prázdné hodnoty
        // převádí na nil, ale widget na to nemá spoléhat).
        if let previous = context.state.previousLift, !previous.isEmpty {
            HStack(spacing: 4) {
                Image(systemName: "clock.arrow.circlepath")
                Text("Minule: \(previous)")
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
        } else if restRange(context) == nil {
            Text("Pauza neběží")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }

    // MARK: - Compact

    @ViewBuilder
    static func compactLeading(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        Image(systemName: restRange(context) == nil ? "dumbbell.fill" : "timer")
            .foregroundStyle(.white)
    }

    @ViewBuilder
    static func compactTrailing(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        if let range = restRange(context) {
            // Pevná šířka: kompaktní region se jinak při každé změně číslic
            // překresluje na jinou šířku a "dýchá".
            countdown(range)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: 44)
        } else {
            Text("\(context.state.setsDone)/\(context.state.setsTarget)")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Minimal

    @ViewBuilder
    static func minimal(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        if let range = restRange(context) {
            countdown(range)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: 36)
        } else {
            Image(systemName: "dumbbell.fill")
                .foregroundStyle(.white)
        }
    }
}
