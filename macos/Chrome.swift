import AppKit

/// Reads and fills the active Google Chrome tab through Apple Events.
/// Chrome needs View → Developer → Allow JavaScript from Apple Events.
@MainActor
enum Chrome {
    static let bundleID = "com.google.Chrome"

    enum Failure {
        case notAuthorized, javaScriptOff, other
    }

    /// Why the most recent Apple Events call failed, if it did.
    static private(set) var lastFailure: Failure?

    struct Page {
        let url: String
        let roleTitle: String
        let company: String
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

    /// URL and title of the front tab, without reading the page.
    static func activeTab() -> (url: String, title: String)? {
        guard isRunning else { return nil }
        let script = """
        tell application id "\(bundleID)"
            if (count of windows) is 0 then return ""
            set currentTab to active tab of front window
            return (URL of currentTab) & linefeed & (title of currentTab)
        end tell
        """
        guard let value = run(script), !value.isEmpty else { return nil }
        let parts = value.components(separatedBy: "\n")
        guard let url = parts.first, !url.isEmpty else { return nil }
        return (url, parts.dropFirst().joined(separator: "\n"))
    }

    nonisolated static let readPageScript = "JSON.stringify({url:location.href,roleTitle:(document.querySelector('h1')||{}).innerText||document.title,company:(document.querySelector(\"meta[property='og:site_name']\")||{}).content||'',description:document.body?document.body.innerText:''})"

    static func readPage() -> Page? {
        guard let value = runJavaScript(readPageScript), let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return Page(url: object["url"] as? String ?? "", roleTitle: object["roleTitle"] as? String ?? "",
                    company: object["company"] as? String ?? "", description: object["description"] as? String ?? "")
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

    static func looksLikePosting(_ value: String) -> Bool {
        let lower = value.lowercased()
        let roleTerms = ["intern", "engineer", "developer", "new grad", "machine learning", "analyst", "scientist"]
        let contentTerms = ["responsibilities", "qualifications", "what you’ll do", "what you'll do", "requirements", "apply now", "about the role"]
        return roleTerms.contains(where: lower.contains) && contentTerms.contains(where: lower.contains)
    }
}
