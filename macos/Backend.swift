import Foundation
import Security

/// Runs the bundled Flask service that keeps the profile, resume versions,
/// and saved roles. It listens on 127.0.0.1 only and requires a private token,
/// so other software on this Mac can't read the profile through the port.
@MainActor
final class Backend {
    // APPLY_DESK_PORT and APPLY_DESK_DATA match app.py; they let a test copy run
    // beside the installed app without touching its data.
    static let port = Int(ProcessInfo.processInfo.environment["APPLY_DESK_PORT"] ?? "") ?? 8787
    let baseURL = URL(string: "http://127.0.0.1:\(Backend.port)/")!
    let dataDirectory: URL
    let token: String
    /// Called when a service that was running stops and can't be restarted.
    var onFailure: (() -> Void)?
    private var process: Process?
    private var stopping = false
    private var wasHealthy = false
    private var restarts = 0

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dataDirectory = ProcessInfo.processInfo.environment["APPLY_DESK_DATA"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? support.appendingPathComponent("Apply Desk", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        token = Backend.loadToken(in: dataDirectory)
    }

    /// A workspace URL; an empty path is the Today page.
    func url(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL
    }

    /// Sends a request to the local service; `completion` runs on the main queue
    /// with the decoded JSON object, or nil when the request failed.
    func send(_ path: String, json: [String: Any]? = nil, timeout: TimeInterval = 15, completion: @escaping @MainActor ([String: Any]?) -> Void) {
        var request = URLRequest(url: url(path))
        request.timeoutInterval = timeout
        request.setValue(token, forHTTPHeaderField: "X-Apply-Desk-Token")
        if let json = json {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let succeeded = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            let object = succeeded ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } : nil
            DispatchQueue.main.async { completion(object) }
        }.resume()
    }

    /// Reuses a running service from this install, or starts the bundled one.
    func start(ready: @escaping @MainActor (Bool) -> Void) {
        stopping = false
        send("api/health") { [weak self] health in
            guard let self = self else { return }
            if health?["protected"] as? Bool == true {
                self.wasHealthy = true
                ready(true)
                return
            }
            if health != nil || self.portIsBusy() { self.stopOlderService() }
            guard self.launch() else { ready(false); return }
            self.waitForHealth(attemptsLeft: 100, ready: ready)
        }
    }

    func stop() {
        stopping = true
        guard let process = process, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(1.5)
        while process.isRunning && Date() < deadline { usleep(30_000) }
    }

    private func waitForHealth(attemptsLeft: Int, ready: @escaping @MainActor (Bool) -> Void) {
        send("api/health") { [weak self] health in
            guard let self = self else { return }
            if health != nil {
                self.wasHealthy = true
                self.restarts = 0
                ready(true)
            } else if attemptsLeft <= 0 || self.process?.isRunning != true {
                ready(false)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    self.waitForHealth(attemptsLeft: attemptsLeft - 1, ready: ready)
                }
            }
        }
    }

    private func launch() -> Bool {
        guard let resources = Bundle.main.resourceURL else { return false }
        let backend = resources.appendingPathComponent("backend", isDirectory: true)
        let python = Bundle.main.object(forInfoDictionaryKey: "ApplyDeskPython") as? String ?? "/usr/bin/python3"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["-s", backend.appendingPathComponent("app.py").path]
        process.currentDirectoryURL = dataDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONPATH"] = backend.appendingPathComponent("site-packages").path
        // Cache compiled Python outside the signed bundle so later launches start fast.
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        environment["PYTHONPYCACHEPREFIX"] = caches.appendingPathComponent("Apply Desk/pycache").path
        environment.removeValue(forKey: "PYTHONDONTWRITEBYTECODE")
        environment["PYTHONUNBUFFERED"] = "1"
        environment["APPLY_DESK_DATA"] = dataDirectory.path
        environment["APPLY_DESK_TOKEN"] = token
        environment["APPLY_DESK_PORT"] = String(Backend.port)
        // PDFKit's word spacing, used to repair words pypdf glues together.
        if let pdftext = Bundle.main.url(forAuxiliaryExecutable: "pdftext") {
            environment["APPLY_DESK_PDFTEXT"] = pdftext.path
        }
        process.environment = environment
        if let log = openLog() {
            process.standardOutput = log
            process.standardError = log
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.processExited() }
        }
        do {
            try process.run()
        } catch {
            NSLog("Apply Desk couldn't start its local service: %@", error.localizedDescription)
            return false
        }
        self.process = process
        return true
    }

    private func processExited() {
        guard !stopping, wasHealthy else { return }
        guard restarts < 3 else { onFailure?(); return }
        restarts += 1
        NSLog("Apply Desk service stopped; restarting (attempt %d)", restarts)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self = self, !self.stopping, self.launch() else { return }
            self.waitForHealth(attemptsLeft: 100) { [weak self] healthy in if !healthy { self?.onFailure?() } }
        }
    }

    private func openLog() -> FileHandle? {
        let log = dataDirectory.appendingPathComponent("app.log")
        let manager = FileManager.default
        if let size = (try? manager.attributesOfItem(atPath: log.path))?[.size] as? NSNumber, size.intValue > 2_000_000 {
            try? manager.removeItem(at: log)
        }
        if !manager.fileExists(atPath: log.path) { manager.createFile(atPath: log.path, contents: nil) }
        let handle = try? FileHandle(forWritingTo: log)
        handle?.seekToEndOfFile()
        return handle
    }

    private func portIsBusy() -> Bool {
        !(Backend.run("/usr/sbin/lsof", ["-ti", "tcp:\(Backend.port)", "-sTCP:LISTEN"]) ?? "").isEmpty
    }

    /// An Apply Desk service started from Terminal by an older version may
    /// still hold the port. Stop it only if it is an Apply Desk `app.py`.
    private func stopOlderService() {
        let pids = Backend.run("/usr/sbin/lsof", ["-ti", "tcp:\(Backend.port)", "-sTCP:LISTEN"]) ?? ""
        for pid in pids.split(separator: "\n").compactMap({ Int32($0.trimmingCharacters(in: .whitespaces)) }) {
            let command = Backend.run("/bin/ps", ["-o", "command=", "-p", String(pid)]) ?? ""
            if command.contains("app.py") {
                NSLog("Apply Desk is stopping an older local service (pid %d)", pid)
                kill(pid, SIGTERM)
            }
        }
        usleep(500_000)
    }

    private static func run(_ executable: String, _ arguments: [String]) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A random secret shared by the window and the service, kept with the data.
    private static func loadToken(in directory: URL) -> String {
        let file = directory.appendingPathComponent(".session-token")
        if let saved = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), saved.count >= 32 {
            return saved
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let value = bytes.map { String(format: "%02x", $0) }.joined()
        try? value.write(to: file, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return value
    }
}
