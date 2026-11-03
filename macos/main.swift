import AppKit

let application = NSApplication.shared
let applyDeskDelegate = ApplyDeskMenuBar()
application.delegate = applyDeskDelegate
application.setActivationPolicy(.regular)
application.run()
