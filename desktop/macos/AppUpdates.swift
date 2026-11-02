import Cocoa

final class AppUpdates {
    var onStatus: (([String: Any]) -> Void)?
    var canRestart: ((@escaping (Bool) -> Void) -> Void)?
    var setInstallLock: ((Bool) -> Void)?
    private let resources: URL
    private let python: URL
    private let application = Bundle.main.bundleURL
    private let state: URL
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.1.0"
    private let arch = Bundle.main.object(forInfoDictionaryKey: "DashboardArchitecture") as? String ?? ""
    private var phase = "idle"
    private var message = "启动时及每 6 小时自动检查，有新版时自动安装。"
    private var latestVersion: String?
    private var checking = false
    private var stopped = false
    private var manualInstall = false
    private var readyJob: URL?
    private var preparation: Process?
    private var handoff: Process?
    private var interval: Timer?
    private var retry: Timer?

    init(resources: URL, python: URL) {
        self.resources = resources
        self.python = python
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        state = support.appendingPathComponent("com.jiangyu3761.integrated-marketing-dashboard/Updates", isDirectory: true)
    }

    var automatic: Bool {
        if UserDefaults.standard.object(forKey: "automaticUpdates") == nil { return true }
        return UserDefaults.standard.bool(forKey: "automaticUpdates")
    }

    func status() -> [String: Any] {
        var value: [String: Any] = ["version": version, "automatic": automatic, "phase": phase, "message": message, "busy": checking]
        if let latestVersion = latestVersion { value["latestVersion"] = latestVersion }
        if let checkedAt = UserDefaults.standard.object(forKey: "lastUpdateCheck") as? Date {
            value["checkedAt"] = ISO8601DateFormatter().string(from: checkedAt)
        }
        return value
    }

    private func emit(_ phase: String, _ message: String) {
        self.phase = phase
        self.message = message
        onStatus?(status())
    }

    func start() {
        if let data = try? Data(contentsOf: state.appendingPathComponent("last-result.json")),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let text = value["message"] as? String {
            emit(value["phase"] as? String ?? "idle", text)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self, self.automatic else { return }
            self.check(manual: false)
        }
        interval = Timer.scheduledTimer(withTimeInterval: 6 * 60 * 60, repeats: true) { [weak self] _ in
            guard let self = self, self.automatic else { return }
            self.check(manual: false)
        }
    }

    func setAutomatic(_ enabled: Bool) {
        guard phase != "installing" else { return }
        UserDefaults.standard.set(enabled, forKey: "automaticUpdates")
        if enabled {
            check(manual: false)
        } else {
            retry?.invalidate()
            emit(readyJob == nil ? "idle" : "ready", readyJob == nil ? "自动更新已关闭，可手动检查并安装。" : "新版已下载，点击“检查更新”可安装。")
        }
    }

    func check(manual: Bool) {
        guard !stopped, !checking, phase != "installing" else { return }
        if let _ = readyJob {
            manualInstall = manualInstall || manual
            attemptInstall()
            return
        }
        checking = true
        manualInstall = manual
        latestVersion = nil
        emit("checking", "正在检查更新并准备安装包…")
        let process = Process()
        let output = Pipe()
        let os = ProcessInfo.processInfo.operatingSystemVersion
        process.executableURL = python
        process.arguments = [resources.appendingPathComponent("updater.py").path, "prepare",
                             "--app", application.path, "--state", state.path,
                             "--arch", arch, "--os-version", "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"] + (manual ? ["--manual"] : [])
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        preparation = process
        do { try process.run() } catch {
            checking = false
            emit("error", "无法启动更新检查：\(error.localizedDescription)")
            return
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            DispatchQueue.main.async {
                guard let self = self, !self.stopped else { return }
                self.checking = false
                self.preparation = nil
                UserDefaults.standard.set(Date(), forKey: "lastUpdateCheck")
                guard let result = result, let nextPhase = result["phase"] as? String else {
                    self.emit("error", "更新检查未完成，请稍后手动重试。")
                    return
                }
                self.latestVersion = result["version"] as? String
                if nextPhase == "ready", let path = result["job"] as? String {
                    let job = URL(fileURLWithPath: path).resolvingSymlinksInPath()
                    guard job.path.hasPrefix(self.state.resolvingSymlinksInPath().path + "/update-") else {
                        self.emit("error", "更新安装目录无效，未安装。")
                        return
                    }
                    self.readyJob = job
                    self.attemptInstall()
                } else {
                    self.emit(nextPhase, result["message"] as? String ?? "更新检查已结束。")
                }
            }
        }
    }

    private func attemptInstall() {
        guard !stopped, let job = readyJob, phase != "installing" else { return }
        guard automatic || manualInstall else {
            emit("ready", "新版已下载，点击“检查更新”可安装。")
            return
        }
        guard let canRestart = canRestart else { return }
        canRestart { [weak self] allowed in
            guard let self = self, !self.stopped, self.phase != "installing" else { return }
            guard self.automatic || self.manualInstall else {
                self.emit("ready", "新版已下载，点击“检查更新”可安装。")
                return
            }
            if !allowed {
                self.emit("ready", "新版已下载。请先保存或取消当前编辑，随后将自动安装并重启。")
                self.retry?.invalidate()
                self.retry = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.attemptInstall() }
                return
            }
            self.setInstallLock?(true)
            self.emit("installing", "正在安装新版，即将自动重启；已保存的任务会保留。")
            let marker = job.appendingPathComponent("handoff.json")
            try? FileManager.default.removeItem(at: marker)
            let process = Process()
            process.executableURL = self.python
            process.arguments = [job.appendingPathComponent("apply-update.py").path, "apply", "--job", job.path,
                                 "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            self.handoff = process
            do {
                try process.run()
                self.waitForHandoff(job: job, attempt: 0)
            } catch {
                self.setInstallLock?(false)
                self.emit("error", "更新未能开始，当前应用可继续使用。")
            }
        }
    }

    private func waitForHandoff(job: URL, attempt: Int) {
        if FileManager.default.fileExists(atPath: job.appendingPathComponent("handoff.json").path) {
            NSApp.terminate(nil)
        } else if attempt < 50 && handoff?.isRunning == true {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.waitForHandoff(job: job, attempt: attempt + 1) }
        } else {
            setInstallLock?(false)
            emit("error", "更新未能接续安装，当前应用可继续使用；请手动重试。")
        }
    }

    func stop() {
        stopped = true
        interval?.invalidate()
        retry?.invalidate()
        if preparation?.isRunning == true { preparation?.terminate() }
        // The independent handoff process must survive the application's exit.
    }
}
