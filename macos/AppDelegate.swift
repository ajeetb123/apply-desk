import AppKit
import Carbon
import ServiceManagement

/// Apply Desk runs in the background from the menu bar. It watches the
/// active Chrome tab for job listings, scores them against the resume and
/// profile kept on this Mac, and fills applications with the ` key. The
/// window is the workspace; closing it leaves the app running.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let backend = Backend()
    private let toasts = ToastCenter()
    private var workspace: WorkspaceWindow!
    private var statusItem: NSStatusItem!
    private var fillHotKey: HotKey?
    private var monitorTimer: Timer?
    private var watching = UserDefaults.standard.object(forKey: "watchChrome") as? Bool ?? true
    private lazy var resumePDF = ResumePDF(backend: backend)
    // Watching follows only the tab the user is on. A tab is read once it has
    // finished loading, stayed in front briefly, and its text stopped growing.
    private var candidate: (key: String, since: Date)?
    private var pageLengths: [String: Int] = [:]
    private var pageLoadAttempts: [String: Int] = [:]
    private var ignoredTabs = Set<String>()
    private var tabRoles: [String: Int] = [:]          // "tab id|url" → saved role
    private var tabLastRole: [String: Int] = [:]       // tab id → last role seen in it
    private var current: (id: Int, title: String, seen: Date)?
    private var lastResult = "No listings yet"
    private var lastJobID: Int?
    /// What stands between Apply Desk and Chrome right now. Watching stays on
    /// while this is not `.ready`; the sidebar and menu say how to fix it.
    private enum ChromeStatus: String { case ready, notAsked, denied, javaScriptOff, notRunning }
    private var chromeStatus = ChromeStatus.ready
    private var lastAccessCheck = Date.distantPast
    private var lastJavaScriptCheck = Date.distantPast
    private var askedForAccess = false
    private var accessVerified = false
    private var launchedAtLogin = false
    private var showingHelp = false
    private var remindedAboutResume = false
    private var fillStarted: Date?                     // a fill run in progress; pressing ` again stops it after the page

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
        // One key, `, claimed only while a job or application page is in front
        // in Chrome (see tick()); everywhere else it types a backtick as usual.
        fillHotKey = HotKey(keyCode: kVK_ANSI_Grave, modifiers: 0) { [weak self] in self?.fillApplication() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                if !Chrome.isFrontmost { self?.fillHotKey?.isEnabled = false }
                else { self?.tick() }
            }
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
        let fill = item("Fill Application in Chrome (` key)", #selector(fillApplication))
        let watch = item("Watch Chrome for Listings", #selector(toggleWatching))
        watch.state = watching ? .on : .off
        for entry in [scan, fill, watch] { menu.addItem(entry) }
        if chromeStatus != .ready && chromeStatus != .notRunning {
            menu.addItem(item(chromeStatus == .javaScriptOff ? "Fix Chrome Setting…" : "Allow Chrome Access…", #selector(fixChromeAccess)))
        }
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
        let heading = NSMenuItem(title: statusHeadline, action: nil, keyEquivalent: "")
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
        case "savePDF": if let job = body["job"] as? Int { savePDF(jobID: job) }
        case "chromeAccess": fixChromeAccess()
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(body["text"] as? String ?? "", forType: .string)
        default: break
        }
    }

    // MARK: Watching Chrome

    @objc private func toggleWatching() {
        setWatching(!watching, userInitiated: true)
    }

    /// Watching is the user's choice and is never switched off for them; when
    /// Chrome can't be read yet, the status explains why and how to fix it.
    private func setWatching(_ enabled: Bool, userInitiated: Bool = false) {
        watching = enabled
        UserDefaults.standard.set(enabled, forKey: "watchChrome")
        candidate = nil
        if monitorTimer == nil {
            monitorTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
                DispatchQueue.main.async { self?.tick() }
            }
        }
        if enabled {
            // Show the real status right away; ask for access only when the
            // user just turned watching on, never by surprise at launch.
            let access = refreshChromeAccess()
            if userInitiated && access == .notAsked { requestChromeAccess() }
            if userInitiated && access == .denied { askAgainForChromeAccess() }
        }
        pushState()
    }

    /// Reads Automation permission without prompting and updates the status.
    @discardableResult
    private func refreshChromeAccess() -> Chrome.Access {
        guard Chrome.isRunning else {
            setChromeStatus(.notRunning)
            return .notRunning
        }
        lastAccessCheck = Date()
        let access = Chrome.automationAccess(ask: false)
        accessVerified = access == .granted
        switch access {
        case .granted: if chromeStatus != .javaScriptOff { setChromeStatus(.ready) }
        case .denied: setChromeStatus(.denied)
        case .notAsked: setChromeStatus(.notAsked)
        case .notRunning: setChromeStatus(.notRunning)
        }
        return access
    }

    private var statusHeadline: String {
        guard watching else { return "Watching paused" }
        switch chromeStatus {
        case .ready: return "Watching Chrome for listings"
        case .notAsked: return "Chrome access needed"
        case .denied: return "Chrome access is off"
        case .javaScriptOff: return "One Chrome setting left"
        case .notRunning: return "Waiting for Chrome"
        }
    }

    private func pushState() {
        var state: [String: Any] = ["watching": watching, "chrome": chromeStatus.rawValue,
                                    "lastResult": lastResult == "No listings yet" ? "" : lastResult]
        if let current = current { state["current"] = ["id": current.id, "title": current.title] }
        workspace.pushState(state)
    }

    private func setChromeStatus(_ status: ChromeStatus) {
        guard status != chromeStatus else { return }
        chromeStatus = status
        pushState()
        guard watching, Chrome.isFrontmost else { return }
        switch status {
        case .denied:
            toasts.show(Toast(title: "Chrome access is off", detail: "macOS is blocking Apply Desk from reading Chrome. Watching stays on and resumes once access is back.",
                              symbol: "lock.shield", actionTitle: "Ask macOS Again", action: { [weak self] in self?.fixChromeAccess() }), for: 12)
        case .javaScriptOff:
            toasts.show(Toast(title: "One Chrome setting left", detail: "In Chrome: View → Developer → Allow JavaScript from Apple Events. Watching resumes on its own.",
                              symbol: "gearshape", actionTitle: "Show Me", action: { [weak self] in self?.fixChromeAccess() }), for: 12)
        default: break
        }
    }

    private func setCurrent(_ jobID: Int, title: String) {
        let changed = current?.id != jobID
        current = (jobID, title, Date())
        lastJobID = jobID
        if changed { pushState() }
    }

    /// Runs every 1.5 seconds. Cheap unless Chrome is in front: then it reads
    /// the front tab's identity once, decides whether the ` key fills, and
    /// (when watching) scores a listing that has finished loading.
    private func tick() {
        guard Chrome.isRunning else {
            fillHotKey?.isEnabled = false
            if chromeStatus == .ready || chromeStatus == .javaScriptOff { setChromeStatus(.notRunning) }
            return
        }
        guard Chrome.isFrontmost else {
            fillHotKey?.isEnabled = false
            return
        }
        if chromeStatus == .notRunning { setChromeStatus(.ready) }
        if !accessVerified {
            // Check permission without sending Chrome anything, so macOS never
            // blocks this thread with its prompt; re-check every few seconds in
            // case access was granted in System Settings.
            guard Date().timeIntervalSince(lastAccessCheck) > 3 else { return }
            lastAccessCheck = Date()
            switch Chrome.automationAccess(ask: false) {
            case .granted:
                accessVerified = true
                if chromeStatus == .notAsked || chromeStatus == .denied { setChromeStatus(.ready) }
            case .denied: setChromeStatus(.denied); return
            case .notRunning: return
            case .notAsked:
                setChromeStatus(.notAsked)
                if watching && !askedForAccess { requestChromeAccess() }
                return
            }
        }
        guard let tab = Chrome.activeTab() else {
            fillHotKey?.isEnabled = false
            noteChromeFailure()
            return
        }
        fillHotKey?.isEnabled = JobListing.mayHaveApplication(tab.url) || tabLastRole[tab.id] != nil
        if watching { scan(tab, manual: false) }
    }

    /// Classifies a failed Apple Event without ever turning watching off.
    private func noteChromeFailure() {
        switch Chrome.lastFailure {
        case .notAuthorized?:
            accessVerified = false
            lastAccessCheck = Date()
            setChromeStatus(Chrome.automationAccess(ask: false) == .denied ? .denied : .notAsked)
        case .javaScriptOff?:
            lastJavaScriptCheck = Date()
            setChromeStatus(.javaScriptOff)
        default: break
        }
    }

    /// Shows macOS's own "control Google Chrome" prompt. It blocks until
    /// answered, so it runs off the main thread.
    private func requestChromeAccess(then next: (() -> Void)? = nil) {
        askedForAccess = true
        DispatchQueue.global(qos: .userInitiated).async {
            let access = Chrome.automationAccess(ask: true)
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.lastAccessCheck = Date()
                switch access {
                case .granted: self.accessVerified = true; self.setChromeStatus(.ready); next?()
                case .denied: self.setChromeStatus(.denied)
                case .notRunning: self.setChromeStatus(.notRunning)
                case .notAsked: self.setChromeStatus(.notAsked)
                }
            }
        }
    }

    /// The one button for every Chrome problem, from the sidebar or the menu.
    @objc private func fixChromeAccess() {
        guard Chrome.isRunning else {
            toasts.show(Toast(title: "Open Chrome first", detail: "Apply Desk asks for access while Chrome is running.", symbol: "globe"))
            return
        }
        switch Chrome.automationAccess(ask: false) {
        case .granted:
            accessVerified = true
            if chromeStatus == .javaScriptOff || Chrome.lastFailure == .javaScriptOff { showJavaScriptHelp() } else { setChromeStatus(.ready) }
        case .denied:
            askAgainForChromeAccess()
        default:
            requestChromeAccess()
        }
    }

    /// macOS never asks twice. A stale or refused answer is cleared for Apply
    /// Desk alone (`tccutil reset AppleEvents <its bundle id>`), then macOS asks again.
    private func askAgainForChromeAccess() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Let Apply Desk read and fill Chrome tabs?"
        alert.informativeText = "macOS has a saved \"Don't Allow\" for Apply Desk controlling Google Chrome, often left over from an earlier build. Apply Desk can clear that one answer so macOS asks you again. Choose OK when the prompt appears."
        alert.addButton(withTitle: "Ask Again")
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            let reset = Process()
            reset.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
            reset.arguments = ["reset", "AppleEvents", Bundle.main.bundleIdentifier ?? "com.ajeet.applydesk"]
            try? reset.run()
            reset.waitUntilExit()
            requestChromeAccess()
        case .alertSecondButtonReturn:
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") { NSWorkspace.shared.open(url) }
        default: break
        }
    }

    private func showJavaScriptHelp() {
        guard !showingHelp else { return }
        showingHelp = true
        defer { showingHelp = false }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Turn on one Chrome setting"
        alert.informativeText = "In Chrome's menu bar, choose View → Developer → Allow JavaScript from Apple Events, so a check mark appears next to it. Apply Desk picks it up within a few seconds; watching stays on."
        alert.addButton(withTitle: "OK")
        alert.runModal()
        Chrome.activate()
    }

    @objc private func scanNow() {
        guard Chrome.isRunning, let tab = Chrome.activeTab() else {
            if Chrome.isRunning { noteChromeFailure(); fixChromeAccess() }
            else { toasts.show(Toast(title: "Chrome isn't open", detail: "Open a job listing in Google Chrome, then scan again.", symbol: "globe")) }
            return
        }
        scan(tab, manual: true)
    }

    private func scan(_ tab: Chrome.Tab, manual: Bool) {
        let url = tab.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = tab.id + "|" + url
        if let role = tabRoles[key] {
            // Back on a listing that was already scored: it becomes the current role.
            tabLastRole[tab.id] = role
            setCurrent(role, title: current?.id == role ? current!.title : tab.title)
            if !manual { return }
        }
        guard !url.isEmpty, manual || JobListing.isLikelyURL(url) else {
            ignoredTabs.insert(key)
            return
        }
        if !manual {
            guard !ignoredTabs.contains(key), !tab.loading else { return }
            // Flipping through tabs shouldn't trigger reads; wait until one stays put.
            if candidate?.key != key {
                candidate = (key, Date())
                return
            }
            guard Date().timeIntervalSince(candidate!.since) >= 1.2 else { return }
            // While Chrome's JavaScript setting is off, retry every few seconds.
            if chromeStatus == .javaScriptOff && Date().timeIntervalSince(lastJavaScriptCheck) < 4 { return }
        }
        guard let page = Chrome.readPage() else {
            noteChromeFailure()
            if manual { fixChromeAccess() }
            return
        }
        if chromeStatus == .javaScriptOff { setChromeStatus(.ready) }
        let text = String(page.description.prefix(50_000)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard page.ready, text.count >= 300, JobListing.looksLikePosting(text) else {
            if manual {
                toasts.show(Toast(title: "This tab doesn't look like a job listing", detail: "Open the full job description, then scan again.", symbol: "doc.text.magnifyingglass"))
            } else {
                // Many boards render the description after the page loads; keep
                // looking for about ten seconds, then stop.
                let attempts = (pageLoadAttempts[key] ?? 0) + 1
                pageLoadAttempts[key] = attempts
                if attempts >= 7 { ignoredTabs.insert(key) }
            }
            return
        }
        // Wait until the description stops growing so the whole posting is read.
        if !manual && pageLengths[key] != text.count {
            pageLengths[key] = text.count
            return
        }
        pageLoadAttempts.removeValue(forKey: key)
        pageLengths.removeValue(forKey: key)
        ignoredTabs.insert(key)
        evaluate(page, url: url, tabID: tab.id, key: key)
    }

    private func evaluate(_ page: Chrome.Page, url: String, tabID: String, key: String) {
        var payload: [String: Any] = page.signals.mapValues { String($0.prefix(300)) }
        payload["url"] = url
        payload["description"] = String(page.description.prefix(50_000))
        backend.send("api/evaluate", json: payload) { [weak self] result in
            guard let self = self else { return }
            guard let result = result, let jobID = result["saved_job_id"] as? Int else {
                self.ignoredTabs.remove(key)
                self.lastResult = "Couldn't reach the local service"
                self.pushState()
                return
            }
            let score = result["fit_score"] as? Int ?? 0
            let resumeLoaded = result["resume_loaded"] as? Bool ?? false
            let title = (result["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled role"
            let company = result["company"] as? String ?? ""
            self.tabRoles[key] = jobID
            self.tabLastRole[tabID] = jobID
            self.lastResult = resumeLoaded ? "\(score) fit · \(title.prefix(40))" : "Resume needed · \(title.prefix(36))"
            self.setCurrent(jobID, title: title)
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

    // MARK: Autofill and the resume that goes with it

    @objc private func fillApplication() {
        guard Chrome.isRunning, Chrome.isFrontmost || NSApp.isActive else {
            toasts.show(Toast(title: "Switch to the application in Chrome", detail: "Press ` while the application form is the tab in front.", symbol: "globe"))
            return
        }
        switch Chrome.automationAccess(ask: false) {
        case .granted: break
        case .denied: return askAgainForChromeAccess()
        default: return requestChromeAccess { [weak self] in self?.fillApplication() }
        }
        guard confirmFirstFill() else { return }
        guard let tab = Chrome.activeTab() else {
            noteChromeFailure()
            fixChromeAccess()
            return
        }
        if let started = fillStarted, Date().timeIntervalSince(started) < 600 {
            _ = Chrome.runJavaScript(Autofill.stopScript)
            return toasts.show(Toast(title: "Stopping after this page…", detail: "Press ` again later to pick up where it stopped.", symbol: "pause.circle"))
        }
        fillStarted = Date()
        roleForApplication(tab) { [weak self] role in
            guard let self = self else { return }
            self.backend.send("api/fill-plan?job_id=\(role ?? 0)") { [weak self] plan in
                guard let self = self else { return }
                guard let plan = plan, let profile = plan["profile"] as? [String: Any],
                      profile.values.contains(where: { ($0 as? String).map { !$0.isEmpty } ?? false }) else {
                    self.fillStarted = nil
                    return self.toasts.show(Toast(title: "Add your details first", detail: "Apply Desk fills applications from your profile.",
                                                  symbol: "person.text.rectangle", actionTitle: "Open Profile", action: { [weak self] in self?.workspace.show(path: "profile") }))
                }
                let name = (profile["name"] as? String).flatMap { $0.isEmpty ? nil : "\($0) Resume.pdf" } ?? "Resume.pdf"
                guard let role = role else { return self.runFill(plan: plan, tab: tab, role: nil, resume: nil, name: name) }
                self.resumePDF.make(jobID: role) { output in
                    self.runFill(plan: plan, tab: tab, role: role, resume: output, name: name)
                }
            }
        }
    }

    /// Which saved role this application belongs to: the role last scanned in
    /// the same tab, then a URL match, then the role the user viewed last.
    private func roleForApplication(_ tab: Chrome.Tab, completion: @escaping (Int?) -> Void) {
        if let role = tabLastRole[tab.id] { return completion(role) }
        let query = tab.url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))) ?? ""
        backend.send("api/role-for-url?url=\(query)") { [weak self] result in
            if let role = result?["job_id"] as? Int { return completion(role) }
            if let current = self?.current, Date().timeIntervalSince(current.seen) < 2 * 3600 { return completion(current.id) }
            completion(nil)
        }
    }

    private func runFill(plan: [String: Any], tab: Chrome.Tab, role: Int?, resume: ResumePDF.Output?, name: String) {
        guard let planData = try? JSONSerialization.data(withJSONObject: plan),
              let script = Autofill.script(plan: planData, resume: resume.map { (name, $0.pdf) }) else { fillStarted = nil; return }
        guard Chrome.runJavaScript(script) != nil else {
            fillStarted = nil
            if Chrome.lastFailure != nil { noteChromeFailure(); fixChromeAccess() }
            else { toasts.show(Toast(title: "Couldn't read this form", detail: "This page may block autofill. Enter the remaining details yourself.", symbol: "exclamationmark.triangle")) }
            return
        }
        toasts.show(Toast(title: "Filling this application…", detail: "Apply Desk goes page by page and stops at Review. Keep this tab in front; press ` to stop.", symbol: "wand.and.stars"), for: 60)
        waitForFill(FillWatch(script: script)) { [weak self] result in
            self?.finishFill(result, tab: tab, role: role, resume: resume)
        }
    }

    /// A fill run in progress, which can span several pages.
    private struct FillWatch {
        let script: String
        var progress = ""
        var lastChange = Date()
        var missingSince: Date?
        var reloads = 0
        var page = ""
        var last: Autofill.Result?
    }

    /// The filler keeps working after it starts; check on it until it's done.
    /// When a step loads as a whole new page, start the filler again there;
    /// it picks up the same run from the tab's session storage.
    private func waitForFill(_ watch: FillWatch, completion: @escaping (Autofill.Result?) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self = self else { return }
            var watch = watch
            if let result = Autofill.parse(Chrome.runJavaScript(Autofill.statusScript)) {
                if result.done { return completion(result) }
                watch.missingSince = nil
                let progress = "\(result.beat)|\(result.items.count)|\(result.fields.count)"
                if progress != watch.progress { watch.progress = progress; watch.lastChange = Date() }
                if !result.page.isEmpty, result.page != watch.page {
                    watch.page = result.page
                    self.toasts.show(Toast(title: "Filling \(result.page)…", detail: "Apply Desk goes page by page and stops at Review. Press ` to stop.", symbol: "wand.and.stars"), for: 60)
                }
                watch.last = result
            } else if watch.last?.advancing == true, watch.reloads < 12 {
                if Chrome.activeTab()?.loading == false, Chrome.runJavaScript(watch.script) != nil {
                    watch.reloads += 1
                    watch.last = nil
                    watch.lastChange = Date()
                }
            } else {
                watch.missingSince = watch.missingSince ?? Date()
                if Date().timeIntervalSince(watch.missingSince!) > 10 { return completion(watch.last) }
            }
            // Give up only when nothing has moved for a while.
            if Date().timeIntervalSince(watch.lastChange) > 90 { return completion(watch.last) }
            self.waitForFill(watch, completion: completion)
        }
    }

    private func finishFill(_ result: Autofill.Result?, tab: Chrome.Tab, role: Int?, resume: ResumePDF.Output?) {
        fillStarted = nil
        guard let result = result, result.done else {
            return toasts.show(Toast(title: "The form stopped responding", detail: "Some fields may be filled. Check the page and finish it yourself.", symbol: "exclamationmark.triangle"))
        }
        if !result.learned.isEmpty {
            backend.send("api/answers", json: ["answers": result.learned]) { _ in }
        }
        let filled = result.fields.count
        if let role = role, let resume = resume, !result.items.isEmpty || result.attached {
            // Keep the exact resume that went with this application, and the
            // review of every page; later pages of the same run update it.
            backend.send("api/applications", json: ["job_id": role, "url": tab.url, "attached": result.attached, "fields": result.fields,
                                                    "run": result.run, "review": result.items,
                                                    "pages": resume.pages, "pdf": resume.pdf.base64EncodedString()]) { [weak self] _ in
                if self?.workspace.isVisible == true { self?.workspace.reload() }
            }
        }
        let open: () -> Void = { [weak self] in if let role = role { self?.workspace.show(path: "job/\(role)") } }
        let pageName = result.page.isEmpty ? "This page" : result.page
        switch result.stop {
        case "review":
            let total = result.items.count, pages = result.pages.count
            let detail = "Filled \(total) field\(total == 1 ? "" : "s")\(pages > 1 ? " across \(pages) pages" : ""). "
                + (result.checks > 0 ? "\(result.checks) to check in the panel. " : "") + "Submit is yours."
            return toasts.show(Toast(title: "Ready for your review", detail: detail, symbol: "checkmark.seal",
                                     actionTitle: role == nil ? nil : "See What Was Sent", action: open), for: 14)
        case "needs", "errors":
            let shown = result.needs.prefix(3).joined(separator: "; ") + (result.needs.count > 3 ? "…" : "")
            return toasts.show(Toast(title: "\(pageName) needs you", detail: "\(shown). Answer \(result.needs.count == 1 ? "it" : "them"), then press ` to keep going.",
                                     symbol: "hand.raised"), for: 14)
        case "signin":
            return toasts.show(Toast(title: "Sign in first", detail: "Apply Desk never types passwords. Sign in, then press ` on the application's first page.", symbol: "person.badge.key"))
        case "stopped":
            return toasts.show(Toast(title: "Stopped after \(pageName)", detail: "Press ` to pick up from the next page.", symbol: "pause.circle"))
        case "stuck":
            return toasts.show(Toast(title: "The next page didn't load", detail: "Click Continue yourself, then press ` on the new page.", symbol: "exclamationmark.triangle"))
        default:
            break
        }
        if filled > 0 || result.attached {
            let parts = [filled > 0 ? "filled \(filled) field\(filled == 1 ? "" : "s")" : nil,
                         result.blocks > 0 ? "\(result.blocks) experience and education entr\(result.blocks == 1 ? "y" : "ies")" : nil,
                         result.attached ? "attached your tuned resume" : nil].compactMap { $0 }
            let sentence = parts.joined(separator: ", ")
            let detail = result.attached || role == nil ? "Review every value, answer the rest, and submit it yourself."
                : resume == nil ? "Couldn't prepare your tuned resume. Save it from the role page and upload it yourself."
                : "No resume upload on this page. If a later step asks for one, press ` there."
            toasts.show(Toast(title: sentence.prefix(1).uppercased() + sentence.dropFirst(), detail: detail, symbol: "checkmark",
                              actionTitle: role == nil ? nil : "See What Was Sent", action: open), for: 10)
        } else if let form = result.embeddedForm {
            toasts.show(Toast(title: "This form is embedded", detail: "Open it on its own page, then press ` again.", symbol: "rectangle.on.rectangle",
                              actionTitle: "Open Form", action: { Chrome.open(form) }), for: 12)
        } else if !result.learned.isEmpty {
            toasts.show(Toast(title: "Remembered your answers", detail: "Apply Desk saved \(result.learned.count) answer\(result.learned.count == 1 ? "" : "s") from this page to reuse next time.", symbol: "brain"))
        } else {
            toasts.show(Toast(title: "Nothing left to fill here", detail: "Apply Desk skips filled fields and questions only you should answer.", symbol: "checkmark.circle"))
        }
    }

    /// Saves the role-tuned PDF to Downloads and keeps a copy with the role.
    private func savePDF(jobID: Int) {
        resumePDF.make(jobID: jobID) { [weak self] output in
            guard let self = self else { return }
            guard let output = output else {
                return self.toasts.show(Toast(title: "Couldn't make the PDF", detail: "Try again in a moment.", symbol: "exclamationmark.triangle"))
            }
            self.backend.send("api/applications", json: ["job_id": jobID, "attached": false, "pages": output.pages, "pdf": output.pdf.base64EncodedString()]) { [weak self] result in
                guard let self = self else { return }
                let stem = ((result?["filename"] as? String) ?? "Resume.pdf").replacingOccurrences(of: ".pdf", with: "")
                let company = (result?["company"] as? String).flatMap { $0.isEmpty ? nil : " - \($0)" } ?? ""
                let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
                var target = folder.appendingPathComponent("\(stem)\(company).pdf")
                var copy = 2
                while FileManager.default.fileExists(atPath: target.path) {
                    target = folder.appendingPathComponent("\(stem)\(company) \(copy).pdf")
                    copy += 1
                }
                do {
                    try output.pdf.write(to: target)
                } catch {
                    return self.toasts.show(Toast(title: "Couldn't save the PDF", detail: error.localizedDescription, symbol: "exclamationmark.triangle"))
                }
                self.workspace.reload()
                self.toasts.show(Toast(title: "Saved to Downloads", detail: target.lastPathComponent + (output.pages > 1 ? " · \(output.pages) pages" : ""),
                                       symbol: "arrow.down.doc", actionTitle: "Show in Finder", action: { NSWorkspace.shared.activateFileViewerSelecting([target]) }))
            }
        }
    }

    private func confirmFirstFill() -> Bool {
        guard !UserDefaults.standard.bool(forKey: "skipFillConfirmation") else { return true }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Fill this application with your details?"
        alert.informativeText = "Apply Desk types your saved contact, education, and link details into empty, clearly labeled fields in Chrome's front tab, and attaches your resume tuned for this role to the resume upload. It skips sponsorship, demographic, and screening questions and never submits. Review everything before you apply."
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
