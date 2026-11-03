import AppKit
import Carbon

/// Reads and fills the active Google Chrome tab through Apple Events.
/// Chrome needs View → Developer → Allow JavaScript from Apple Events.
@MainActor
enum Chrome {
    nonisolated static let bundleID = "com.google.Chrome"

    enum Failure {
        case notAuthorized, javaScriptOff, other
    }

    /// Why the most recent Apple Events call failed, if it did.
    static private(set) var lastFailure: Failure?

    struct Page {
        let url: String
        let ready: Bool
        /// Title and company hints for /api/evaluate (see applying.identify_role).
        let signals: [String: String]
        let description: String
    }

    static var isRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    static func activate() {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first?.activate()
    }

    static func open(_ url: URL) {
        if let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// The tab the user is looking at: the active tab of Chrome's front window.
    struct Tab {
        let id: String
        let url: String
        let title: String
        let loading: Bool
    }

    /// Whether macOS lets Apply Desk send Apple Events to Chrome (Automation).
    enum Access {
        case granted, notAsked, denied, notRunning
    }

    /// Checks Automation permission for Chrome. With `ask`, macOS shows its
    /// "Apply Desk wants access to control Google Chrome" prompt when it has
    /// not been answered yet; that call blocks, so run it off the main thread.
    nonisolated static func automationAccess(ask: Bool) -> Access {
        var target = AEAddressDesc()
        let identifier = Data(bundleID.utf8)
        let created = identifier.withUnsafeBytes { AECreateDesc(typeApplicationBundleID, $0.baseAddress, identifier.count, &target) }
        guard created == noErr else { return .notRunning }
        defer { AEDisposeDesc(&target) }
        switch AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, ask) {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(procNotFound): return .notRunning
        default: return .notAsked
        }
    }

    /// True when Chrome is the app in front, so its active tab is what the user sees.
    static var isFrontmost: Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID
    }

    /// Identity of the front tab, without reading the page.
    static func activeTab() -> Tab? {
        guard isRunning else { return nil }
        let script = """
        tell application id "\(bundleID)"
            if (count of windows) is 0 then return ""
            set currentTab to active tab of front window
            return ((id of currentTab) as text) & linefeed & ((loading of currentTab) as text) & linefeed & (URL of currentTab) & linefeed & (title of currentTab)
        end tell
        """
        guard let value = run(script), !value.isEmpty else { return nil }
        let parts = value.components(separatedBy: "\n")
        guard parts.count >= 3, !parts[2].isEmpty else { return nil }
        return Tab(id: parts[0], url: parts[2], title: parts.dropFirst(3).joined(separator: "\n"), loading: parts[1] == "true")
    }

    /// Reads the posting plus every hint about its title and company: the
    /// structured JobPosting data many sites embed, Workday's job header,
    /// headings, and the page and Open Graph titles.
    nonisolated static let readPageScript = """
    (() => {
      const q = s => document.querySelector(s);
      const text = el => el ? (el.innerText || el.textContent || '').trim() : '';
      const meta = s => (q(s) || {}).content || '';
      let ld = {};
      for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(tag.textContent);
          for (const item of [].concat(data && data['@graph'] ? data['@graph'] : data)) {
            if (item && /JobPosting/i.test([].concat(item['@type']).join(' '))) {
              const org = item.hiringOrganization;
              ld = {title: item.title || '', company: typeof org === 'string' ? org : (org && org.name) || ''};
            }
          }
        } catch (error) {}
      }
      return JSON.stringify({url: location.href, ready: document.readyState, page_title: document.title,
        og_title: meta('meta[property="og:title"]'), site_name: meta('meta[property="og:site_name"]'),
        heading: text(q('[data-automation-id="jobPostingHeader"]')) || text(q('.posting-headline h2')) || text(q('h1')),
        ld_title: ld.title || '', ld_company: ld.company || '', description: document.body ? document.body.innerText : ''});
    })()
    """

    static func readPage() -> Page? {
        guard let value = runJavaScript(readPageScript), let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return Page(url: object["url"] as? String ?? "", ready: object["ready"] as? String == "complete",
                    signals: object.compactMapValues { $0 as? String }.filter { $0.key != "description" && $0.key != "ready" },
                    description: object["description"] as? String ?? "")
    }

    /// Runs JavaScript in the front tab and returns its string result.
    static func runJavaScript(_ source: String) -> String? {
        guard isRunning else { return nil }
        // Passed as an AppleScript string literal, not eval(), so pages with a
        // strict Content Security Policy still run it.
        let script = """
        tell application id "\(bundleID)"
            if (count of windows) is 0 then return ""
            return execute active tab of front window javascript "\(appleScriptLiteral(source))"
        end tell
        """
        return run(script)
    }

    /// Escapes text for use inside an AppleScript "…" string literal.
    nonisolated static func appleScriptLiteral(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
    }

    private static func run(_ source: String) -> String? {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return nil }
        let result = script.executeAndReturnError(&error)
        guard let error = error else {
            lastFailure = nil
            return result.stringValue
        }
        let message = error[NSAppleScript.errorMessage] as? String ?? ""
        let number = error[NSAppleScript.errorNumber] as? Int ?? 0
        if number == -1743 || message.localizedCaseInsensitiveContains("not authorized") {
            lastFailure = .notAuthorized
        } else if message.localizedCaseInsensitiveContains("JavaScript") {
            lastFailure = .javaScriptOff
        } else {
            lastFailure = .other
            NSLog("Apply Desk Chrome script error %d: %@", number, message)
        }
        return nil
    }
}

/// Cheap checks that keep Apply Desk from reading pages that aren't job listings.
enum JobListing {
    static func isLikelyURL(_ value: String) -> Bool {
        let lower = value.lowercased()
        if ["/apply", "/signin", "/sign-in", "/login"].contains(where: lower.contains) { return false }
        let patterns = ["/jobs/", "/job/", "/careers/", "/position/", "/openings/", "job-detail", "greenhouse.io", "lever.co",
                        "ashbyhq.com", "myworkdayjobs.com", "smartrecruiters.com", "linkedin.com/jobs", "indeed.com/viewjob",
                        "simplify.jobs", "careers.", "jobs.", "workatastartup.com", "wellfound.com"]
        return patterns.contains(where: lower.contains)
    }

    /// Pages where the one-key fill shortcut is live: job boards, careers
    /// sites, and application systems. Elsewhere the key types normally.
    static func mayHaveApplication(_ value: String) -> Bool {
        let lower = value.lowercased()
        let hints = ["apply", "application", "career", "job", "greenhouse", "lever.co", "ashbyhq", "workday", "smartrecruiters", "icims",
                     "jobvite", "taleo", "successfactors", "bamboohr", "workable", "recruitee", "breezy", "jazzhr", "rippling", "paylocity",
                     "ultipro", "dayforce", "handshake", "wellfound", "indeed", "simplify", "talent", "recruit", "hiring", "position",
                     "opening", "vacanc", "intern"]
        return hints.contains(where: lower.contains)
    }

    static func looksLikePosting(_ value: String) -> Bool {
        let lower = value.lowercased()
        let roleTerms = ["intern", "engineer", "developer", "new grad", "machine learning", "analyst", "scientist"]
        let contentTerms = ["responsibilities", "qualifications", "what you’ll do", "what you'll do", "requirements", "apply now", "about the role"]
        return roleTerms.contains(where: lower.contains) && contentTerms.contains(where: lower.contains)
    }
}
