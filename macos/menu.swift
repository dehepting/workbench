import Cocoa

// Workbench menu-bar app: status icon + dashboard shortcut.
// Icon is 🔨 when the server is up, ⚪ when it's down.

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let dashboardURL = URL(string: "http://localhost:4173")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        buildMenu()
        updateIcon()
        Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
            self?.updateIcon()
        }
    }

    func buildMenu() {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Workbench", action: #selector(NSApp.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
        statusItem.button?.toolTip = "Workbench — agentic factory floor"
    }

    @objc func openDashboard() {
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc func restartServer() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Prefer launchd (it only restarts the HTTP server). The pkill fallback is
        // anchored to the bare server command so it can't take out `--mcp` workers.
        task.arguments = ["-lc",
            "if launchctl kickstart -k gui/$(id -u)/com.workbench.server 2>/dev/null; then :; else " +
            "pkill -f 'workbench/bin/workbench\\.js$'; sleep 0.5; " +
            "nohup node /Users/davidhepting/workbench/bin/workbench.js >/dev/null 2>&1 & fi"]
        try? task.run()
    }

    func updateIcon() {
        var request = URLRequest(url: dashboardURL.appendingPathComponent("api/stats"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let up = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self?.statusItem.button?.title = up ? "🔨" : "⚪"
            }
        }.resume()
    }
}

// Hold a strong reference — NSApplication.delegate is weak.
let appDelegate: AppDelegate?

let app = NSApplication.shared
appDelegate = AppDelegate()
app.delegate = appDelegate
app.setActivationPolicy(.accessory) // menu-bar only, no dock icon
app.run()
