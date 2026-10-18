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

    private let fitGreen = Color(red: 0.42, green: 0.86, blue: 0.35)

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            // 1. ŘÁDEK: Název cviku a počet sérií
            HStack(alignment: .center) {
                Text(state.exerciseName)
                    .font(.system(.headline, design: .rounded, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                Spacer(minLength: 8)

                Text("\(state.setsDone)/\(state.setsTarget) sérií")
                    .font(.system(.caption, design: .rounded, weight: .bold))
                    .foregroundStyle(fitGreen)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(fitGreen.opacity(0.18), in: Capsule())
            }

            // 2. ŘÁDEK: Kolik naložit / zvednout na další sérii + Minule
            if let nextLift = state.nextLift, !nextLift.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Image(systemName: "target")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(fitGreen)

                        Text(state.restEndsAt != nil ? "Naložit:" : "Další série:")
                            .font(.system(size: 12.5, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.68))

                        Text(nextLift)
                            .font(.system(.title3, design: .rounded, weight: .black))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                    if let previousLift = state.previousLift, !previousLift.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "clock.arrow.circlepath")
                                .font(.system(size: 10))
                            Text("Minule: \(previousLift)")
                                .font(.system(size: 11, weight: .regular))
                        }
                        .foregroundStyle(.white.opacity(0.5))
                        .padding(.leading, 4)
                    }
                }
            } else if let previousLift = state.previousLift, !previousLift.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 11))
                    Text("Minule: \(previousLift)")
                        .font(.system(size: 12, weight: .regular))
                }
                .foregroundStyle(.white.opacity(0.6))
                .padding(.leading, 2)
            }

            // 3. ŘÁDEK: Rest timer nebo Čas na sérii
            if let endsAt = state.restEndsAt {
                restRunningView(endsAt: endsAt)
            } else {
                idleView
            }

            // 4. ŘÁDEK: Progress sérií
            ProgressView(value: setsProgress)
                .progressViewStyle(.linear)
                .tint(fitGreen)
        }
        .padding(14)
    }

    @ViewBuilder
    private func restRunningView(endsAt: Date) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: -2) {
                Text("PAUZA")
                    .font(.system(size: 9.5, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white.opacity(0.55))
                    .kerning(1.2)

                // Obří, snadno čitelný časovač pauzy
                Text(timerInterval: timerRange(endsAt: endsAt), countsDown: true)
                    .font(.system(size: 38, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(fitGreen)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }

            Spacer(minLength: 8)

            if #available(iOS 17.0, *) {
                Button(intent: SkipRestIntent()) {
                    HStack(spacing: 5) {
                        Image(systemName: "forward.end.fill")
                            .font(.system(size: 11, weight: .bold))
                        Text("Přeskočit")
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .background(Color.white.opacity(0.14), in: Capsule())
                .foregroundStyle(.white)
            }
        }
    }

    private var idleView: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "figure.strengthtraining.traditional")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(fitGreen)

            VStack(alignment: .leading, spacing: 1) {
                Text(state.setsDone >= state.setsTarget ? "CVIK DOKONČEN" : "ČAS NA SÉRII")
                    .font(.system(size: 12.5, weight: .heavy, design: .rounded))
                    .foregroundStyle(fitGreen)
                    .kerning(0.8)

                Text(state.setsDone >= state.setsTarget ? "Skvělá práce, přejdi na další cvik." : "Odpočiň si nebo jdi zvedat.")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.65))
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
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
