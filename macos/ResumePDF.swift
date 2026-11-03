import AppKit
import PDFKit
import WebKit

/// Renders a resume in Jake's layout (templates/resume_print.html) to a
/// Letter-size PDF without showing anything on screen. Each 612×792 page of
/// the print page becomes one PDF page with selectable, ATS-readable text.
@MainActor
final class ResumePDF: NSObject, WKNavigationDelegate {
    struct Output {
        let pdf: Data
        let pages: Int
    }

    private let backend: Backend
    private var window: NSWindow?
    private var webView: WKWebView?
    private var completion: ((Output?) -> Void)?
    private var timeout: DispatchWorkItem?

    init(backend: Backend) {
        self.backend = backend
    }

    /// Renders the resume tuned for `jobID`, or the base resume when nil.
    func make(jobID: Int?, completion: @escaping (Output?) -> Void) {
        finish(nil)
        self.completion = completion
        // Shares the workspace's cookie store, so the token cookie applies.
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 612, height: 792), configuration: WKWebViewConfiguration())
        view.navigationDelegate = self
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 612, height: 792), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        self.window = window
        webView = view
        let work = DispatchWorkItem { [weak self] in self?.finish(nil) }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
        view.load(URLRequest(url: backend.url(jobID.map { "job/\($0)/resume/print" } ?? "resume/print")))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitForLayout(attempts: 50)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil) }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil) }

    private func waitForLayout(attempts: Int) {
        webView?.evaluateJavaScript("document.body && document.body.dataset.ready === '1' ? Number(document.body.dataset.pages) : 0") { [weak self] value, _ in
            guard let self = self else { return }
            let pages = (value as? NSNumber)?.intValue ?? 0
            if pages > 0 {
                self.capture(pages: pages)
            } else if attempts > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForLayout(attempts: attempts - 1) }
            } else {
                self.finish(nil)
            }
        }
    }

    private func capture(pages: Int) {
        guard let webView = webView else { return finish(nil) }
        let height = CGFloat(792 * pages)
        window?.setContentSize(NSSize(width: 612, height: height))
        webView.frame = NSRect(x: 0, y: 0, width: 612, height: height)
        let document = PDFDocument()
        func page(_ index: Int) {
            guard index < pages else {
                guard let data = document.dataRepresentation() else { return finish(nil) }
                return finish(Output(pdf: data, pages: pages))
            }
            let configuration = WKPDFConfiguration()
            configuration.rect = CGRect(x: 0, y: CGFloat(792 * index), width: 612, height: 792)
            webView.createPDF(configuration: configuration) { [weak self] result in
                guard let self = self else { return }
                guard case .success(let data) = result, let single = PDFDocument(data: data), let first = single.page(at: 0) else {
                    return self.finish(nil)
                }
                document.insert(first, at: document.pageCount)
                page(index + 1)
            }
        }
        page(0)
    }

    private func finish(_ output: Output?) {
        timeout?.cancel()
        timeout = nil
        webView?.navigationDelegate = nil
        webView = nil
        window?.contentView = nil
        window = nil
        let callback = completion
        completion = nil
        callback?(output)
    }
}
