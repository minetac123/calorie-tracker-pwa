import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// KONTRAKT S `WorkoutDynamicIsland.swift`:
/// Dynamic Island se tady jen skládá — jednotlivé regiony dodává druhý soubor
/// jako statické view buildery, aby se na obou částech dalo pracovat nezávisle.
/// Očekávané signatury (každá vrací `some View`):
///   WorkoutDynamicIsland.expandedLeading(context:)
///   WorkoutDynamicIsland.expandedTrailing(context:)
///   WorkoutDynamicIsland.expandedCenter(context:)
///   WorkoutDynamicIsland.expandedBottom(context:)
///   WorkoutDynamicIsland.compactLeading(context:)
///   WorkoutDynamicIsland.compactTrailing(context:)
///   WorkoutDynamicIsland.minimal(context:)
/// kde `context` je `ActivityViewContext<WorkoutActivityAttributes>`.

@main
struct FitAIWidgets: WidgetBundle {
    var body: some Widget {
        WorkoutLiveActivity()
    }
}

struct WorkoutLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkoutActivityAttributes.self) { context in
            WorkoutLockScreenView(context: context)
                // Pozadí musí mít i lock screen varianta, jinak systém prosvítá
                // světlou podložkou a černý fitness motiv se rozbije.
                .activityBackgroundTint(Color.black)
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    WorkoutDynamicIsland.expandedLeading(context: context)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    WorkoutDynamicIsland.expandedTrailing(context: context)
                }
                DynamicIslandExpandedRegion(.center) {
                    WorkoutDynamicIsland.expandedCenter(context: context)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    WorkoutDynamicIsland.expandedBottom(context: context)
                }
            } compactLeading: {
                WorkoutDynamicIsland.compactLeading(context: context)
            } compactTrailing: {
                WorkoutDynamicIsland.compactTrailing(context: context)
            } minimal: {
                WorkoutDynamicIsland.minimal(context: context)
            }
            .keylineTint(Color(red: 0.42, green: 0.86, blue: 0.35))
        }
    }
}

struct WorkoutLockScreenView: View {
    let context: ActivityViewContext<WorkoutActivityAttributes>

    private var state: WorkoutActivityAttributes.ContentState { context.state }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(state.exerciseName)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(state.setsDone)/\(state.setsTarget) sérií")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.6))
            }

            // Řádek "minule" se schová celý, když historie chybí — prázdný
            // placeholder by na lock screenu jen zabíral místo.
            if let previousLift = state.previousLift, !previousLift.isEmpty {
                Text(previousLift)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1)
            }

            if let endsAt = state.restEndsAt {
                restRunningView(endsAt: endsAt)
            } else {
                idleView
            }

            ProgressView(value: setsProgress)
                .tint(Color(red: 0.42, green: 0.86, blue: 0.35))
        }
        .padding(14)
    }

    @ViewBuilder
    private func restRunningView(endsAt: Date) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Pauza")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.55))
                // Odpočet kreslí systém sám z rozsahu dat; Live Activity nesmí
                // mít vlastní timer a push update každou sekundu není možný.
                Text(timerInterval: timerRange(endsAt: endsAt), countsDown: true)
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if #available(iOS 17.0, *) {
                Button(intent: SkipRestIntent()) {
                    Text("Přeskočit")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .background(Color.white.opacity(0.14), in: Capsule())
                .foregroundStyle(.white)
            }
        }
    }

    private var idleView: some View {
        HStack(spacing: 8) {
            Image(systemName: "figure.strengthtraining.traditional")
                .foregroundStyle(Color(red: 0.42, green: 0.86, blue: 0.35))
            Text(state.setsDone >= state.setsTarget ? "Cvik hotový" : "Čas na sérii")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
            Spacer(minLength: 0)
        }
    }

    /// `Text(timerInterval:)` spadne na prázdném/obráceném rozsahu, což se stane
    /// pokaždé, když se view překreslí až po vypršení pauzy.
    private func timerRange(endsAt: Date) -> ClosedRange<Date> {
        let now = Date()
        let start = min(now, endsAt)
        let end = max(endsAt, start)
        return start...end
    }

    private var setsProgress: Double {
        guard state.setsTarget > 0 else { return 0 }
        return min(1, Double(state.setsDone) / Double(state.setsTarget))
    }
}
