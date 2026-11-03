import Foundation

/// Runs the form filler (autofill.js, bundled with the app) in Chrome's front
/// tab. The filler fills only empty fields from the user's own profile, saved
/// answers, resume, and tailored skills; it never submits. It keeps working
/// after it starts (dropdowns, search pickers, added blocks), so the app polls
/// `window.__applyDeskFill` until it reports done.
enum Autofill {
    struct Result {
        let done: Bool
        let fields: [String]
        let attached: Bool
        let blocks: Int
        let learned: [[String: String]]
        let embeddedForm: URL?
        let error: String?
    }

    static let statusScript = "JSON.stringify(window.__applyDeskFill || null)"

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
        return Result(done: object["done"] as? Bool ?? false, fields: object["filled"] as? [String] ?? [],
                      attached: object["attached"] as? Bool ?? false, blocks: object["blocks"] as? Int ?? 0,
                      learned: learned, embeddedForm: embedded, error: object["error"] as? String)
    }
}
