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
    private var fills: [String: Date] = [:]            // tab id → when its fill started; pressing ` in that tab stops it
    private var stopping: Set<String> = []             // tabs where ` was pressed to stop the fill
    private var learningTabs: [String: Date] = [:]     // tab id → when its last fill ended; the user's corrections are collected from it
    private var learningTimer: Timer?
    private var resumeMakers: [String: ResumePDF] = [:] // tab id → the resume being rendered for its fill
    // Batch mode (⇧` on a page of postings): each posting it applies to opens in
    // its own tab, two fill at a time, and each stops at Review for the user.
    private var batchHotKey: HotKey?
    private struct BatchItem { let id: Int; let url: String; var label: String; var status = "working" }
    private var batchQueue: [BatchItem] = []
    private var batchFilling: [String: BatchItem] = [:]   // tab id → item using one of the two slots
    private var batchTabs: [String: BatchItem] = [:]      // tab id → every batch tab still open, watched for a submit
    private var batchAutoSubmit = false
    private var batchTimer: Timer?
    private var batchCounts = (ready: 0, needs: 0, skipped: 0, submitted: 0)
    private let batchSlots = 2
    private var batchPaused = false       // Chrome stopped running scripts: no new tabs until ⇧` or Continue Batch
    private var batchWatchBusy = false    // a watch tick is running (Apple Events can run timers inside a call)
    private var batchWatchTurn = 0        // which waiting tabs this tick checks for a confirmation
    // Profile → Signing in: what each filling tab may use to get past a sign-in page.
    private struct SignIn { let email: String; let name: String; let mode: String; let agree: Bool }
    private var signIns: [String: SignIn] = [:]       // tab id → the user's choice and email, from that fill's plan

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
        // ⇧`, also only while Chrome is in front: apply to every posting on a page of many.
        batchHotKey = HotKey(keyCode: kVK_ANSI_Grave, modifiers: shiftKey) { [weak self] in self?.applyToList() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                if !Chrome.isFrontmost { self?.fillHotKey?.isEnabled = false; self?.batchHotKey?.isEnabled = false }
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
        let batch = item("Apply to Every Posting on This Page (⇧`)", #selector(applyToList))
        let running = !batchPaused && !(batchQueue.isEmpty && batchFilling.isEmpty)
        let control = running ? item("Stop Batch (⇧`, \(batchQueue.count) left)", #selector(stopBatch))
            : item(batchPaused ? "Continue Batch (\(batchQueue.count) left)" : "Continue Last Batch", #selector(continueBatch))
        let list = item("Show Batch List", #selector(openBatchList))
        let watch = item("Watch Chrome for Listings", #selector(toggleWatching))
        watch.state = watching ? .on : .off
        for entry in [scan, fill, batch, control, list, watch] { menu.addItem(entry) }
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
        case .granted: if chromeStatus != .javaScriptOff || Chrome.javaScriptSettingOn() == true { setChromeStatus(.ready) }
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
            batchHotKey?.isEnabled = false
            if chromeStatus == .ready || chromeStatus == .javaScriptOff { setChromeStatus(.notRunning) }
            return
        }
        guard Chrome.isFrontmost else {
            fillHotKey?.isEnabled = false
            batchHotKey?.isEnabled = false
            return
        }
        batchHotKey?.isEnabled = true
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
            // Chrome said the setting is off, or its saved setting is: with it on, the problem is something else, said plainly.
            if Chrome.lastFailure == .javaScriptOff || (Chrome.javaScriptSettingOn() != true && chromeStatus == .javaScriptOff) {
                showJavaScriptHelp()
            } else {
                setChromeStatus(.ready)
                if Chrome.lastFailure == .other && !Chrome.lastErrorMessage.isEmpty {
                    toasts.show(Toast(title: "Chrome didn't run Apply Desk on this tab",
                                      detail: "Your Chrome setting is on. Chrome said: \(Chrome.lastErrorMessage.prefix(140)). Click into the job page and try again.",
                                      symbol: "exclamationmark.triangle"))
                }
            }
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
        alert.informativeText = "Chrome says JavaScript from Apple Events is off, so Apply Desk can't read or fill pages. In Chrome's menu bar, choose View → Developer → Allow JavaScript from Apple Events so a check mark appears. If it already shows one, choose it twice (off, then on): Chrome can keep it off until it's set again. Quitting and reopening Chrome also works. Watching stays on."
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
        // Each tab runs its own fill, so several applications can go at once.
        // Pressing ` in a tab that's being filled stops that one right there.
        if let started = fills[tab.id], Date().timeIntervalSince(started) < 30 * 60 {
            stopping.insert(tab.id)
            _ = Chrome.runJavaScript(Autofill.stopScript, tabID: tab.id)
            return toasts.show(Toast(title: "Stopping…", detail: "Press ` again whenever you like. It continues from there and leaves what's filled alone.", symbol: "pause.circle"))
        }
        startFill(tab)
    }

    /// Starts the filler in `tab`: for the role given (batch mode already saved
    /// it), or the one this page belongs to.
    private func startFill(_ tab: Chrome.Tab, role knownRole: Int? = nil) {
        fills[tab.id] = Date()
        let lookup: (@escaping (Int?) -> Void) -> Void = { [weak self] done in
            if let role = knownRole { done(role) } else { self?.roleForFill(tab, completion: done) }
        }
        lookup { [weak self] role in
            guard let self = self else { return }
            self.fetchPlan(role: role, startingModel: true) { [weak self] plan in
                guard let self = self else { return }
                guard let plan = plan, let profile = plan["profile"] as? [String: Any],
                      profile.values.contains(where: { ($0 as? String).map { !$0.isEmpty } ?? false }) else {
                    self.fills[tab.id] = nil
                    self.batchEnded(tab.id, status: "failed", reason: "No Profile details")
                    return self.toasts.show(Toast(title: "Add your details first", detail: "Apply Desk fills applications from your profile.",
                                                  symbol: "person.text.rectangle", actionTitle: "Open Profile", action: { [weak self] in self?.workspace.show(path: "profile") }))
                }
                let name = (profile["name"] as? String).flatMap { $0.isEmpty ? nil : "\($0) Resume.pdf" } ?? "Resume.pdf"
                // A resume always goes with the application: tuned for the role
                // when Apply Desk knows the posting, otherwise the resume as it is.
                let maker = ResumePDF(backend: self.backend)
                self.resumeMakers[tab.id] = maker
                maker.make(jobID: role) { [weak self] output in
                    guard let self = self else { return }
                    self.resumeMakers[tab.id] = nil
                    self.runFill(plan: plan, tab: tab, role: role, resume: output, name: name)
                }
            }
        }
    }

    /// The fill plan. With the local model turned on but Ollama not running,
    /// Ollama is started in the background first, so essays still get its drafts.
    private func fetchPlan(role: Int?, startingModel: Bool, completion: @escaping ([String: Any]?) -> Void) {
        backend.send("api/fill-plan?job_id=\(role ?? 0)") { [weak self] plan in
            guard let self = self, startingModel, plan?["model_wanted"] as? Bool == true, (plan?["model"] as? String ?? "").isEmpty,
                  let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.electron.ollama") ?? Optional(URL(fileURLWithPath: "/Applications/Ollama.app")),
                  FileManager.default.fileExists(atPath: app.path) else { return completion(plan) }
            let launch = NSWorkspace.OpenConfiguration()
            launch.activates = false
            launch.hides = true
            NSWorkspace.shared.openApplication(at: app, configuration: launch)
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self = self else { return completion(plan) }
                self.fetchPlan(role: role, startingModel: false, completion: completion)
            }
        }
    }

    /// The saved role for the application in `tab`. When none matches, the
    /// posting is read on the spot (from this page, or from the listing the
    /// application belongs to) and saved, so the resume is still tuned for it.
    private func roleForFill(_ tab: Chrome.Tab, completion: @escaping (Int?) -> Void) {
        roleForApplication(tab) { [weak self] role in
            guard let self = self, role == nil else { return completion(role) }
            if let page = Chrome.readPage(tabID: tab.id), page.ready, page.description.count >= 300, JobListing.looksLikePosting(page.description) {
                var payload: [String: Any] = page.signals.mapValues { String($0.prefix(300)) }
                payload["url"] = tab.url
                payload["description"] = String(page.description.prefix(50_000))
                return self.saveRole(payload, tab: tab, completion: completion)
            }
            guard Chrome.runJavaScript(JobListing.findPostingScript, tabID: tab.id) != nil else { return completion(nil) }
            self.waitForPosting(tab, attempts: 20, completion: completion)
        }
    }

    private func waitForPosting(_ tab: Chrome.Tab, attempts: Int, completion: @escaping (Int?) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self else { return }
            let value = Chrome.runJavaScript("window.__applyDeskPosting || ''", tabID: tab.id) ?? ""
            if value.isEmpty {
                return attempts > 0 ? self.waitForPosting(tab, attempts: attempts - 1, completion: completion) : completion(nil)
            }
            guard let data = value.data(using: .utf8), let found = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                  let description = found["description"], description.count >= 300 else { return completion(nil) }
            self.saveRole(["url": found["url"] ?? tab.url, "title": found["title"] ?? "", "company": found["company"] ?? "",
                           "description": String(description.prefix(50_000))], tab: tab, completion: completion)
        }
    }

    private func saveRole(_ payload: [String: Any], tab: Chrome.Tab, completion: @escaping (Int?) -> Void) {
        backend.send("api/evaluate", json: payload) { [weak self] result in
            let role = result?["saved_job_id"] as? Int
            if let role = role { self?.tabLastRole[tab.id] = role }
            completion(role)
        }
    }

    /// Which saved role this application belongs to: the role last scanned in
    /// the same tab, or the role the user viewed last, when this page can
    /// belong to it (same site, a job board's listing, or the company's own
    /// site); otherwise a URL match. Another company's form never gets that
    /// role's resume.
    private func roleForApplication(_ tab: Chrome.Tab, completion: @escaping (Int?) -> Void) {
        var hints = [tabLastRole[tab.id]].compactMap { $0 }
        if let current = current, Date().timeIntervalSince(current.seen) < 2 * 3600 { hints.append(current.id) }
        let query = tab.url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))) ?? ""
        let hinted = hints.map(String.init).joined(separator: ",")
        backend.send("api/role-for-url?url=\(query)&hints=\(hinted)") { result in
            completion(result?["job_id"] as? Int)
        }
    }

    private func runFill(plan: [String: Any], tab: Chrome.Tab, role: Int?, resume: ResumePDF.Output?, name: String) {
        // Stopped while the resume was being prepared: nothing has started.
        if stopping.remove(tab.id) != nil {
            fills[tab.id] = nil
            return toasts.show(Toast(title: "Stopped", detail: "Press ` to start when you're ready.", symbol: "pause.circle"))
        }
        guard let planData = try? JSONSerialization.data(withJSONObject: plan),
              let script = Autofill.script(plan: planData, resume: resume.map { (name, $0.pdf) }) else { fills[tab.id] = nil; batchEnded(tab.id, status: "failed", reason: "Couldn't start"); return }
        guard Chrome.runJavaScript(script, tabID: tab.id) != nil else {
            fills[tab.id] = nil
            if batchTabs[tab.id] != nil && Chrome.lastFailure == .javaScriptOff { return batchPause(tab.id) }
            batchEnded(tab.id, status: "needs_you", reason: "This page wouldn't run Apply Desk")
            if Chrome.lastFailure != nil { noteChromeFailure(); fixChromeAccess() }
            else { toasts.show(Toast(title: "Couldn't read this form", detail: "This page may block autofill. Enter the remaining details yourself.", symbol: "exclamationmark.triangle")) }
            return
        }
        let profile = plan["profile"] as? [String: Any] ?? [:]
        signIns[tab.id] = SignIn(email: profile["email"] as? String ?? "", name: profile["name"] as? String ?? "",
                                 mode: plan["sign_in"] as? String ?? "", agree: plan["agree_terms"] as? Bool ?? false)
        // Toasts name the application, since several can be running.
        let info = plan["role"] as? [String: Any]
        let label = [info?["company"] as? String, info?["title"] as? String].compactMap { $0 }.first { !$0.isEmpty } ?? "This application"
        if batchTabs[tab.id] == nil {
            toasts.show(Toast(title: "Filling \(label)…", detail: "Apply Desk fills each page, checks it, fills it again, and stops at Review. You can start another in a different tab; press ` here to stop this one.", symbol: "wand.and.stars"), for: 60)
        }
        waitForFill(FillWatch(script: script, tabID: tab.id, label: label, role: role)) { [weak self] result in
            self?.finishFill(result, tab: tab, role: role, resume: resume, label: label)
        }
    }

    /// What the user changes after a fill is how Apply Desk learns, and they may
    /// submit without pressing ` again, so a filled tab is checked for a while after its run.
    private func watchCorrections(_ tabID: String) {
        learningTabs[tabID] = Date()
        guard learningTimer == nil else { return }
        learningTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.collectCorrections() }
    }

    private func collectCorrections() {
        guard Chrome.isRunning else { learningTabs.removeAll(); learningTimer?.invalidate(); learningTimer = nil; return }
        for (tabID, started) in learningTabs {
            guard Date().timeIntervalSince(started) < 6 * 3600, Chrome.tab(id: tabID) != nil else { learningTabs[tabID] = nil; continue }
            guard fills[tabID] == nil,   // a running fill reads these itself
                  let raw = Chrome.runJavaScript(Autofill.correctionsScript, tabID: tabID), !raw.isEmpty,
                  let seen = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: String], !seen.isEmpty else { continue }
            let answers = seen.map { ["question": $0.key, "answer": $0.value, "corrected": "yes"] }
            backend.send("api/answers", json: ["answers": answers]) { _ in }
            // The user changed something on a batch application: it no longer counts as submitted exactly as filled.
            if let item = batchTabs[tabID] { backend.send("api/batch/update", json: ["item": item.id, "status": item.status, "changed": true]) { _ in } }
        }
        if learningTabs.isEmpty { learningTimer?.invalidate(); learningTimer = nil }
    }

    /// A fill run in progress in one tab, which can span several pages.
    private struct FillWatch {
        let script: String
        let tabID: String
        let label: String
        let role: Int?
        var asked = ""          // the last batch of questions sent to the local model
        var progress = ""
        var lastChange = Date()
        var missingSince: Date?
        var reloads = 0
        var page = ""
        var waiting = false
        var last: Autofill.Result?
    }

    /// The filler keeps working after it starts; check on it until it's done.
    /// Each check also wakes the filler (a background tab's timers are slowed).
    /// When a step loads as a whole new page, start the filler again there;
    /// it picks up the same run from the tab's session storage.
    private func waitForFill(_ watch: FillWatch, completion: @escaping (Autofill.Result?) -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self else { return }
            var watch = watch
            if let result = Autofill.parse(Chrome.runJavaScript(Autofill.statusScript, tabID: watch.tabID)) {
                if result.done { return completion(result) }
                watch.missingSince = nil
                // Questions for the model on this Mac: ask the local service, then
                // hand the checked answers back to that tab (an empty list if it
                // can't answer, so the filler stops waiting).
                if let ask = result.ask, ask.id != watch.asked {
                    watch.asked = ask.id
                    let tabID = watch.tabID
                    self.toasts.show(Toast(title: "\(watch.label): drafting \(ask.questions.count) answer\(ask.questions.count == 1 ? "" : "s")…",
                                           detail: "The model on this Mac is writing drafts and picking options for the questions left. Nothing leaves this computer.", symbol: "sparkles"), for: 60)
                    self.backend.send("api/suggest", json: ["job_id": watch.role ?? 0, "questions": ask.questions], timeout: 170) { answers in
                        _ = Chrome.runJavaScript(Autofill.answersScript(id: ask.id, answers: answers?["answers"] as? [[String: Any]] ?? []), tabID: tabID)
                    }
                }
                let progress = "\(result.beat)|\(result.items.count)|\(result.fields.count)"
                if progress != watch.progress { watch.progress = progress; watch.lastChange = Date() }
                if result.waiting != watch.waiting || (!result.page.isEmpty && result.page != watch.page) {
                    watch.page = result.page
                    watch.waiting = result.waiting
                    // A batch tab waiting on the user frees its slot for the next posting; it carries on once they answer.
                    if self.batchTabs[watch.tabID] != nil {
                        if result.waiting { self.batchNeedsYou(watch.tabID, reason: "Answer what's left on \(result.page.isEmpty ? "this page" : result.page)") }
                    } else {
                    self.toasts.show(result.waiting
                        ? Toast(title: "\(watch.label) needs you on \(result.page)", detail: "Answer what's listed in that tab. Apply Desk keeps going by itself once you're done.", symbol: "hand.raised")
                        : Toast(title: "\(watch.label): filling \(result.page)…", detail: "Apply Desk goes page by page and stops at Review. Press ` in that tab to stop.", symbol: "wand.and.stars"), for: 60)
                    }
                }
                watch.last = result
            } else if self.stopping.contains(watch.tabID) {
                return completion(watch.last)   // the page reloaded just as it was stopped: don't start it again
            } else if watch.last?.advancing == true, watch.reloads < 12 {
                if Chrome.tab(id: watch.tabID)?.loading == false, Chrome.runJavaScript(watch.script, tabID: watch.tabID) != nil {
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

    private func finishFill(_ result: Autofill.Result?, tab: Chrome.Tab, role: Int?, resume: ResumePDF.Output?, label: String) {
        fills[tab.id] = nil
        let wasStopped = stopping.remove(tab.id) != nil
        watchCorrections(tab.id)
        if wasStopped, result?.done != true {
            batchEnded(tab.id, status: "needs_you", reason: "You stopped it")
            return toasts.show(Toast(title: "Stopped \(label)", detail: "Press ` to continue where it left off.", symbol: "pause.circle"))
        }
        guard let result = result, result.done else {
            batchEnded(tab.id, status: "needs_you", reason: "The form stopped responding")
            return toasts.show(Toast(title: "\(label): the form stopped responding", detail: "Some fields may be filled. Check that tab and press ` there to pick it up again.", symbol: "exclamationmark.triangle"))
        }
        if !result.learned.isEmpty {
            backend.send("api/answers", json: ["answers": result.learned]) { _ in }
        }
        // A sign-in page, and the user chose Profile → Signing in: get past it, then fill.
        if result.stop == "signin", let signIn = signIns[tab.id], !signIn.mode.isEmpty, !signIn.email.isEmpty {
            return signInStep(tab.id, role: role, label: label, step: 0, last: "")
        }
        // Lines with a value are answers; the rest are blanks listed for the user.
        let answered = result.items.filter { !($0["value"] ?? "").isEmpty }.count
        let blanks = result.items.filter { ($0["flag"] ?? "").hasPrefix("Required") }.count
        let filled = max(result.fields.count, answered)
        if let role = role, let resume = resume, !result.items.isEmpty || result.attached {
            // Keep the exact resume that went with this application, and the
            // review of every page; later pages of the same run update it.
            backend.send("api/applications", json: ["job_id": role, "url": tab.url, "attached": result.attached, "fields": result.fields,
                                                    "run": result.run, "review": result.items,
                                                    "pages": resume.pages, "pdf": resume.pdf.base64EncodedString()]) { [weak self] _ in
                if self?.workspace.isVisible == true { self?.workspace.reload() }
            }
        }
        if batchTabs[tab.id] != nil { return batchFilled(tab.id, result: result, attached: result.attached) }
        let open: () -> Void = { [weak self] in if let role = role { self?.workspace.show(path: "job/\(role)") } }
        let pageName = result.page.isEmpty ? "This page" : result.page
        let resumeNote = !result.attached ? "" : role == nil ? " Attached your resume as it is (Apply Desk couldn't find the posting to tune it)." : " Attached your tuned resume."
        // A Review step, or a one-page form that's been filled, checked, and filled
        // again: what's left is in the panel on that tab.
        let onePage = result.pages.isEmpty && (result.stop == "end" || result.stop == "needs")
        if result.stop == "review" || (onePage && answered > 0) {
            let pages = result.pages.count
            let detail = "Filled \(answered) field\(answered == 1 ? "" : "s")\(pages > 1 ? " across \(pages) pages" : "").\(resumeNote) "
                + (blanks > 0 ? "\(blanks) still need\(blanks == 1 ? "s" : "") you. " : "") + (result.checks > 0 ? "\(result.checks) to check in the panel. " : "") + "Submit is yours."
            return toasts.show(Toast(title: blanks > 0 ? "\(label): \(blanks) left for you" : "\(label) is ready for your review", detail: detail,
                                     symbol: blanks > 0 ? "hand.raised" : "checkmark.seal", actionTitle: role == nil ? nil : "See What Was Sent", action: open), for: 14)
        }
        switch result.stop {
        case "needs", "errors":
            let shown = result.needs.prefix(3).joined(separator: "; ") + (result.needs.count > 3 ? "…" : "")
            return toasts.show(Toast(title: "\(label): \(pageName) needs you", detail: "\(shown). Answer \(result.needs.count == 1 ? "it" : "them") in that tab, then press ` there to keep going.",
                                     symbol: "hand.raised"), for: 14)
        case "signin":
            return toasts.show(Toast(title: "Sign in first", detail: "Sign in, then press ` on the application's first page. Profile → Signing in lets Apply Desk sign in with Google or make an account for you.", symbol: "person.badge.key"))
        case "stopped":
            return toasts.show(Toast(title: "Stopped on \(pageName)", detail: "Press ` to continue. It only fills what's still blank, and what you change now is learned.", symbol: "pause.circle"))
        case "stuck":
            return toasts.show(Toast(title: "The next page didn't load", detail: "Click Continue yourself, then press ` on the new page.", symbol: "exclamationmark.triangle"))
        default:
            break
        }
        if filled > 0 || result.attached {
            let parts = [filled > 0 ? "filled \(filled) field\(filled == 1 ? "" : "s")" : nil,
                         result.blocks > 0 ? "\(result.blocks) experience and education entr\(result.blocks == 1 ? "y" : "ies")" : nil,
                         result.attached ? (role == nil ? "attached your resume" : "attached your tuned resume") : nil].compactMap { $0 }
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
        alert.informativeText = "Apply Desk types your saved contact, education, and link details into empty, clearly labeled fields in Chrome's front tab, and attaches your resume tuned for this role to the resume upload. It never submits unless you turn that on for batch mode. Review everything before you apply."
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

// MARK: Batch mode

extension AppDelegate {
    @objc private func openBatchList() { workspace.show(path: "batch") }

    /// ⇧` on a page of postings (a job board search, a careers page, an
    /// internship list): the local service picks which to apply to (not quant
    /// or trading, no active clearance needed, internships and co-ops, not
    /// already applied to), and each opens in its own tab, two at a time, and
    /// is filled up to Review. The user gets a note as each is ready, and
    /// submits it, unless they turned on submitting fully clean ones.
    @objc private func applyToList() {
        guard Chrome.isRunning, Chrome.isFrontmost || NSApp.isActive else {
            return toasts.show(Toast(title: "Switch to the list in Chrome", detail: "Press ⇧` on a page of postings.", symbol: "globe"))
        }
        switch Chrome.automationAccess(ask: false) {
        case .granted: break
        case .denied: return askAgainForChromeAccess()
        default: return requestChromeAccess { [weak self] in self?.applyToList() }
        }
        guard confirmFirstFill() else { return }
        if batchPaused { return continueBatch() }
        // ⇧` while a batch is opening postings stops it; ⇧` again continues.
        if !batchQueue.isEmpty { return stopBatch() }
        guard let tab = Chrome.activeTab(), let script = Autofill.batchScript("collect()"),
              let raw = Chrome.runJavaScript(script, tabID: tab.id), let data = raw.data(using: .utf8),
              let found = (try? JSONSerialization.jsonObject(with: data)) as? [[String: String]] else {
            noteChromeFailure()
            return toasts.show(Toast(title: "Couldn't read this page", detail: Chrome.lastErrorMessage.isEmpty ? "Open a page with many postings and try again." : "Chrome said: \(Chrome.lastErrorMessage.prefix(140))", symbol: "exclamationmark.triangle"))
        }
        guard found.count >= 2 else {
            // Not a list: pick up postings an earlier batch left (Apply Desk quit, or it was stopped).
            if batchQueue.isEmpty && batchFilling.isEmpty { return continueBatch() }
            return toasts.show(Toast(title: "No list of postings here", detail: "On a single posting or application, press ` instead. ⇧` is for a page with many postings.", symbol: "list.bullet"))
        }
        if batchFilling.isEmpty && batchQueue.isEmpty { batchCounts = (0, 0, 0, 0) }
        backend.send("api/batch/start", json: ["items": found]) { [weak self] result in
            guard let self = self, let items = result?["items"] as? [[String: Any]] else {
                self?.toasts.show(Toast(title: "Couldn't reach the local service", detail: "Try ⇧` again in a moment.", symbol: "exclamationmark.triangle"))
                return
            }
            self.batchAutoSubmit = result?["auto_submit"] as? Bool ?? false
            let picked = items.filter { $0["apply"] as? Bool == true }.compactMap { item -> BatchItem? in
                guard let id = item["id"] as? Int, let url = item["url"] as? String else { return nil }
                return BatchItem(id: id, url: url, label: String((item["text"] as? String ?? url).prefix(60)))
            }
            let skipped = items.count - picked.count
            self.batchCounts.skipped += skipped
            self.batchQueue += picked
            self.toasts.show(Toast(title: "Applying to \(picked.count) of \(items.count) postings",
                                   detail: "Each opens in its own tab, two at a time, and stops at Review. Press ⇧` to stop. Skipped \(skipped): wave 1, quant or trading, an active clearance, not an internship, or already applied.",
                                   symbol: "square.stack.3d.down.forward", actionTitle: "Show List", action: { [weak self] in self?.openBatchList() }), for: 14)
            self.batchNext()
            self.startBatchWatch()
        }
    }

    /// Opens the next postings while a slot is free.
    private func batchNext() {
        // A posting still open from an earlier run (Apply Desk quit mid-batch) is filled in its own tab, not a new one.
        let open = batchPaused || batchQueue.isEmpty ? [] : Chrome.tabList() ?? []
        while !batchPaused, batchFilling.count < batchSlots, !batchQueue.isEmpty {
            let item = batchQueue.removeFirst()
            let reuse = open.first { Chrome.samePage($0.url, item.url) && batchTabs[$0.id] == nil }?.id
            guard let tabID = reuse ?? Chrome.openTab(item.url) else {
                batchUpdate(item, "failed", reason: "Couldn't open a tab")
                continue
            }
            batchFilling[tabID] = item
            batchTabs[tabID] = item
            batchUpdate(item, "working")
            batchLoad(item, tabID: tabID, waits: 60, reads: 8)
        }
        if !batchPaused, batchFilling.isEmpty, batchQueue.isEmpty, batchCounts.ready + batchCounts.needs + batchCounts.submitted > 0, batchTabs.values.allSatisfy({ $0.status != "working" }) {
            let c = batchCounts
            batchCounts = (0, 0, 0, 0)
            toasts.show(Toast(title: "Batch done: \(c.ready) ready to submit\(c.submitted > 0 ? ", \(c.submitted) submitted" : "")",
                              detail: "\(c.needs) need you, \(c.skipped) skipped. Each one is in its own tab; the list shows why any were skipped.",
                              symbol: "checklist", actionTitle: "Show List", action: { [weak self] in self?.openBatchList() }), for: 16)
        }
    }

    /// Waits for the posting to load, saves it as a role, and asks the local
    /// service whether it's one to apply to (the list row can't always tell).
    private func batchLoad(_ item: BatchItem, tabID: String, waits: Int, reads: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self = self else { return }
            guard let tab = Chrome.tab(id: tabID) else { return self.batchEnded(tabID, status: "closed", reason: "Tab closed") }
            if tab.loading && waits > 0 { return self.batchLoad(item, tabID: tabID, waits: waits - 1, reads: reads) }
            guard let page = Chrome.readPage(tabID: tabID), page.ready, page.description.count >= 300, JobListing.looksLikePosting(page.description) else {
                if Chrome.lastFailure == .javaScriptOff { return self.batchPause(tabID) }
                // Boards that draw the posting after the page loads get a few more looks; an application page goes straight to the filler.
                if reads > 0 { return self.batchLoad(item, tabID: tabID, waits: 0, reads: reads - 1) }
                return self.startFill(tab)
            }
            var payload: [String: Any] = page.signals.mapValues { String($0.prefix(300)) }
            payload["url"] = tab.url
            payload["description"] = String(page.description.prefix(50_000))
            self.saveRole(payload, tab: tab) { [weak self] role in
                guard let self = self else { return }
                guard let role = role else { return self.startFill(tab) }
                self.backend.send("api/batch/check", json: ["item": item.id, "job_id": role]) { [weak self] check in
                    guard let self = self else { return }
                    if check?["apply"] as? Bool == false {
                        Chrome.closeTab(tabID)
                        self.batchFilling[tabID] = nil
                        self.batchTabs[tabID] = nil
                        self.batchCounts.skipped += 1
                        return self.batchNext()
                    }
                    let title = check?["title"] as? String ?? "", company = check?["company"] as? String ?? ""
                    if !title.isEmpty, var named = self.batchTabs[tabID] {
                        named.label = company.isEmpty ? title : "\(company): \(title)"
                        self.batchTabs[tabID] = named
                        self.batchFilling[tabID] = named
                    }
                    self.startFill(tab, role: role)
                }
            }
        }
    }

    private func batchUpdate(_ item: BatchItem, _ status: String, reason: String = "", items: [[String: String]]? = nil, auto: Bool = false,
                             completion: (([String: Any]?) -> Void)? = nil) {
        var body: [String: Any] = ["item": item.id, "status": status, "reason": reason, "auto": auto]
        if let items = items { body["items"] = items }
        backend.send("api/batch/update", json: body) { result in completion?(result) }
    }

    private func showTab(_ tabID: String) -> () -> Void { { Chrome.show(tabID: tabID) } }

    /// A batch tab whose fill ended early (it couldn't start, was stopped, or the page stopped responding).
    private func batchEnded(_ tabID: String, status: String, reason: String) {
        guard var item = batchTabs[tabID] else { return }
        batchFilling[tabID] = nil
        item.status = status
        if status == "needs_you" {
            batchTabs[tabID] = item
            batchCounts.needs += 1
            toasts.show(Toast(title: "\(item.label) needs you", detail: "\(reason). It's waiting in its own tab.", symbol: "hand.raised",
                              actionTitle: "Show Tab", action: showTab(tabID)), for: 10)
        } else {
            batchTabs[tabID] = nil
        }
        batchUpdate(item, status, reason: reason)
        batchNext()
    }

    /// The filler is waiting on the user in this tab: its slot goes to the next
    /// posting, and the fill carries on by itself once they answer.
    private func batchNeedsYou(_ tabID: String, reason: String) {
        guard var item = batchTabs[tabID], item.status != "needs_you" else { return }
        item.status = "needs_you"
        batchTabs[tabID] = item
        batchFilling[tabID] = nil
        batchCounts.needs += 1
        batchUpdate(item, "needs_you", reason: reason)
        toasts.show(Toast(title: "\(item.label) needs you", detail: "\(reason). It keeps going once you answer.", symbol: "hand.raised",
                          actionTitle: "Show Tab", action: showTab(tabID)), for: 10)
        batchNext()
    }

    /// The fill reached the end: at Review with nothing required left, the
    /// application is ready for the user to submit (or submitted, when they
    /// turned that on and every answer is their own); otherwise it needs them.
    private func batchFilled(_ tabID: String, result: Autofill.Result, attached: Bool) {
        guard var item = batchTabs[tabID] else { return }
        batchFilling[tabID] = nil
        let answered = result.items.filter { !($0["value"] ?? "").isEmpty }.count
        let blanks = result.items.filter { ($0["flag"] ?? "").hasPrefix("Required") }.count
        let onePage = result.pages.isEmpty && (result.stop == "end" || result.stop == "needs")
        let wasWaiting = item.status == "needs_you"
        if (result.stop == "review" || (onePage && answered > 0)) && blanks == 0 {
            item.status = "ready"
            batchTabs[tabID] = item
            if wasWaiting { batchCounts.needs -= 1 }
            batchCounts.ready += 1
            batchUpdate(item, "ready", items: result.items) { [weak self] response in
                guard let self = self else { return }
                let clean = response?["clean"] as? Bool ?? false
                if self.batchAutoSubmit && clean && attached { return self.batchSubmit(tabID) }
                self.toasts.show(Toast(title: "Ready to submit: \(item.label)",
                                       detail: "Filled \(answered) field\(answered == 1 ? "" : "s")\(attached ? " and attached your tuned resume" : ""). Check it and press Submit."
                                           + (clean ? "" : " Some answers are marked to check in the panel on that tab."),
                                       symbol: "checkmark.seal", actionTitle: "Show Tab", action: self.showTab(tabID)), for: 12)
            }
        } else {
            let reason = result.stop == "signin" ? "Sign in to this site, then press ` there (Profile → Signing in can do it for you)"
                : blanks > 0 ? "\(blanks) required question\(blanks == 1 ? "" : "s") only you can answer"
                : result.stop == "stuck" ? "The next page didn't load"
                : !result.needs.isEmpty ? "Answer " + result.needs.prefix(3).joined(separator: "; ")
                : "Check this tab"
            item.status = "needs_you"
            batchTabs[tabID] = item
            if !wasWaiting { batchCounts.needs += 1 }
            batchUpdate(item, "needs_you", reason: reason)
            toasts.show(Toast(title: "\(item.label) needs you", detail: "\(reason).", symbol: "hand.raised", actionTitle: "Show Tab", action: showTab(tabID)), for: 10)
        }
        batchNext()
    }

    /// Presses Submit on a fully clean application (only with the user's say-so in
    /// Profile) and checks the page confirms it; if not, the tab is left for them.
    private func batchSubmit(_ tabID: String) {
        guard var item = batchTabs[tabID], let script = Autofill.batchScript("submit()") else { return }
        guard Chrome.runJavaScript(script, tabID: tabID) == "\"pressed\"" else {
            return toasts.show(Toast(title: "Ready to submit: \(item.label)", detail: "Apply Desk couldn't find its Submit button. Check it and press Submit.",
                                     symbol: "checkmark.seal", actionTitle: "Show Tab", action: showTab(tabID)), for: 12)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self = self, let check = Autofill.batchScript("confirmed()") else { return }
            if Chrome.runJavaScript(check, tabID: tabID) == "true" {
                item.status = "submitted"
                self.batchTabs[tabID] = nil
                self.batchCounts.ready -= 1
                self.batchCounts.submitted += 1
                self.batchUpdate(item, "submitted", auto: true)
                self.toasts.show(Toast(title: "Submitted: \(item.label)", detail: "Every answer was your own and nothing was blank, so Apply Desk submitted it. What was sent is on the role page.",
                                       symbol: "paperplane", actionTitle: "Show Tab", action: self.showTab(tabID)), for: 10)
            } else {
                item.status = "needs_you"
                self.batchTabs[tabID] = item
                self.batchUpdate(item, "needs_you", reason: "Pressed Submit, but the page didn't confirm it")
                self.toasts.show(Toast(title: "Check \(item.label)", detail: "Apply Desk pressed Submit, but the page didn't confirm it. Look at that tab before anything else.",
                                       symbol: "exclamationmark.triangle", actionTitle: "Show Tab", action: self.showTab(tabID)), for: 16)
            }
        }
    }

    /// Every few seconds: a closed batch tab is closed; one showing "thank you
    /// for applying" was submitted, which counts toward the clean record.
    private func startBatchWatch() {
        guard batchTimer == nil else { return }
        batchTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.batchWatchTick() }
        }
    }

    private func batchWatchTick() {
        // One Apple Events call lists every tab; a call can run this timer again
        // inside itself, and dozens of calls per tick froze the app.
        guard Chrome.isRunning, !batchWatchBusy, let open = Chrome.tabList().map({ Set($0.map { $0.id }) }) else { return }
        batchWatchBusy = true
        defer { batchWatchBusy = false }
        let waiting = batchTabs.filter { batchFilling[$0.key] == nil }.sorted { $0.key < $1.key }
        for (tabID, item) in waiting where !open.contains(tabID) {
            var closed = item
            closed.status = "closed"
            batchTabs[tabID] = nil
            batchUpdate(closed, "closed")
        }
        // Every ready tab, and a few of the ones waiting on the user, in turn.
        let stillOpen = waiting.filter { open.contains($0.key) }
        let ready = stillOpen.filter { $0.value.status == "ready" }
        let needs = stillOpen.filter { $0.value.status == "needs_you" }
        batchWatchTurn += 1
        let some = needs.isEmpty ? [] : (0..<min(3, needs.count)).map { needs[(batchWatchTurn * 3 + $0) % needs.count] }
        for (tabID, item) in batchPaused ? [] : ready + some {
            guard batchTabs[tabID] != nil, let script = Autofill.batchScript("confirmed()"),
                  Chrome.runJavaScript(script, tabID: tabID) == "true" else { continue }
            var done = item
            done.status = "submitted"
            batchTabs[tabID] = nil
            batchCounts.submitted += 1
            batchUpdate(done, "submitted") { [weak self] response in
                if response?["ask_auto_submit"] as? Bool == true { self?.askAutoSubmit() }
            }
        }
        if batchTabs.isEmpty && batchQueue.isEmpty && !batchPaused { batchTimer?.invalidate(); batchTimer = nil }
    }

    /// Chrome stopped running scripts (its JavaScript from Apple Events setting
    /// is off): this posting goes back to the front of the queue, its tab
    /// closes, and no more tabs open until the user fixes it and continues.
    private func batchPause(_ tabID: String) {
        guard var item = batchTabs[tabID] else { return }
        batchFilling[tabID] = nil
        batchTabs[tabID] = nil
        item.status = "queued"
        batchQueue.insert(item, at: 0)
        batchUpdate(item, "queued")
        Chrome.closeTab(tabID)
        guard !batchPaused else { return }
        batchPaused = true
        noteChromeFailure()
        toasts.show(Toast(title: "Batch paused: \(batchQueue.count) postings left", detail: "Chrome isn't letting Apply Desk run on pages. Fix the setting, then press ⇧` (or Continue Batch in the menu) to pick up where it stopped.",
                          symbol: "pause.circle"), for: 20)
        fixChromeAccess()
    }

    /// Stops opening postings; tabs already filling finish, and the rest stay saved for Continue.
    @objc private func stopBatch() {
        let left = batchQueue.count
        batchQueue.removeAll()
        batchPaused = false
        toasts.show(Toast(title: "Stopped the batch", detail: "\(left) posting\(left == 1 ? "" : "s") not started yet stay saved. Tabs already filling finish. Press ⇧` on any page that isn't a list (or Continue Last Batch in the menu) to pick them up.",
                          symbol: "stop.circle", actionTitle: "Show List", action: { [weak self] in self?.openBatchList() }), for: 12)
    }

    /// Picks up a paused batch, or the postings an earlier one left queued.
    @objc private func continueBatch() {
        if batchPaused {
            batchPaused = false
            toasts.show(Toast(title: "Continuing: \(batchQueue.count) postings left", detail: "Each opens in its own tab, two at a time, and stops at Review.", symbol: "play.circle"), for: 8)
            batchNext()
            return startBatchWatch()
        }
        guard batchQueue.isEmpty && batchFilling.isEmpty else { return }
        backend.send("api/batch/resume", json: [:]) { [weak self] result in
            guard let self = self else { return }
            let items = (result?["items"] as? [[String: Any]] ?? []).compactMap { item -> BatchItem? in
                guard let id = item["id"] as? Int, let url = item["url"] as? String else { return nil }
                return BatchItem(id: id, url: url, label: String((item["text"] as? String ?? url).prefix(60)))
            }
            guard !items.isEmpty else {
                return self.toasts.show(Toast(title: "No batch to continue", detail: "Press ⇧` on a page with many postings to start one.", symbol: "list.bullet"))
            }
            self.batchAutoSubmit = result?["auto_submit"] as? Bool ?? false
            self.batchCounts = (0, 0, 0, 0)
            self.batchQueue = items
            self.toasts.show(Toast(title: "Continuing your batch: \(items.count) postings", detail: "Postings already open in Chrome are filled in their own tabs. Each stops at Review.",
                                   symbol: "play.circle", actionTitle: "Show List", action: { [weak self] in self?.openBatchList() }), for: 10)
            self.batchNext()
            self.startBatchWatch()
        }
    }

    /// Asked once, after ten batch applications in a row were submitted exactly as filled.
    private func askAutoSubmit() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Submit fully clean applications for you?"
        alert.informativeText = "Your last 10 batch applications were submitted exactly as Apply Desk filled them. From now on, Apply Desk can press Submit itself when every answer is your own and nothing is blank, drafted, or guessed. Anything else still waits for you, and you can turn this off in Profile."
        alert.addButton(withTitle: "Submit Clean Ones")
        alert.addButton(withTitle: "Not Yet")
        let yes = alert.runModal() == .alertFirstButtonReturn
        batchAutoSubmit = yes
        backend.send("api/batch/auto-submit", json: ["enabled": yes]) { _ in }
    }
}

// MARK: Signing in

extension AppDelegate {
    /// One step past a sign-in page (Profile → Signing in): Google when the user
    /// chose it and the site offers it, the password Apply Desk made for this
    /// site, or a new account with a new Keychain password. Each step waits for
    /// the page, then looks again; once there's no sign-in left, the fill starts
    /// over and picks up where it was. Codes, verification emails, and "are you
    /// human" checks go to the user, who presses ` once past them.
    private func signInStep(_ tabID: String, role: Int?, label: String, step: Int, last: String) {
        guard let signIn = signIns[tabID], let tab = Chrome.tab(id: tabID), let site = Accounts.site(of: tab.url) else { return }
        if tab.loading && step < 30 {
            return DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.signInStep(tabID, role: role, label: label, step: step + 1, last: last) }
        }
        let look = Chrome.runJavaScript(Autofill.accountScript("look") ?? "", tabID: tabID).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"")) } ?? "none"
        if look == "none" { return restartFill(tabID, role: role) }
        // The same page after signing in with the saved password: it didn't work.
        if last == "signed_in" && look == "signin" {
            return signInNeedsYou(tabID, label: label, reason: "The password Apply Desk saved for \(site) didn't work. Sign in yourself (it's in Keychain Access under \"Apply Desk\"), then press ` there")
        }
        guard step < 12 else { return signInNeedsYou(tabID, label: label, reason: "Apply Desk couldn't get past signing in to \(site). Sign in, then press ` there") }
        let known = Accounts.password(site: site, email: signIn.email)
        let password = known ?? (look == "create" ? Accounts.makePassword(site: site, email: signIn.email) : nil)
        let argument: [String: Any] = ["email": signIn.email, "password": password ?? "", "known": known != nil,
                                       "google": signIn.mode == "google", "name": signIn.name, "agree": signIn.agree]
        let did = Chrome.runJavaScript(Autofill.accountScript("act", argument) ?? "", tabID: tabID).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"")) } ?? ""
        switch did {
        case "google":
            toasts.show(Toast(title: "\(label): signing in with Google…", detail: "Apply Desk picks \(signIn.email) in Google's window. If Chrome shows its own account prompt, choose it there.", symbol: "person.badge.key"), for: 20)
            watchGoogle(tabID, role: role, label: label, since: Date(), told: false)
        case "created", "signed_in", "opened_create":
            if did == "created" {
                toasts.show(Toast(title: "Made an account on \(site)", detail: "With \(signIn.email) and a new password saved in your Keychain (Keychain Access, search \"Apply Desk\").", symbol: "person.crop.circle.badge.checkmark"), for: 10)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.signInStep(tabID, role: role, label: label, step: step + 1, last: did) }
        case "captcha":
            signInNeedsYou(tabID, label: label, reason: "\(site) wants you to prove you're human. Do that, then press ` there")
        case "code":
            signInNeedsYou(tabID, label: label, reason: "Enter the code \(site) sent to \(signIn.email), then press ` there")
        case "verify":
            signInNeedsYou(tabID, label: label, reason: "Open the verification email \(site) sent to \(signIn.email), then come back and press ` on the application")
        case "exists":
            signInNeedsYou(tabID, label: label, reason: "You already have an account on \(site) that Apply Desk doesn't know the password to. Sign in, then press ` there")
        default:
            signInNeedsYou(tabID, label: label, reason: "Sign in or make an account on \(site), then press ` there")
        }
    }

    /// After "Sign in with Google": picks the user's account in Google's window
    /// (a pop-up or this tab) and continues only for a plain sign-in. When the
    /// application page no longer asks to sign in, the fill starts over.
    private func watchGoogle(_ tabID: String, role: Int?, label: String, since: Date, told: Bool) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, let signIn = self.signIns[tabID] else { return }
            let googleTabs = (Chrome.tabList() ?? []).filter { URLComponents(string: $0.url)?.host == "accounts.google.com" }
            for page in googleTabs {
                let said = Chrome.runJavaScript(Autofill.accountScript("google", signIn.email) ?? "", tabID: page.id).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"")) } ?? ""
                if said == "password" || said == "asks_more" || said == "no_account" {
                    let why = said == "asks_more" ? "This site asks Google for more than your name and email, so Apply Desk left it for you"
                        : said == "no_account" ? "\(signIn.email) isn't signed in to Google in this Chrome" : "Google wants your password or a second step"
                    return self.signInNeedsYou(tabID, label: label, reason: "\(why). Finish signing in with Google, then press ` on the application")
                }
            }
            guard let tab = Chrome.tab(id: tabID) else { return }
            let onGoogle = URLComponents(string: tab.url)?.host == "accounts.google.com"
            let look = onGoogle || tab.loading ? "" : Chrome.runJavaScript(Autofill.accountScript("look") ?? "", tabID: tabID).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"")) } ?? ""
            if look == "none" && googleTabs.isEmpty { return self.restartFill(tabID, role: role) }
            if Date().timeIntervalSince(since) > 90 {
                return self.signInNeedsYou(tabID, label: label, reason: "Signing in with Google didn't finish. Finish it in Chrome, then press ` on the application")
            }
            // Chrome's own account prompt (not a page Apply Desk can read): the user picks.
            let tell = !told && googleTabs.isEmpty && !onGoogle && Date().timeIntervalSince(since) > 8
            if tell {
                self.toasts.show(Toast(title: "Choose \(signIn.email) in Chrome", detail: "Chrome is asking which Google account to use. Pick it, and Apply Desk carries on with \(label).", symbol: "person.badge.key"), for: 20)
            }
            self.watchGoogle(tabID, role: role, label: label, since: since, told: told || tell)
        }
    }

    /// Past sign-in: the filler starts again on this tab (a batch tab keeps its slot).
    private func restartFill(_ tabID: String, role: Int?) {
        guard fills[tabID] == nil, let tab = Chrome.tab(id: tabID) else { return }
        startFill(tab, role: role)
    }

    private func signInNeedsYou(_ tabID: String, label: String, reason: String) {
        if batchTabs[tabID] != nil {
            batchNeedsYou(tabID, reason: reason)
        } else {
            toasts.show(Toast(title: "\(label) needs you", detail: reason + ".", symbol: "person.badge.key", actionTitle: "Show Tab", action: { Chrome.show(tabID: tabID) }), for: 16)
        }
    }
}
