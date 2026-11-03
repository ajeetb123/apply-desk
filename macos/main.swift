import AppKit

let application = NSApplication.shared
let applyDeskDelegate = MainActor.assumeIsolated { AppDelegate() }
application.delegate = applyDeskDelegate
application.setActivationPolicy(.regular)
application.run()
