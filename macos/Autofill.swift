import Foundation

/// Runs the form filler (autofill.js, bundled with the app) in Chrome's front
/// tab. The filler fills only empty fields from the user's own profile, saved
/// answers, resume, and tailored skills; it never submits. On multi-step
/// applications it fills each page, presses Save and Continue, and stops at a
/// page that needs the user or at Review, where it shows its review panel. It
/// keeps working after it starts, so the app polls `window.__applyDeskFill`
/// until it reports done.
enum Autofill {
    struct Result {
        let done: Bool
        let fields: [String]
        let attached: Bool
        let blocks: Int
        let learned: [[String: String]]
        let embeddedForm: URL?
        let error: String?
        /// Why the run ended: "review", "needs", "errors", "signin", "stopped", "stuck", "limit", or "end" (no next step).
        let stop: String
        let page: String
        let needs: [String]
        /// Everything filled in this run, every page: page, question, value, flag.
        let items: [[String: String]]
        let pages: [String]
        let checks: Int
        let run: String
        let advancing: Bool
        /// Waiting on the page for the user to answer what Apply Desk couldn't.
        let waiting: Bool
        let beat: Int
    }

    static let statusScript = "JSON.stringify(window.__applyDeskFill || null)"
    /// Asks a running fill to stop after the page it's on.
    static let stopScript = "window.__applyDeskStop = true; 'stopping'"

    /// The filler plus the call that starts it. `plan` is GET /api/fill-plan.
    static func script(plan: Data, resume: (name: String, pdf: Data)? = nil, source: String? = nil) -> String? {
        guard let filler = source ?? Bundle.main.url(forResource: "autofill", withExtension: "js").flatMap({ try? String(contentsOf: $0, encoding: .utf8) }) else {
            return nil
        }
        let name = Data((resume?.name ?? "").utf8).base64EncodedString()
        return filler + "\napplyDeskFill('\(plan.base64EncodedString())', '\(resume?.pdf.base64EncodedString() ?? "")', '\(name)')"
    }

    static func parse(_ output: String?) -> Result? {
        guard let data = output?.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let embedded = (object["embedded"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
        let learned = (object["learn"] as? [[String: Any]] ?? []).compactMap { item -> [String: String]? in
            guard let question = item["question"] as? String, let answer = item["answer"] as? String else { return nil }
            return ["question": question, "answer": answer]
        }
        let items = (object["items"] as? [[String: Any]] ?? []).map { $0.compactMapValues { $0 as? String } }
        return Result(done: object["done"] as? Bool ?? false, fields: object["filled"] as? [String] ?? [],
                      attached: object["attached"] as? Bool ?? false, blocks: object["blocks"] as? Int ?? 0,
                      learned: learned, embeddedForm: embedded, error: object["error"] as? String,
                      stop: object["stop"] as? String ?? "", page: object["page"] as? String ?? "", needs: object["needs"] as? [String] ?? [],
                      items: items, pages: object["pages"] as? [String] ?? [], checks: object["checks"] as? Int ?? 0,
                      run: object["run"] as? String ?? "", advancing: object["advancing"] as? Bool ?? false,
                      waiting: object["waiting"] as? Bool ?? false, beat: object["beat"] as? Int ?? 0)
    }
}
