// Throwaway spike code (issue #11): a minimal WKWebView host (the engine Tauri uses on macOS) for
// target mac-wkwebview. Loads the bench URL in a visible window with the default, persistent
// website data store, and exits once the page has posted its result to spike/device/serve.mjs.
// Usage: swift spike/device/wkhost.swift <url>
import Cocoa
import WebKit

guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else {
  print("usage: swift spike/device/wkhost.swift <url>")
  exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let frame = NSRect(x: 0, y: 0, width: 900, height: 700)
let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "pglite-cipher bench (WKWebView)"
let web = WKWebView(frame: frame, configuration: WKWebViewConfiguration())
web.isInspectable = true
window.contentView = web
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
web.load(URLRequest(url: url))

Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  MainActor.assumeIsolated {
    web.evaluateJavaScript("window.__benchPosted === true") { value, _ in
      if (value as? Bool) == true { exit(0) }
    }
  }
}
app.run()
