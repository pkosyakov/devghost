import SwiftUI
import Core

public struct GhostGauge: View {
    public enum GaugeSize {
        case compact
        case regular
        case large

        var points: CGFloat {
            switch self {
            case .compact: 40
            case .regular: 80
            case .large: 120
            }
        }
    }

    let percent: Double?
    let size: CGFloat

    public init(percent: Double?, size: GaugeSize = .regular) {
        self.percent = percent
        self.size = size.points
    }

    public init(percent: Double?, size: CGFloat) {
        self.percent = percent
        self.size = size
    }

    public var body: some View {
        ZStack {
            Circle()
                .stroke(Color.gray.opacity(0.2), lineWidth: size * 0.1)

            Circle()
                .trim(from: 0, to: trimValue)
                .stroke(
                    GhostUtils.ghostColor(percent: percent).color,
                    style: StrokeStyle(lineWidth: size * 0.1, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut(duration: 0.5), value: trimValue)

            Text(GhostUtils.formatGhostPercent(percent))
                .font(.system(size: size * 0.22, weight: .bold, design: .rounded))
                .foregroundStyle(GhostUtils.ghostColor(percent: percent).color)
        }
        .frame(width: size, height: size)
    }

    private var trimValue: CGFloat {
        guard let percent else { return 0 }
        return min(CGFloat(percent) / 200.0, 1.0)
    }
}
