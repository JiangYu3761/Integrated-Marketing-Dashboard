import Cocoa
import WebKit

// Explicit CI mode uses a separate persistent WebKit profile, never user data.
@MainActor enum NativeSmoke {
    static let request: (report: URL, phase: String)? = {
        let args = CommandLine.arguments
        guard let report = args.firstIndex(of: "--smoke-report"), args.count > report + 1,
              let phase = args.firstIndex(of: "--smoke-phase"), args.count > phase + 1,
              ["exercise", "restore"].contains(args[phase + 1]) else { return nil }
        return (URL(fileURLWithPath: args[report + 1]), args[phase + 1])
    }()

    static func dataStore() -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: UUID(uuidString: "76228AB2-5FE6-41AE-B27D-648D1D9C3E8A")!)
    }

    static func finish(_ value: [String: Any]) {
        guard let request = request else { return }
        var report = value
        report["phase"] = request.phase
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: request.report, options: .atomic)
        } catch {
            fputs("Native smoke report failed: \(error)\n", stderr)
        }
    }

    static func run(in webView: WKWebView, completion: @escaping () -> Void) {
        guard let request = request else { return }
        let script = #"""
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const state = () => window.projectState.read()?.privateContent;
        const title = 'Native WebKit persistence smoke task';
        if (phase === 'restore') {
            const task = state()?.data.tasks.find(task => task.title === title);
            check(task, 'task did not persist across native app restart');
            check(task.status === '已完成', 'completion did not persist');
            check(task.completedAt === '2026-11-01T03:30:00.000Z', 'manual Shanghai timestamp did not persist');
            return {ok: true, checks: ['native app restart', 'persistent WebKit task data', 'completion timestamp']};
        }
        check(document.querySelector('#mm-view-time') && window.projectState, 'page or state adapter not loaded');
        for (const view of ['marketing', 'ceo', 'map', 'table', 'people', 'projects', 'fields', 'time']) {
            document.querySelector('#mm-tab-' + view).click();
            check(!document.querySelector('#mm-view-' + view).hidden, 'view failed: ' + view);
        }
        document.querySelector('#mm-add-task').click();
        let form = document.querySelector('#mm-task-form');
        form.elements.title.value = title;
        form.elements.startAt.value = '2026-11-01T09:00';
        form.elements.endAt.value = '2026-11-01T12:00';
        document.querySelector('#mm-save-task').click();
        let task = state().data.tasks.find(task => task.title === title);
        check(task, 'task creation failed');
        const id = task.id;
        document.querySelector('#mm-tab-table').click();
        let checkbox = document.querySelector('#mm-view-table [data-complete-task]');
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', {bubbles: true}));
        task = state().data.tasks.find(task => task.id === id);
        check(task.status === '已完成' && Number.isFinite(Date.parse(task.completedAt)), 'automatic completion failed');
        checkbox = document.querySelector('#mm-view-table [data-complete-task]');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', {bubbles: true}));
        check(state().data.tasks.find(task => task.id === id).completedAt === '', 'undo failed to clear completion time');
        document.querySelector('#mm-view-table [data-check-edit]').click();
        form = document.querySelector('#mm-task-form');
        form.elements.completedAt.value = '2026-11-01T11:30';
        form.elements.completedAt.dispatchEvent(new Event('change', {bubbles: true}));
        document.querySelector('#mm-save-task').click();
        check(state().data.tasks.find(task => task.id === id).completedAt === '2026-11-01T03:30:00.000Z', 'Shanghai timestamp conversion failed');
        document.querySelector('#mm-tab-time').click();
        const role = document.querySelector('#mm-role-filter');
        role.value = '经营负责人';
        role.dispatchEvent(new Event('change', {bubbles: true}));
        document.querySelector('[data-time-scale=day]').click();
        const date = document.querySelector('#mm-focus-day');
        date.value = '2026-11-01';
        date.dispatchEvent(new Event('change', {bubbles: true}));
        await new Promise(resolve => setTimeout(resolve, 300));
        const cell = document.querySelector('[data-day-date="2026-11-01"][data-day-person=""]');
        check(cell, 'day checklist cell missing');
        cell.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
        check(document.querySelector('#mm-task-dialog').open, 'double-click did not open editor');
        form = document.querySelector('#mm-task-form');
        check(form.elements.startAt.value === '2026-11-01T09:00', 'day editor default time incorrect');
        check(window.dashboardCanInstallUpdate() === false, 'updater did not defer during task editing');
        document.querySelector('#mm-cancel-task').click();
        check(window.dashboardCanInstallUpdate() === true, 'updater remains blocked after closing editor');
        check(document.querySelector('#mm-update-version').textContent.includes('当前版本'), 'native update bridge did not report version');
        return {ok: true, checks: ['eight views', 'task create/edit', 'completion and undo', 'Shanghai timestamp', 'day double-click', 'native update bridge', 'unsaved-edit update protection']};
        """#
        webView.callAsyncJavaScript(script, arguments: ["phase": request.phase], in: nil, in: .page, completionHandler: { result in
            switch result {
            case .success(let value):
                let report = value as? [String: Any] ?? ["ok": false, "error": "Invalid native result"]
                if request.phase == "restore" {
                    webView.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                        finish(report)
                        completion()
                    }
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        finish(report)
                        completion()
                    }
                }
            case .failure(let error):
                finish(["ok": false, "error": String(describing: error)])
                completion()
            }
        })
    }
}
