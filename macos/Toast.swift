import AppKit
import SwiftUI

extension Color {
    static let deskIndigo = Color(red: 0.36, green: 0.33, blue: 0.96)
    static let deskViolet = Color(red: 0.64, green: 0.36, blue: 0.94)
    static let deskCyan = Color(red: 0.07, green: 0.72, blue: 0.86)
    static let deskMint = Color(red: 0.06, green: 0.72, blue: 0.50)
    static let deskAmber = Color(red: 0.94, green: 0.63, blue: 0.13)
}

/// What a floating notification says, and the one action it may offer.
struct Toast {
    var title: String
    var detail: String
    var score: Int? = nil
    var symbol: String = "sparkles"
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
}

/// A card that slides into the top-right corner without taking focus, used
/// for background events such as a strong match or an autofill result.
@MainActor
final class ToastCenter {
    private var panel: NSPanel?
    private var hideWork: DispatchWorkItem?

    func show(_ toast: Toast, for duration: TimeInterval = 8) {
        hideWork?.cancel()
        panel?.orderOut(nil)
        let view = ToastView(toast: toast, dismiss: { [weak self] in self?.hide() },
                             act: { [weak self] in self?.hide(); toast.action?() })
        let hosting = NSHostingView(rootView: view)
        let size = hosting.fittingSize
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless],
                            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = hosting
        let screen = (NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main)?.visibleFrame ?? .zero
        let final = NSRect(x: screen.maxX - size.width + 4, y: screen.maxY - size.height + 10, width: size.width, height: size.height)
        panel.setFrame(final.offsetBy(dx: 0, dy: 14), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.45
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1)
            panel.animator().alphaValue = 1
            panel.animator().setFrame(final, display: true)
        }
        self.panel = panel
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
    }

    func hide() {
        guard let panel = panel else { return }
        self.panel = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.25
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
    }
}

private struct ToastView: View {
    let toast: Toast
    let dismiss: () -> Void
    let act: () -> Void
    @State private var progress: CGFloat = 0
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            badge
            VStack(alignment: .leading, spacing: 3) {
                Text(toast.title).font(.system(size: 13.5, weight: .semibold)).lineLimit(2)
                Text(toast.detail).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineLimit(4)
                if let title = toast.actionTitle {
                    Button(title, action: act)
                        .buttonStyle(.borderedProminent).controlSize(.small).tint(.deskIndigo).padding(.top, 7)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(width: 344, alignment: .leading)
        .background(VisualEffect().clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous)))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
        .overlay(alignment: .topTrailing) {
            if hovering {
                Button(action: dismiss) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                        .frame(width: 20, height: 20).background(Circle().fill(Color.primary.opacity(0.08)))
                }
                .buttonStyle(.plain).padding(8)
            }
        }
        .shadow(color: .black.opacity(0.22), radius: 22, y: 10)
        .padding(EdgeInsets(top: 16, leading: 26, bottom: 30, trailing: 20))
        .onHover { hovering = $0 }
        .onAppear { withAnimation(.easeOut(duration: 1.3).delay(0.2)) { progress = 1 } }
    }

    @ViewBuilder private var badge: some View {
        if let score = toast.score {
            let colors: [Color] = score >= 60 ? [.deskMint, .deskCyan, .deskMint] : score >= 40 ? [.deskAmber, .orange, .deskAmber] : [.gray, .gray]
            ZStack {
                Circle().stroke(Color.primary.opacity(0.09), lineWidth: 5)
                Circle().trim(from: 0, to: progress * CGFloat(score) / 100)
                    .stroke(AngularGradient(colors: colors, center: .center), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(score)").font(.system(size: 15, weight: .bold, design: .rounded))
            }
            .frame(width: 46, height: 46)
        } else {
            ZStack {
                Circle().fill(LinearGradient(colors: [.deskIndigo, .deskViolet, .deskCyan], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: toast.symbol).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
            }
            .frame(width: 40, height: 40)
            .scaleEffect(0.6 + 0.4 * progress)
        }
    }
}

/// Native behind-window blur for floating panels.
struct VisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

/// The Apply Desk orb: a glowing core with a precessing orbit and satellite.
struct OrbView: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            GeometryReader { geometry in
                let size = min(geometry.size.width, geometry.size.height)
                let orbit = t.truncatingRemainder(dividingBy: 14) / 14 * 360
                let angle = t.truncatingRemainder(dividingBy: 3.6) / 3.6 * 2 * .pi
                ZStack {
                    Circle()
                        .fill(RadialGradient(colors: [Color.deskCyan.opacity(0.35), .clear], center: .center, startRadius: 0, endRadius: size * 0.5))
                        .scaleEffect(1 + 0.06 * sin(t * 1.7))
                    Circle()
                        .fill(RadialGradient(colors: [.white, .deskCyan, .deskIndigo, .deskViolet], center: UnitPoint(x: 0.35, y: 0.3),
                                             startRadius: 0, endRadius: size * 0.22))
                        .frame(width: size * 0.36, height: size * 0.36)
                        .shadow(color: Color.deskIndigo.opacity(0.55), radius: size * 0.1)
                    ZStack {
                        Ellipse().stroke(Color.deskIndigo.opacity(0.6), lineWidth: 1.5)
                        Circle().fill(Color.deskMint).frame(width: size * 0.08, height: size * 0.08)
                            .shadow(color: .deskMint, radius: 4)
                            .offset(x: cos(angle) * size * 0.42, y: sin(angle) * size * 0.15)
                    }
                    .frame(width: size * 0.84, height: size * 0.3)
                    .rotationEffect(.degrees(orbit))
                    Ellipse().stroke(Color.deskCyan.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [2, 4]))
                        .frame(width: size * 0.78, height: size * 0.22)
                        .rotationEffect(.degrees(-orbit * 0.6))
                }
                .frame(width: size, height: size)
            }
        }
    }
}
