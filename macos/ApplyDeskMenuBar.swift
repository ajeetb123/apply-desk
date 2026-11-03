import AppKit
import Foundation

@main
final class ApplyDeskMenuBar: NSObject, NSApplicationDelegate {
    private let dashboardURL = URL(string: "http://127.0.0.1:8787/")!
    private let apiURL = URL(string: "http://127.0.0.1:8787/api/evaluate")!
    private var statusItem: NSStatusItem!
    private var watcherTimer: Timer?
    private var watcherEnabled = true
    private var lastTabKey = ""
    private var lastResultText = "Waiting for a job listing"
    private var processedTabs = Set<String>()
    private var pageLoadAttempts: [String: Int] = [:]
    private var showingPermissionAlert = false
    private var browserPermissionError = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "Apply Desk"
            button.toolTip = "Apply Desk — background job matching"
        }
        rebuildMenu()
        startWatcher()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc private func scanNow() {
        scanActiveTab(manual: true)
    }

    @objc private func fillApplicationFields() {
        guard let tab = readActiveTabIdentity() else {
            showMessage("Open an application form", detail: "Apply Desk fills clearly labeled, empty fields in the active Chrome tab.")
            return
        }
        let confirm = NSAlert()
        confirm.messageText = "Fill safe, empty application fields?"
        confirm.informativeText = "Apply Desk can add saved contact and education details to clearly labeled empty fields. It won’t answer screening questions or submit the application. You’ll review every value on the employer page."
        confirm.alertStyle = .informational
        confirm.addButton(withTitle: "Continue")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return }

        let profileURL = URL(string: "http://127.0.0.1:8787/api/profile")!
        URLSession.shared.dataTask(with: profileURL) { [weak self] data, _, error in
            guard let self = self, error == nil, let data = data,
                  let profile = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                  let profileData = try? JSONSerialization.data(withJSONObject: profile),
                  let currentTab = self.readActiveTabIdentity(), currentTab.url == tab.url else {
                DispatchQueue.main.async { self?.showMessage("Couldn’t prepare this form", detail: "Check that the local Apply Desk service is running and that Chrome is still on the same tab.") }
                return
            }
            let encoded = profileData.base64EncodedString()
            let javascript = """
            (() => {
              const p=JSON.parse(atob('\(encoded)')), pieces=(p.name||'').trim().split(/\\s+/);
              const values={email:p.email||'',phone:p.phone||'',first:pieces[0]||'',last:pieces.length>1?pieces.slice(1).join(' '):'',name:p.name||'',address:p.address||'',city:p.city||'',state:p.state||'',postal:p.postal_code||'',school:p.school||'',degree:p.degree||'',graduation:p.graduation||''};
              const all=[...document.querySelectorAll('input')], norm=s=>(s||'').toLowerCase().replace(/[_-]+/g,' ').replace(/\\s+/g,' ').trim();
              const label=e=>norm([e.getAttribute('autocomplete'),e.getAttribute('aria-label'),(e.getAttribute('aria-labelledby')||'').split(/\\s+/).map(id=>document.getElementById(id)?.innerText).join(' '),e.getAttribute('placeholder'),e.name,e.id,[...(e.labels||[])].map(x=>x.innerText).join(' '),e.closest('label')?.innerText,e.parentElement?.querySelector('label')?.innerText].filter(Boolean).join(' '));
              const rules=[['email',/e ?mail/],['phone',/phone|mobile|cellular/],['first',/first name|given name|given-name/],['last',/last name|family name|family-name|surname/],['name',/full name|your name|^name$/],['address',/street address|address line 1|address-line1|^address$/],['city',/(^| )city( |$)|town/],['state',/(^| )state( |$)|province/],['postal',/zip|postal code|postal-code/],['school',/school|university|college/],['degree',/degree/],['graduation',/graduat|expected completion/]];
              const filled=[];
              for(const e of all){const t=(e.type||'text').toLowerCase(),l=label(e);if(!e.getClientRects().length||e.disabled||e.readOnly||(e.value||'').trim()||!['text','email','tel','url','number'].includes(t)||/sponsor|visa|will you|are you|race|ethnicity|gender|disability|veteran|work authorization|authorized to work/.test(l))continue;const match=rules.find(([k,r])=>values[k]&&r.test(l));if(!match)continue;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,values[match[0]]);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));filled.push(match[0])}
              return JSON.stringify({count:filled.length,fields:filled});
            })()
            """
            guard let raw = self.executePageJavaScript(javascript), let resultData = raw.data(using: .utf8),
                  let result = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any],
                  let count = result["count"] as? Int else {
                DispatchQueue.main.async { self.showChromePermissionHelp() }
                return
            }
            DispatchQueue.main.async {
                self.showMessage(count == 0 ? "No safe empty fields found" : "Review your application", detail: count == 0 ? "Sign in and open an editable application form. Apply Desk skips ambiguous fields and questions that need your judgment." : "Filled \(count) empty field\(count == 1 ? "" : "s"). Review every value on the employer page and submit it yourself.")
            }
        }.resume()
    }

    @objc private func toggleWatcher() {
        watcherEnabled.toggle()
        if watcherEnabled { lastTabKey = ""; startWatcher() } else { watcherTimer?.invalidate(); watcherTimer = nil }
        rebuildMenu()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func startWatcher() {
        watcherTimer?.invalidate()
        watcherEnabled = true
        watcherTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            self?.scanActiveTab(manual: false)
        }
        rebuildMenu()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { [weak self] in self?.scanActiveTab(manual: false) }
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        let heading = NSMenuItem(title: watcherEnabled ? "Watching Chrome for job listings" : "Job listing watcher paused", action: nil, keyEquivalent: "")
        heading.isEnabled = false
        menu.addItem(heading)
        let last = NSMenuItem(title: lastResultText, action: nil, keyEquivalent: "")
        last.isEnabled = false
        menu.addItem(last)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Scan current Chrome tab", action: #selector(scanNow), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "Fill empty application fields…", action: #selector(fillApplicationFields), keyEquivalent: "f"))
        menu.addItem(NSMenuItem(title: watcherEnabled ? "Pause background matching" : "Resume background matching", action: #selector(toggleWatcher), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Apply Desk workspace", action: #selector(openDashboard), keyEquivalent: "o"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Apply Desk", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
    }

    private func scanActiveTab(manual: Bool) {
        guard watcherEnabled || manual else { return }
        guard let tab = readActiveTabIdentity() else {
            if !browserPermissionError.isEmpty {
                if manual { showChromePermissionHelp() } else { pauseForChromePermission() }
            } else if manual {
                showMessage("Open a Chrome job listing", detail: "Apply Desk scans the active tab in Google Chrome.")
            }
            return
        }
        let url = tab.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = url + "\n" + tab.title
        guard !url.isEmpty, (manual || key != lastTabKey), (manual || isJobListingURL(url)) else { return }
        lastTabKey = key
        guard manual || !processedTabs.contains(key) else { return }
        guard let page = readActiveTabContents() else {
            if manual { showChromePermissionHelp() }
            else { pauseForChromePermission() }
            return
        }
        let text = String(page.description.prefix(50_000)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 300, looksLikeJobPosting(text) else {
            if manual { showMessage("This tab doesn’t look like a job listing yet", detail: "Open the full job description, then choose Scan current Chrome tab.") }
            else {
                let attempts = (pageLoadAttempts[key] ?? 0) + 1
                pageLoadAttempts[key] = attempts
                if attempts < 4 { lastTabKey = "" }
            }
            return
        }
        pageLoadAttempts.removeValue(forKey: key)
        processedTabs.insert(key)
        evaluate(page: page, url: url)
    }

    private func isJobListingURL(_ value: String) -> Bool {
        let lower = value.lowercased()
        if lower.contains("/apply") || lower.contains("/signin") || lower.contains("/sign-in") || lower.contains("/login") { return false }
        let patterns = ["/jobs/", "/job/", "/careers/", "/position/", "/openings/", "job-detail", "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "smartrecruiters.com", "linkedin.com/jobs", "indeed.com/viewjob", "simplify.jobs", "careers.", "jobs."]
        return patterns.contains(where: lower.contains)
    }

    private func looksLikeJobPosting(_ value: String) -> Bool {
        let lower = value.lowercased()
        let roleTerms = ["intern", "software engineer", "backend", "data engineer", "new grad", "developer", "machine learning"]
        let contentTerms = ["responsibilities", "qualifications", "what you’ll do", "what you'll do", "requirements", "apply now"]
        return roleTerms.contains(where: lower.contains) && contentTerms.contains(where: lower.contains)
    }

    private func readActiveTabIdentity() -> (url: String, title: String)? {
        let script = """
        tell application "Google Chrome"
            if not running then return ""
            if (count of windows) is 0 then return ""
            set currentTab to active tab of front window
            return (URL of currentTab) & linefeed & (title of currentTab)
        end tell
        """
        guard let result = runAppleScript(script), let value = result.stringValue else { return nil }
        let parts = value.components(separatedBy: "\n")
        guard let url = parts.first, !url.isEmpty else { return nil }
        return (url, parts.dropFirst().joined(separator: "\n"))
    }

    private struct PageContent {
        let url: String
        let title: String
        let roleTitle: String
        let company: String
        let description: String
    }

    private func readActiveTabContents() -> PageContent? {
        let script = #"""
        tell application "Google Chrome"
            if not running then return ""
            if (count of windows) is 0 then return ""
            set currentTab to active tab of front window
            return execute currentTab javascript "JSON.stringify({url:location.href,title:document.title,roleTitle:(document.querySelector('h1')||{}).innerText||document.title,company:(document.querySelector(\"meta[property='og:site_name']\")||{}).content||'',description:document.body?document.body.innerText:''})"
        end tell
        """#
        guard let result = runAppleScript(script), let value = result.stringValue,
              let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return PageContent(url: object["url"] as? String ?? "", title: object["title"] as? String ?? "",
                           roleTitle: object["roleTitle"] as? String ?? "", company: object["company"] as? String ?? "",
                           description: object["description"] as? String ?? "")
    }

    private func executePageJavaScript(_ source: String) -> String? {
        let encoded = Data(source.utf8).base64EncodedString()
        let script = """
        tell application "Google Chrome"
            if not running then return ""
            if (count of windows) is 0 then return ""
            set currentTab to active tab of front window
            set jsSource to "eval(atob('\(encoded)'))"
            return execute currentTab javascript jsSource
        end tell
        """
        return runAppleScript(script)?.stringValue
    }

    private func runAppleScript(_ source: String) -> NSAppleEventDescriptor? {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return nil }
        let result = script.executeAndReturnError(&error)
        if let error = error {
            let message = String(describing: error[NSAppleScript.errorMessage])
            browserPermissionError = message
            if message.localizedCaseInsensitiveContains("JavaScript") && message.localizedCaseInsensitiveContains("turned off") {
                return nil
            }
            NSLog("Apply Desk AppleScript error: %@", message)
            return nil
        }
        browserPermissionError = ""
        return result
    }

    private func evaluate(page: PageContent, url: String) {
        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: String] = ["url": url, "title": String(page.roleTitle.prefix(200)),
                                         "company": String(page.company.prefix(200)),
                                         "description": String(page.description.prefix(50_000))]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        request.httpBody = body
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self = self else { return }
            guard error == nil, let data = data,
                  let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let jobID = result["saved_job_id"] as? Int else {
                DispatchQueue.main.async { self.lastResultText = "Could not reach the local matcher"; self.rebuildMenu() }
                return
            }
            let score = result["fit_score"] as? Int ?? 0
            let resumeLoaded = result["resume_loaded"] as? Bool ?? false
            let title = result["title"] as? String ?? page.roleTitle
            DispatchQueue.main.async {
                self.lastResultText = resumeLoaded ? "\(score)% fit · \(title.prefix(46))" : "Resume needed · \(title.prefix(42))"
                self.rebuildMenu()
                if !resumeLoaded || score >= 60 {
                    let reviewURL = URL(string: "http://127.0.0.1:8787/job/\(jobID)")!
                    NSWorkspace.shared.open(reviewURL)
                }
            }
        }.resume()
    }

    private func pauseForChromePermission() {
        watcherEnabled = false
        watcherTimer?.invalidate()
        watcherTimer = nil
        rebuildMenu()
        showChromePermissionHelp()
    }

    private func showChromePermissionHelp() {
        guard !showingPermissionAlert else { return }
        showingPermissionAlert = true
        let alert = NSAlert()
        alert.messageText = "Allow Apply Desk to read the current job tab"
        if browserPermissionError.localizedCaseInsensitiveContains("not authorized") || browserPermissionError.contains("-1743") {
            alert.informativeText = "macOS blocked Apply Desk from controlling Chrome. Open System Settings → Privacy & Security → Automation and allow Apply Desk to control Google Chrome. Then resume matching from the Apply Desk menu bar icon."
        } else {
            alert.informativeText = "Chrome protects page text from background apps. In Chrome, choose View → Developer → Allow JavaScript from Apple Events. macOS may also ask you to allow Apply Desk to control Chrome. Then resume matching from the Apply Desk menu bar icon. Apply Desk reads the active tab locally."
        }
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Got it")
        alert.runModal()
        showingPermissionAlert = false
    }

    private func showMessage(_ title: String, detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}
