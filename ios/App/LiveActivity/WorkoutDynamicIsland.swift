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

    private static let fitGreen = Color(red: 0.42, green: 0.86, blue: 0.35)

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
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .foregroundStyle(fitGreen)
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
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(fitGreen)
        }
        .padding(.trailing, 4)
    }

    @ViewBuilder
    static func expandedCenter(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        VStack(spacing: 2) {
            Text(context.state.exerciseName)
                .font(.caption)
                .fontWeight(.bold)
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            if let nextLift = context.state.nextLift, !nextLift.isEmpty {
                HStack(spacing: 3) {
                    Image(systemName: "target")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(fitGreen)
                    Text(nextLift)
                        .font(.system(size: 12.5, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
            } else {
                Text(context.attributes.sessionTitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .multilineTextAlignment(.center)
    }

    @ViewBuilder
    static func expandedBottom(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        HStack(spacing: 8) {
            if let previous = context.state.previousLift, !previous.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "clock.arrow.circlepath")
                    Text("Minule: \(previous)")
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            } else if restRange(context) == nil {
                Text("Čas na sérii")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(fitGreen)
            }

            Spacer(minLength: 4)

            if restRange(context) != nil, #available(iOS 17.0, *) {
                Button(intent: SkipRestIntent()) {
                    Text("Přeskočit")
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .background(Color.white.opacity(0.15), in: Capsule())
                .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: - Compact

    @ViewBuilder
    static func compactLeading(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        Image(systemName: restRange(context) == nil ? "dumbbell.fill" : "timer")
            .foregroundStyle(fitGreen)
    }

    @ViewBuilder
    static func compactTrailing(
        context: ActivityViewContext<WorkoutActivityAttributes>
    ) -> some View {
        if let range = restRange(context) {
            // Pevná šířka: kompaktní region se jinak při každé změně číslic
            // překresluje na jinou šířku a "dýchá".
            countdown(range)
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundStyle(fitGreen)
                .frame(width: 44)
        } else if let nextLift = context.state.nextLift, !nextLift.isEmpty {
            Text(nextLift.components(separatedBy: " × ").first ?? nextLift)
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
        } else {
            Text("\(context.state.setsDone)/\(context.state.setsTarget)")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
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
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundStyle(fitGreen)
                .frame(width: 36)
        } else {
            Image(systemName: "dumbbell.fill")
                .foregroundStyle(fitGreen)
        }
    }
}
