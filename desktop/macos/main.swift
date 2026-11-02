import Cocoa
import WebKit

private let appName = "产品经营地图"
private let bundleID = "com.jiangyu3761.integrated-marketing-dashboard"
private let appURL = URL(string: "http://127.0.0.1:18876/")!

// Run by the installer, using the same native executable as the app.
private func makeIcon(in directory: String) throws {
    let sizes = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
    for (size, scale) in sizes {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                      isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let transform = NSAffineTransform()
        transform.scale(by: CGFloat(pixels) / 1024)
        transform.concat()
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: 1024, height: 1024).fill(using: .copy)
        NSColor(calibratedRed: 0.14, green: 0.36, blue: 0.51, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864), xRadius: 190, yRadius: 190).fill()
        NSColor.white.withAlphaComponent(0.22).setFill()
        for y in [300, 470, 640] {
            NSBezierPath(roundedRect: NSRect(x: 220, y: CGFloat(y), width: 584, height: 100), xRadius: 22, yRadius: 22).fill()
        }
        NSColor.white.setFill()
        for (x, y, width) in [(255, 660, 230), (410, 490, 330), (310, 320, 275)] {
            NSBezierPath(roundedRect: NSRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: 60), xRadius: 16, yRadius: 16).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        let url = URL(fileURLWithPath: directory).appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        try bitmap.representation(using: .png, properties: [:])!.write(to: url)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var failed = false
    private var quitting = false
    private var expectedVersion = ""
    private var updates: AppUpdates?
    private var smokeStarted = false
    private let session = URLSession(configuration: .ephemeral)

    func applicationDidFinishLaunching(_ notification: Notification) {
        recordUpdateLaunch()
        makeMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = NativeSmoke.request == nil ? .default() : NativeSmoke.dataStore()
        if NativeSmoke.request?.phase == "exercise" {
            configuration.userContentController.addUserScript(WKUserScript(source: "window.localStorage.clear()", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        configuration.userContentController.add(self, name: "desktopUpdates")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = appName
        window.minSize = NSSize(width: 760, height: 560)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("DashboardMainWindow")
        showWindow()
        startServer()
    }

    private func makeMenu() {
        let menu = NSMenu()
        let applicationMenu = NSMenu(title: appName)
        applicationMenu.addItem(withTitle: "关于" + appName, action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let updateItem = applicationMenu.addItem(withTitle: "检查更新…", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "隐藏" + appName, action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "退出" + appName, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = applicationMenu
        menu.addItem(appItem)

        let editMenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        editItem.submenu = editMenu
        menu.addItem(editItem)

        let viewMenu = NSMenu(title: "窗口")
        let reload = viewMenu.addItem(withTitle: "刷新项目", action: #selector(reloadProject), keyEquivalent: "r")
        reload.target = self
        let reopen = viewMenu.addItem(withTitle: "显示项目窗口", action: #selector(showWindow), keyEquivalent: "0")
        reopen.target = self
        viewMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        let viewItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        viewItem.submenu = viewMenu
        menu.addItem(viewItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = viewMenu
    }

    @objc private func showWindow() {
        window?.deminiaturize(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func reloadProject() {
        webView.reload()
    }

    private func startServer() {
        guard let resources = Bundle.main.resourceURL else {
            showError("应用资源缺失，请重新运行仓库中的“安装到Dock.command”。")
            return
        }
        do {
            expectedVersion = try String(contentsOf: resources.appendingPathComponent("site-version.txt"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            let configured = Bundle.main.object(forInfoDictionaryKey: "DashboardPython") as? String
            let candidates = [configured, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].compactMap { $0 }
            guard let python = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
                showError("未找到 Python 3.9 或更新版本。请安装 Python 3 后重新打开应用。")
                return
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = [resources.appendingPathComponent("local_server.py").path,
                                 "--site", resources.appendingPathComponent("site").path,
                                 "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self, !self.quitting else { return }
                    self.showError("本地服务未能运行。请确认 Python 3.9+ 可用，且 18876 端口没有被其他程序占用，然后退出并重新打开应用。")
                }
            }
            server = process
            try process.run()
            configureUpdates(resources: resources, python: URL(fileURLWithPath: python))
            waitForServer(attempt: 0)
        } catch {
            showError("无法启动项目：\(error.localizedDescription)")
        }
    }

    private func waitForServer(attempt: Int) {
        guard !quitting, !failed else { return }
        var request = URLRequest(url: appURL.appendingPathComponent("_desktop/health"))
        request.timeoutInterval = 0.5
        session.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting, !self.failed else { return }
                let health = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if (response as? HTTPURLResponse)?.statusCode == 200,
                   health?["project"] as? String == "JiangYu3761/Integrated-Marketing-Dashboard",
                   health?["version"] as? String == self.expectedVersion,
                   (health?["pid"] as? NSNumber)?.int32Value == self.server?.processIdentifier,
                   self.server?.isRunning == true {
                    self.webView.load(URLRequest(url: appURL))
                } else if attempt < 40 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForServer(attempt: attempt + 1) }
                } else {
                    self.showError("等待本地服务超时。请检查 Python 安装和 18876 端口，然后退出并重新打开应用。")
                }
            }
        }.resume()
    }

    private func showError(_ message: String) {
        guard !failed, !quitting else { return }
        failed = true
        if NativeSmoke.request != nil {
            NativeSmoke.finish(["ok": false, "error": message])
            NSApp.terminate(nil)
            return
        }
        let alert = NSAlert()
        alert.messageText = "无法打开" + appName
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "退出")
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        updates?.stop()
        session.invalidateAndCancel()
        if server?.isRunning == true { server?.terminate() }
    }

    private func configureUpdates(resources: URL, python: URL) {
        let updater = AppUpdates(resources: resources, python: python)
        updater.onStatus = { [weak self] value in
            guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
            self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('desktop-update-status',{detail:\(json)}))", completionHandler: nil)
        }
        updater.canRestart = { [weak self] completion in
            guard let self = self, self.webView.url?.host == appURL.host else { completion(false); return }
            self.webView.evaluateJavaScript("window.dashboardCanInstallUpdate?.() === true") { result, _ in completion(result as? Bool == true) }
        }
        updater.setInstallLock = { [weak self] locked in
            self?.webView.evaluateJavaScript("window.dashboardSetUpdateLock?.(\(locked ? "true" : "false"))", completionHandler: nil)
        }
        updates = updater
        if NativeSmoke.request == nil { updater.start() }
    }

    @objc private func checkForUpdates() { updates?.check(manual: true) }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "desktopUpdates", message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, url.scheme == appURL.scheme, url.host == appURL.host, url.port == appURL.port,
              let body = message.body as? [String: Any], let updater = updates else { return }
        switch body["action"] as? String {
        case "check": updater.check(manual: true)
        case "automatic": if let enabled = body["enabled"] as? Bool { updater.setAutomatic(enabled) }
        case "status": updater.onStatus?(updater.status())
        default: break
        }
    }

    private func recordUpdateLaunch() {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--update-job"), args.count > index + 1 else { return }
        let job = URL(fileURLWithPath: args[index + 1]).resolvingSymlinksInPath()
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.jiangyu3761.integrated-marketing-dashboard/Updates", isDirectory: true).resolvingSymlinksInPath()
        guard job.path.hasPrefix(support.path + "/update-"),
              let data = try? Data(contentsOf: job.appendingPathComponent("job.json")),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              record["target"] as? String == Bundle.main.bundleURL.resolvingSymlinksInPath().path else { return }
        try? String(ProcessInfo.processInfo.processIdentifier).write(to: job.appendingPathComponent("launched.pid"), atomically: true, encoding: .utf8)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == appURL.scheme && url.host == appURL.host && url.port == appURL.port {
            decisionHandler(.allow)
        } else {
            if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") {
            if url.scheme == appURL.scheme && url.host == appURL.host && url.port == appURL.port {
                webView.load(URLRequest(url: url))
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showError("页面加载失败：\(error.localizedDescription)") }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard NativeSmoke.request != nil, !smokeStarted else { return }
        smokeStarted = true
        NativeSmoke.run(in: webView) { NSApp.terminate(nil) }
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--make-icon" {
    do { try makeIcon(in: CommandLine.arguments[2]) } catch {
        fputs("无法生成应用图标：\(error)\n", stderr)
        exit(1)
    }
    exit(0)
}
if CommandLine.arguments.contains("--check-running") {
    exit(NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty ? 0 : 2)
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
