import AppKit

// Renders the Apply Desk app icon — a glowing orb with an orbiting satellite
// on a deep indigo squircle — as a 1024 px PNG. Used by Build Apply Desk App.command.
// Usage: make_icon <output.png>

let output = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png")
let side = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let context = NSGraphicsContext.current!.cgContext
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r, green: g, blue: b, alpha: a)
}

func radial(_ colors: [CGColor], _ locations: [CGFloat], center: CGPoint, radius: CGFloat) {
    let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: locations)!
    context.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
}

// Squircle body on Apple's 1024 grid (824 px tile, 100 px margin).
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -14), blur: 34, color: color(0.05, 0.03, 0.2, 0.45))
context.addPath(shape)
context.setFillColor(color(0.1, 0.08, 0.3))
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(shape)
context.clip()
let base = CGGradient(colorsSpace: space, colors: [color(0.07, 0.05, 0.22), color(0.2, 0.15, 0.55), color(0.38, 0.33, 0.95)] as CFArray,
                      locations: [0, 0.55, 1])!
context.drawLinearGradient(base, start: CGPoint(x: 160, y: 100), end: CGPoint(x: 860, y: 924), options: [])
radial([color(0.07, 0.72, 0.86, 0.55), color(0.07, 0.72, 0.86, 0)], [0, 1], center: CGPoint(x: 820, y: 860), radius: 420)
radial([color(0.64, 0.36, 0.94, 0.5), color(0.64, 0.36, 0.94, 0)], [0, 1], center: CGPoint(x: 180, y: 200), radius: 460)

// A few stars.
let stars: [(CGFloat, CGFloat, CGFloat)] = [(230, 760, 5), (300, 300, 3.5), (760, 250, 4), (820, 640, 3), (420, 840, 3), (640, 190, 2.5), (190, 520, 2.5)]
for (x, y, r) in stars {
    context.setFillColor(color(1, 1, 1, 0.75))
    context.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
}

let center = CGPoint(x: 512, y: 512)
func orbitPath(rx: CGFloat, ry: CGFloat, angle: CGFloat) -> CGPath {
    var transform = CGAffineTransform(translationX: center.x, y: center.y).rotated(by: angle)
    return CGPath(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2), transform: &transform)
}
let tilt: CGFloat = -0.38

// Back half of the orbit, then the orb, then the front half over it.
context.setLineCap(.round)
context.addPath(orbitPath(rx: 330, ry: 112, angle: tilt))
context.setStrokeColor(color(0.62, 0.88, 1, 0.35))
context.setLineWidth(16)
context.strokePath()
context.addPath(orbitPath(rx: 300, ry: 82, angle: tilt + 0.5))
context.setStrokeColor(color(0.62, 0.88, 1, 0.18))
context.setLineWidth(7)
context.setLineDash(phase: 0, lengths: [10, 22])
context.strokePath()
context.setLineDash(phase: 0, lengths: [])

radial([color(0.55, 0.85, 1, 0.5), color(0.36, 0.33, 0.96, 0)], [0, 1], center: center, radius: 300)
context.saveGState()
context.addEllipse(in: CGRect(x: center.x - 172, y: center.y - 172, width: 344, height: 344))
context.clip()
radial([color(1, 1, 1), color(0.55, 0.92, 1), color(0.07, 0.72, 0.86), color(0.36, 0.33, 0.96), color(0.5, 0.25, 0.85)],
       [0, 0.12, 0.38, 0.75, 1], center: CGPoint(x: center.x - 60, y: center.y + 70), radius: 300)
context.restoreGState()

context.saveGState()
// Front arc: the lower part of the tilted ellipse passes in front of the orb.
let front = CGAffineTransform(translationX: center.x, y: center.y).rotated(by: tilt)
let arc = CGMutablePath()
arc.addArc(center: .zero, radius: 1, startAngle: .pi * 1.02, endAngle: .pi * 1.98, clockwise: false, transform: CGAffineTransform(scaleX: 330, y: 112).concatenating(front))
context.addPath(arc)
context.setStrokeColor(color(0.78, 0.94, 1, 0.9))
context.setLineWidth(16)
context.strokePath()
context.restoreGState()

// Satellite riding the front of the orbit.
let satelliteAngle: CGFloat = .pi * 1.78
let local = CGPoint(x: cos(satelliteAngle) * 330, y: sin(satelliteAngle) * 112).applying(front)
radial([color(0.3, 1, 0.75, 0.9), color(0.3, 1, 0.75, 0)], [0, 1], center: local, radius: 90)
context.setFillColor(color(0.85, 1, 0.94))
context.fillEllipse(in: CGRect(x: local.x - 34, y: local.y - 34, width: 68, height: 68))

// Soft top gloss.
let gloss = CGGradient(colorsSpace: space, colors: [color(1, 1, 1, 0.16), color(1, 1, 1, 0)] as CFArray, locations: [0, 1])!
context.drawLinearGradient(gloss, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 560), options: [])
context.restoreGState()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: output)
