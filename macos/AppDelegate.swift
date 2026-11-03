import AppKit
import Carbon
import ServiceManagement

/// Apply Desk runs in the background from the menu bar. It watches the
/// active Chrome tab for job listings, scores them against the resume and
/// profile kept on this Mac, and fills applications on ⌃⌥F. The window is
/// the workspace; closing it leaves the app running.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let backend = Backend()
    private let toasts = ToastCenter()
    private var workspace: WorkspaceWindow!
    private var statusItem: NSStatusItem!
    private var fillHotKey: HotKey?
    private var watcherTimer: Timer?
    private var watching = UserDefaults.standard.object(forKey: "watchChrome") as? Bool ?? true
    private var lastTabKey = ""
    private var processedTabs = Set<String>()
    private var pageLoadAttempts: [String: Int] = [:]
    private var lastResult = "No listings yet"
    private var lastJobID: Int?
    private var launchedAtLogin = false
    private var showingHelp = false
    private var remindedAboutResume = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        let event = NSAppleEventManager.shared().currentAppleEvent
        launchedAtLogin = event?.eventID == AEEventID(kAEOpenApplication)
            && event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        workspace = WorkspaceWindow(backend: backend)
        workspace.onAction = { [weak self] action, body in self?.handle(action, body) }
        workspace.onVisibilityChange = { visible in NSApp.setActivationPolicy(visible ? .regular : .accessory) }
        workspace.onDownload = { [weak self] url in
            self?.toasts.show(Toast(title: "Saved to Downloads", detail: url.lastPathComponent, symbol: "arrow.down.doc",
                                    actionTitle: "Show in Finder", action: { NSWorkspace.shared.activateFileViewerSelecting([url]) }))
        }
        backend.onFailure = { [weak self] in self?.serviceFailed() }
        configureMainMenu()
        configureStatusItem()
        fillHotKey = HotKey(keyCode: kVK_ANSI_F, modifiers: controlKey | optionKey) { [weak self] in self?.fillApplication() }
        if fillHotKey?.isRegistered == false {
            toasts.show(Toast(title: "⌃⌥F is taken by another app", detail: "Use Fill Application in Chrome from the Apply Desk menu bar icon instead.",
                              symbol: "keyboard"), for: 10)
        }
        registerLoginItemOnFirstLaunch()
        if launchedAtLogin { NSApp.setActivationPolicy(.accessory) } else { workspace.show() }
        startService()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        workspace.show()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        backend.stop()
    }

    private func startService() {
        backend.start { [weak self] healthy in
            guard let self = self else { return }
            if healthy {
                self.workspace.serviceReady()
                self.setWatching(self.watching)
            } else {
                self.serviceFailed()
            }
        }
    }

    private func serviceFailed() {
        workspace.serviceFailed { [weak self] in self?.startService() }
        if !workspace.isVisible { workspace.show() }
    }

    // MARK: Menus

    private func configureMainMenu() {
        let main = NSMenu()

        let app = NSMenu(title: "Apply Desk")
        app.addItem(item("About Apply Desk", #selector(showAbout)))
        app.addItem(.separator())
        app.addItem(item("Settings…", #selector(openProfile), ","))
        app.addItem(item("Open at Login", #selector(toggleLoginItem)))
        app.addItem(.separator())
        app.addItem(NSMenuItem(title: "Hide Apply Desk", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(hideOthers)
        app.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        app.addItem(.separator())
        app.addItem(item("Quit Apply Desk", #selector(quit), "q"))
        app.delegate = self

        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))

        let view = NSMenu(title: "View")
        view.addItem(item("Today", #selector(openToday), "1"))
        view.addItem(item("Resume", #selector(openResume), "2"))
        view.addItem(item("Profile", #selector(openProfile), "3"))
        view.addItem(.separator())
        view.addItem(item("Back", #selector(goBack), "["))
        view.addItem(item("Forward", #selector(goForward), "]"))
        view.addItem(item("Reload", #selector(reloadPage), "r"))
        view.addItem(.separator())
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)

        let assist = NSMenu(title: "Assist")
        populateAssistItems(assist)
        assist.delegate = self

        let window = NSMenu(title: "Window")
        window.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        window.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        window.addItem(.separator())
        window.addItem(item("Apply Desk", #selector(openWorkspace), "0"))
        window.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))

        for menu in [app, edit, view, assist, window] {
            let holder = NSMenuItem()
            holder.submenu = menu
            main.addItem(holder)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = window
    }

    private func populateAssistItems(_ menu: NSMenu) {
        menu.removeAllItems()
        let scan = item("Scan Current Chrome Tab", #selector(scanNow), "j")
        let fill = item("Fill Application in Chrome", #selector(fillApplication), "f")
        fill.keyEquivalentModifierMask = [.control, .option]
        let watch = item("Watch Chrome for Listings", #selector(toggleWatching))
        watch.state = watching ? .on : .off
        for entry in [scan, fill, watch] { menu.addItem(entry) }
    }

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = AppDelegate.statusIcon()
        statusItem.button?.toolTip = "Apply Desk"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        rebuildStatusMenu(menu)
    }

    private func rebuildStatusMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        let heading = NSMenuItem(title: watching ? "Watching Chrome for listings" : "Watching paused", action: nil, keyEquivalent: "")
        heading.isEnabled = false
        menu.addItem(heading)
        let last = item(lastResult, lastJobID == nil ? nil : #selector(openLastJob))
        last.isEnabled = lastJobID != nil
        menu.addItem(last)
        menu.addItem(.separator())
        menu.addItem(item("Open Apply Desk", #selector(openWorkspace), "o"))
        let assist = NSMenu()
        populateAssistItems(assist)
        for entry in assist.items { assist.removeItem(entry); menu.addItem(entry) }
        menu.addItem(.separator())
        menu.addItem(item("Open at Login", #selector(toggleLoginItem)))
        menu.addItem(item("Quit Apply Desk", #selector(quit), "q"))
        refreshLoginState(in: menu)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === statusItem.menu { rebuildStatusMenu(menu) }
        else if menu.title == "Assist" { populateAssistItems(menu) }
        else { refreshLoginState(in: menu) }
    }

    private func refreshLoginState(in menu: NSMenu) {
        menu.items.first { $0.action == #selector(toggleLoginItem) }?.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func item(_ title: String, _ action: Selector?, _ key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        return entry
    }

    /// A template orb-and-orbit glyph that follows the menu bar's appearance.
    private static func statusIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.set()
            let orbit = NSBezierPath()
            orbit.appendArc(withCenter: NSPoint(x: 9, y: 9), radius: 7, startAngle: 62, endAngle: 388)
            orbit.lineWidth = 1.5
            orbit.lineCapStyle = .round
            orbit.stroke()
            NSBezierPath(ovalIn: NSRect(x: 5.75, y: 5.75, width: 6.5, height: 6.5)).fill()
            NSBezierPath(ovalIn: NSRect(x: 12.4, y: 12.4, width: 4, height: 4)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    // MARK: Actions

    @objc private func openWorkspace() { workspace.show() }
    @objc private func openToday() { workspace.show(path: "") }
    @objc private func openResume() { workspace.show(path: "resume") }
    @objc private func openProfile() { workspace.show(path: "profile") }
    @objc private func goBack() { workspace.goBack() }
    @objc private func goForward() { workspace.goForward() }
    @objc private func reloadPage() { workspace.reload() }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func openLastJob() {
        if let id = lastJobID { workspace.show(path: "job/\(id)") }
    }

    @objc private func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: "Your resume, profile, and saved roles stay on this Mac.",
                                         attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]),
        ])
    }

    @objc private func toggleLoginItem() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Open at Login"
            alert.informativeText = "\(error.localizedDescription)\n\nYou can also add Apply Desk in System Settings → General → Login Items."
            alert.runModal()
        }
    }

    private func registerLoginItemOnFirstLaunch() {
        // Apply Desk is meant to run in the background, so it opens at login
        // by default. The menu item turns this off.
        guard !UserDefaults.standard.bool(forKey: "loginItemConfigured") else { return }
        UserDefaults.standard.set(true, forKey: "loginItemConfigured")
        try? SMAppService.mainApp.register()
    }

    private func handle(_ action: String, _ body: [String: Any]) {
        switch action {
        case "toggleWatcher": toggleWatching()
        case "scanNow": scanNow()
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(body["text"] as? String ?? "", forType: .string)
        default: break
        }
    }

    // MARK: Watching Chrome

    @objc private func toggleWatching() {
        setWatching(!watching)
    }

    private func setWatching(_ enabled: Bool) {
        watching = enabled
        UserDefaults.standard.set(enabled, forKey: "watchChrome")
        watcherTimer?.invalidate()
        watcherTimer = nil
        if enabled {
            lastTabKey = ""
            watcherTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
                DispatchQueue.main.async { self?.scanActiveTab(manual: false) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.scanActiveTab(manual: false) }
        }
        pushState()
    }

    private func pushState() {
        workspace.pushState(["watching": watching, "lastResult": lastResult == "No listings yet" ? "" : lastResult])
    }

    @objc private func scanNow() {
        scanActiveTab(manual: true)
    }

    private func scanActiveTab(manual: Bool) {
        guard watching || manual else { return }
        guard Chrome.isRunning else {
            if manual { toasts.show(Toast(title: "Chrome isn't open", detail: "Open a job listing in Google Chrome, then scan again.", symbol: "globe")) }
            return
        }
        guard let tab = Chrome.activeTab() else {
            if Chrome.lastFailure != nil { chromeNeedsPermission(manual: manual) }
            else if manual { toasts.show(Toast(title: "No Chrome tab to scan", detail: "Open a job listing in Chrome, then scan again.", symbol: "globe")) }
            return
        }
        let url = tab.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = url + "\n" + tab.title
        guard !url.isEmpty, manual || key != lastTabKey, manual || JobListing.isLikelyURL(url) else { return }
        lastTabKey = key
        guard manual || !processedTabs.contains(key) else { return }
        guard let page = Chrome.readPage() else {
            chromeNeedsPermission(manual: manual)
            return
        }
        let text = String(page.description.prefix(50_000)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 300, JobListing.looksLikePosting(text) else {
            if manual {
                toasts.show(Toast(title: "This tab doesn't look like a job listing", detail: "Open the full job description, then scan again.", symbol: "doc.text.magnifyingglass"))
            } else {
                // Listings often render after the URL changes; look again a few times.
                let attempts = (pageLoadAttempts[key] ?? 0) + 1
                pageLoadAttempts[key] = attempts
                if attempts < 4 { lastTabKey = "" }
            }
            return
        }
        pageLoadAttempts.removeValue(forKey: key)
        processedTabs.insert(key)
        evaluate(page, url: url)
    }

    private func evaluate(_ page: Chrome.Page, url: String) {
        let payload: [String: Any] = ["url": url, "title": String(page.roleTitle.prefix(200)),
                                      "company": String(page.company.prefix(200)), "description": String(page.description.prefix(50_000))]
        backend.send("api/evaluate", json: payload) { [weak self] result in
            guard let self = self else { return }
            guard let result = result, let jobID = result["saved_job_id"] as? Int else {
                self.lastResult = "Couldn't reach the local service"
                self.pushState()
                return
            }
            let score = result["fit_score"] as? Int ?? 0
            let resumeLoaded = result["resume_loaded"] as? Bool ?? false
            let title = (result["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled role"
            let company = result["company"] as? String ?? ""
            self.lastJobID = jobID
            self.lastResult = resumeLoaded ? "\(score) fit · \(title.prefix(40))" : "Resume needed · \(title.prefix(36))"
            self.pushState()
            if self.workspace.isVisible { self.workspace.reload() }
            if !resumeLoaded {
                guard !self.remindedAboutResume else { return }
                self.remindedAboutResume = true
                self.toasts.show(Toast(title: "Add your resume to score listings", detail: "Apply Desk saved \(title). Add a resume to see how well it fits.",
                                       symbol: "doc.badge.plus", actionTitle: "Add Resume", action: { [weak self] in self?.workspace.show(path: "resume") }))
            } else if score >= 60 {
                self.toasts.show(Toast(title: title, detail: "\(company.isEmpty ? "Strong match" : company) · \(result["fit_status"] as? String ?? "")",
                                       score: score, actionTitle: "Review Match", action: { [weak self] in self?.workspace.show(path: "job/\(jobID)") }))
            }
        }
    }

    private func chromeNeedsPermission(manual: Bool) {
        if !manual {
            // Stop polling so a missing permission doesn't nag every few seconds.
            setWatching(false)
            toasts.show(Toast(title: "Chrome needs one setting", detail: "Apply Desk paused watching until it can read job listings in Chrome.",
                              symbol: "exclamationmark.shield", actionTitle: "Show Me How", action: { [weak self] in self?.showChromeHelp() }), for: 12)
        } else {
            showChromeHelp()
        }
    }

    private func showChromeHelp() {
        guard !showingHelp else { return }
        showingHelp = true
        defer { showingHelp = false }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Let Apply Desk read the job listing in Chrome"
        if Chrome.lastFailure == .notAuthorized {
            alert.informativeText = "macOS blocked Apply Desk from controlling Chrome. Open System Settings → Privacy & Security → Automation, allow Apply Desk to control Google Chrome, then turn watching back on."
            alert.addButton(withTitle: "Open Automation Settings")
            alert.addButton(withTitle: "Not Now")
            if alert.runModal() == .alertFirstButtonReturn,
               let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                NSWorkspace.shared.open(url)
            }
        } else {
            alert.informativeText = "In Chrome, choose View → Developer → Allow JavaScript from Apple Events. Then turn watching back on from the Apply Desk menu bar icon. Apply Desk reads the front tab on this Mac only."
            alert.addButton(withTitle: "Turn Watching On")
            alert.addButton(withTitle: "Not Now")
            if alert.runModal() == .alertFirstButtonReturn { setWatching(true) }
        }
    }

    // MARK: Autofill

    @objc private func fillApplication() {
        guard Chrome.isRunning else {
            toasts.show(Toast(title: "Open an application in Chrome", detail: "Press ⌃⌥F on an application form in Chrome's front tab.", symbol: "globe"))
            return
        }
        guard confirmFirstFill() else { return }
        backend.send("api/profile") { [weak self] profile in
            guard let self = self else { return }
            let values = (profile ?? [:]).compactMapValues { $0 as? String }
            guard values.values.contains(where: { !$0.isEmpty }) else {
                self.toasts.show(Toast(title: "Add your details first", detail: "Apply Desk fills applications from your profile.",
                                       symbol: "person.text.rectangle", actionTitle: "Open Profile", action: { [weak self] in self?.workspace.show(path: "profile") }))
                return
            }
            guard let result = Autofill.parse(Chrome.runJavaScript(Autofill.script(profile: values))) else {
                if Chrome.lastFailure != nil { self.showChromeHelp() }
                else { self.toasts.show(Toast(title: "Couldn't read this form", detail: "This page may block autofill. Enter the remaining details yourself.", symbol: "exclamationmark.triangle")) }
                return
            }
            if result.count > 0 {
                self.toasts.show(Toast(title: "Filled \(result.count) field\(result.count == 1 ? "" : "s")",
                                       detail: "Highlighted in green. Review every value, answer the rest, and submit it yourself.", symbol: "checkmark"))
            } else if let form = result.embeddedForm {
                self.toasts.show(Toast(title: "This form is embedded", detail: "Open it on its own page, then press ⌃⌥F again.", symbol: "rectangle.on.rectangle",
                                       actionTitle: "Open Form", action: { Chrome.open(form) }), for: 12)
            } else {
                self.toasts.show(Toast(title: "No empty fields to fill", detail: "Apply Desk skips filled fields and questions that need your judgment.", symbol: "checkmark.circle"))
            }
        }
    }

    private func confirmFirstFill() -> Bool {
        guard !UserDefaults.standard.bool(forKey: "skipFillConfirmation") else { return true }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Fill this application with your details?"
        alert.informativeText = "Apply Desk types your saved contact, education, and link details into empty, clearly labeled fields in Chrome's front tab. It skips sponsorship, demographic, and screening questions and never submits. Review everything before you apply."
        alert.addButton(withTitle: "Fill Fields")
        alert.addButton(withTitle: "Cancel")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        let confirmed = alert.runModal() == .alertFirstButtonReturn
        if confirmed && alert.suppressionButton?.state == .on {
            UserDefaults.standard.set(true, forKey: "skipFillConfirmation")
        }
        Chrome.activate()
        return confirmed
    }
}
