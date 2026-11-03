import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// The main window: the local workspace drawn over native sidebar vibrancy,
/// with no browser chrome. Links to other sites open in Chrome.
@MainActor
final class WorkspaceWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    var onAction: ((String, [String: Any]) -> Void)?
    var onVisibilityChange: ((Bool) -> Void)?
    var onDownload: ((URL) -> Void)?
    var isVisible: Bool { window.isVisible }

    private let backend: Backend
    private let window: NSWindow
    private let webView: WKWebView
    private let splashModel = SplashModel()
    private let splash: NSView
    private var ready = false
    private var pendingPath = ""
    private var nativeState: [String: Any] = [:]
    private var downloads: [ObjectIdentifier: URL] = [:]

    init(backend: Backend) {
        self.backend = backend
        let configuration = WKWebViewConfiguration()
        configuration.preferences.isElementFullscreenEnabled = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = true
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Apply Desk"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.toolbar = NSToolbar(identifier: "ApplyDesk.Window")
        window.toolbarStyle = .unified
        window.minSize = NSSize(width: 940, height: 640)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("ApplyDeskWorkspace")

        let vibrancy = NSVisualEffectView()
        vibrancy.material = .sidebar
        vibrancy.blendingMode = .behindWindow
        vibrancy.state = .followsWindowActiveState
        window.contentView = vibrancy
        webView.frame = vibrancy.bounds
        vibrancy.addSubview(webView)
        splash = NSHostingView(rootView: SplashView(model: splashModel))
        splash.frame = vibrancy.bounds
        splash.autoresizingMask = [.width, .height]
        vibrancy.addSubview(splash)

        super.init()
        configuration.userContentController.add(MessageProxy(self), name: "applyDesk")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.delegate = self
    }

    /// Shows the window, optionally at a workspace path such as "job/3".
    func show(path: String? = nil) {
        if let path = path {
            if ready { load(path) } else { pendingPath = path }
        }
        onVisibilityChange?(true)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// The service is up: hand the window its token cookie and load the page.
    func serviceReady() {
        splashModel.phase = .starting
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: "127.0.0.1", .path: "/", .name: "apply_desk_token", .value: backend.token,
            .expires: Date().addingTimeInterval(365 * 24 * 3600),
        ]
        properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
        guard let cookie = HTTPCookie(properties: properties) else { return }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            guard let self = self else { return }
            self.ready = true
            self.load(self.pendingPath)
        }
    }

    func serviceFailed(retry: @escaping () -> Void) {
        ready = false
        splashModel.retry = retry
        splashModel.phase = .failed("The local service didn't respond. Your data is safe in ~/Library/Application Support/Apply Desk. Details are in app.log there.")
        splash.isHidden = false
        splash.alphaValue = 1
    }

    func pushState(_ state: [String: Any]) {
        nativeState = state
        guard ready, let data = try? JSONSerialization.data(withJSONObject: state),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.ApplyDesk && window.ApplyDesk.native(\(json))")
    }

    func reload() { if ready { webView.reload() } }
    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }

    private func load(_ path: String) {
        webView.load(URLRequest(url: backend.url(path)))
    }

    private func isWorkspace(_ url: URL) -> Bool {
        url.host == "127.0.0.1" && url.port == Backend.port
    }

    private func openOutside(_ url: URL) {
        if url.scheme == "http" || url.scheme == "https" { Chrome.open(url) }
        else if url.scheme == "mailto" { NSWorkspace.shared.open(url) }
    }

    // MARK: Window

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Closing hides the window; Apply Desk keeps watching from the menu bar.
        window.orderOut(nil)
        onVisibilityChange?(false)
        return false
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if isWorkspace(url) || url.scheme == "about" { return decisionHandler(.allow) }
        decisionHandler(.cancel)
        openOutside(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let download = disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType
        decisionHandler(download ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !nativeState.isEmpty { pushState(nativeState) }
        guard !splash.isHidden else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.45
            splash.animator().alphaValue = 0
        }, completionHandler: { [weak self] in self?.splash.isHidden = true })
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isWorkspace(url) { webView.load(navigationAction.request) } else { openOutside(url) }
        }
        return nil
    }

    // MARK: Panels the page can ask for

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Choose your resume (PDF, DOCX, TXT, or LaTeX)"
        panel.allowedContentTypes = [UTType.pdf, UTType.plainText] + ["docx", "tex"].compactMap { UTType(filenameExtension: $0) }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    // MARK: Downloads (tuned resumes and review notes)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).deletingPathExtension
        let ext = (suggestedFilename as NSString).pathExtension
        var target = folder.appendingPathComponent(suggestedFilename)
        var copy = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(name) \(copy)").appendingPathExtension(ext)
            copy += 1
        }
        downloads[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { onDownload?(url) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        NSLog("Apply Desk download failed: %@", error.localizedDescription)
    }

    // MARK: Messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        onAction?(action, body)
    }
}

/// Breaks the retain cycle between WKUserContentController and its handler.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

final class SplashModel: ObservableObject {
    enum Phase: Equatable { case starting, failed(String) }
    @Published var phase: Phase = .starting
    var retry: () -> Void = {}
}

/// Shown over native vibrancy while the local service starts.
private struct SplashView: View {
    @ObservedObject var model: SplashModel

    var body: some View {
        VStack(spacing: 18) {
            OrbView().frame(width: 112, height: 112)
            switch model.phase {
            case .starting:
                Text("Apply Desk").font(.system(size: 20, weight: .bold, design: .default))
                Text("Opening your private workspace…").font(.system(size: 13)).foregroundStyle(.secondary)
            case .failed(let message):
                Text("Apply Desk couldn't start").font(.system(size: 20, weight: .bold))
                Text(message).font(.system(size: 13)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 380)
                Button("Try Again") {
                    model.phase = .starting
                    model.retry()
                }
                .buttonStyle(.borderedProminent).tint(.deskIndigo).controlSize(.large)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
