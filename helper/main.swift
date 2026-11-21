// mycast-helper is the system-level half of mycast. It watches the keyboard
// with an active CGEventTap, decides which presses a binding takes, and does
// the things only a native process can do: switching an app's window, typing
// text, and swallowing a key outright.
//
// Three rules keep the rest of the system working:
//   - Modifier keys are never swallowed, only the last key of a combination.
//     Swallowing Option would leave the whole system thinking Option is up.
//   - A press that matches no binding is passed through untouched.
//   - A gesture fires on release, never on press, so a chord that turns out to
//     be the prefix of a real shortcut does not fire first.

import Cocoa
import ApplicationServices

// MARK: - Config

// A layer is one row of the flat list the user builds. Its kind decides how it
// is triggered; a divider holds no bindings and only groups the list.
enum ItemKind: String, Decodable {
    case hold, divider
}

struct Item: Decodable {
    var kind: ItemKind
    var id: String
    var title: String?
    var label: String?
    // hold: the modifier keys held down, each side its own name.
    var mods: [String]?
    // hold: what each key does.
    var keys: [String: Action]?
    // hold: what one clean tap of the modifiers alone does.
    var onRelease: Action?
    // hold: what two clean taps of the same modifiers do.
    var onDoubleTap: Action?
    // hold: how long the two taps may be apart, in milliseconds.
    var window: Int?
}

enum ActionKind: String, Decodable {
    case app, note, block, key
}

struct Action: Decodable {
    var type: ActionKind
    var bundleID: String?
    var text: String?
    var mods: [String]?
    var key: String?
}

struct Config: Decodable {
    var items: [Item]
}

// MARK: - Key names

// Virtual keycodes on the ANSI layout, as the names bindings.json uses.
let keyNames: [CGKeyCode: String] = [
    0x00: "a", 0x01: "s", 0x02: "d", 0x03: "f", 0x04: "h", 0x05: "g",
    0x06: "z", 0x07: "x", 0x08: "c", 0x09: "v", 0x0B: "b", 0x0C: "q",
    0x0D: "w", 0x0E: "e", 0x0F: "r", 0x10: "y", 0x11: "t", 0x12: "1",
    0x13: "2", 0x14: "3", 0x15: "4", 0x16: "6", 0x17: "5", 0x18: "equal",
    0x19: "9", 0x1A: "7", 0x1B: "minus", 0x1C: "8", 0x1D: "0",
    0x1E: "rightbracket", 0x1F: "o", 0x20: "u", 0x21: "leftbracket",
    0x22: "i", 0x23: "p", 0x25: "l", 0x26: "j", 0x27: "quote", 0x28: "k",
    0x29: "semicolon", 0x2A: "backslash", 0x2B: "comma", 0x2C: "slash",
    0x2D: "n", 0x2E: "m", 0x2F: "period", 0x32: "grave",
    0x24: "return", 0x30: "tab", 0x31: "space", 0x33: "delete",
    0x35: "escape",
    0x7A: "f1", 0x78: "f2", 0x63: "f3", 0x76: "f4", 0x60: "f5",
    0x61: "f6", 0x62: "f7", 0x64: "f8", 0x65: "f9", 0x6D: "f10",
    0x67: "f11", 0x6F: "f12",
    0x7E: "up", 0x7D: "down", 0x7B: "left", 0x7C: "right",
    0x73: "home", 0x77: "end", 0x74: "pageup", 0x79: "pagedown",
]

// Modifier keycodes, each side its own entry: this is what the framework's
// own shortcut API cannot express.
let modifierNames: [CGKeyCode: String] = [
    0x3B: "lctrl", 0x3E: "rctrl",
    0x3A: "lalt", 0x3D: "ralt",
    0x38: "lshift", 0x3C: "rshift",
    0x37: "lcmd", 0x36: "rcmd",
    0x3F: "fn",
]

let keyCodes: [String: CGKeyCode] = Dictionary(uniqueKeysWithValues: keyNames.map { ($0.value, $0.key) })

let deviceMods: [String: UInt64] = [
    "lctrl": 0x00000001, "lshift": 0x00000002, "rshift": 0x00000004,
    "lcmd": 0x00000008, "rcmd": 0x00000010,
    "lalt": 0x00000020, "ralt": 0x00000040, "rctrl": 0x00002000,
]

// MARK: - State

final class Helper {
    static let syntheticTag: Int64 = 0x4D794343

    var config: Config?
    var configPath: String

    var held: Set<CGKeyCode> = []
    var swallowed: Set<CGKeyCode> = []

    // One gesture is one session: modifiers pressed together, nothing else,
    // then all released. Firing on release is what keeps Ctrl+Shift+K
    // working; the cap is what keeps a held modifier from counting as a tap.
    var sessionActive = false
    var sessionMods: Set<String> = []
    var sessionClean = true
    var sessionStartedAt: CFTimeInterval = 0

    // The last clean tap, so that a second one on the same modifiers inside
    // the window becomes the double instead of two singles.
    var lastSolo: [String] = []
    var lastSoloAt: CFTimeInterval = 0

    // When a layer has both gestures, the single waits out the double window
    // so a double does not fire the single first. Any input cancels it.
    var pendingSolo: DispatchWorkItem?

    init(configPath: String) {
        self.configPath = configPath
    }

    func reload() {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: configPath))
            config = try JSONDecoder().decode(Config.self, from: data)
            let layers = config?.items.filter { $0.kind != .divider }.count ?? 0
            report("log", "loaded \(layers) layers")
        } catch {
            report("error", "config: \(error.localizedDescription)")
        }
    }

    // MARK: Layers

    var holdLayers: [Item] {
        config?.items.filter { $0.kind == .hold } ?? []
    }

    // A chord layer is the one whose modifier set is exactly what is held:
    // every modifier counts, and its side.
    func holdLayer(for mods: [String]) -> Item? {
        let want = mods.sorted()
        return holdLayers.first { ($0.mods ?? []).sorted() == want }
    }

    // How long one press-and-release may last before it reads as a hold.
    static let tapCap: CFTimeInterval = 0.5

    // A layer's own double window, in seconds, clamped to what the UI offers.
    func doubleWindow(_ layer: Item) -> CFTimeInterval {
        let ms = layer.window ?? 350
        return CFTimeInterval(min(max(ms, 10), 800)) / 1000
    }

    // MARK: Key handling

    func handleTapEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if event.getIntegerValueField(.eventSourceUserData) == Helper.syntheticTag {
            return Unmanaged.passUnretained(event)
        }
        let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))

        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // The system turned the tap off, so everything pressed while it
            // was off went unseen. Forgetting what is held matters: a modifier
            // it still believes down reads the next press as a release.
            resetInputState()
            debug("tap disabled by the system; state cleared and tap re-enabled")
            if let activeTap {
                CGEvent.tapEnable(tap: activeTap, enable: true)
            }
            return Unmanaged.passUnretained(event)
        case .flagsChanged:
            handleFlagsChanged(code: code)
            // Modifiers always pass through: swallowing one makes the system
            // believe it was never pressed, and every shortcut that uses it
            // breaks system-wide.
            return Unmanaged.passUnretained(event)
        case .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel:
            // A modifier used together with the mouse is a modifier, not a
            // tap: Cmd+click, Control+click, Option+drag all land here.
            sessionClean = false
            lastSolo = []
            cancelPendingSolo()
            return Unmanaged.passUnretained(event)
        case .keyDown:
            return handleKeyDown(code: code, event: event)
        case .keyUp:
            // A press we took must not leave the app waiting for its release.
            if swallowed.contains(code) {
                swallowed.remove(code)
                return nil
            }
            return Unmanaged.passUnretained(event)
        default:
            return Unmanaged.passUnretained(event)
        }
    }

    func resetInputState() {
        held.removeAll()
        swallowed.removeAll()
        lastSolo = []
        sessionActive = false
        sessionMods.removeAll()
        sessionClean = true
        cancelPendingSolo()
    }

    func handleFlagsChanged(code: CGKeyCode) {
        guard let modName = modifierNames[code] else { return }
        let now = CACurrentMediaTime()

        if held.contains(code) {
            held.remove(code)
            debug("mod \(modName) up")

            // The gesture ends once every modifier is up again.
            if sessionActive && held.isEmpty {
                let mods = sessionMods.sorted()
                let clean = sessionClean
                let duration = now - sessionStartedAt
                sessionActive = false
                sessionClean = true
                endSession(mods: mods, clean: clean, duration: duration,
                           startedAt: sessionStartedAt, now: now)
            }
            return
        }

        // A press. The session starts when the first modifier goes down.
        cancelPendingSolo()
        if held.isEmpty {
            sessionActive = true
            sessionMods = []
            sessionClean = true
            sessionStartedAt = now
        }
        held.insert(code)
        sessionMods.insert(modName)
        debug("mod \(modName) down")
    }

    // Called once all modifiers are up. A tap is clean, short, and on a set
    // of modifiers that names a layer; the second one inside the layer's
    // window is the double. The window is the gap between the first release
    // and the second press, so a slow second press does not eat it.
    func endSession(mods: [String], clean: Bool, duration: CFTimeInterval,
                    startedAt: CFTimeInterval, now: CFTimeInterval) {
        let fits = clean && duration <= Helper.tapCap
        let same = mods == lastSolo
        lastSolo = []
        guard fits, let layer = holdLayer(for: mods) else { return }

        let label = mods.joined(separator: "+")
        if same, startedAt - lastSoloAt <= doubleWindow(layer),
           let target = layer.onDoubleTap {
            cancelPendingSolo()
            debug("double \(label) after \(Int((startedAt - lastSoloAt) * 1000))ms")
            run(target: target, where: "双击 " + label)
            return
        }

        // Not a double: this tap may still be the first half of one.
        if layer.onDoubleTap != nil {
            lastSolo = mods
            lastSoloAt = now
        }

        guard let target = layer.onRelease else { return }
        let where_ = "只按 " + label
        if layer.onDoubleTap != nil {
            scheduleSolo(after: doubleWindow(layer)) {
                self.debug("single \(label) after the double window")
                self.run(target: target, where: where_)
            }
        } else {
            debug("single \(label) in \(Int(duration * 1000))ms")
            run(target: target, where: where_)
        }
    }

    func scheduleSolo(after delay: CFTimeInterval, _ fire: @escaping () -> Void) {
        cancelPendingSolo()
        let work = DispatchWorkItem(block: fire)
        pendingSolo = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func cancelPendingSolo() {
        pendingSolo?.cancel()
        pendingSolo = nil
    }

    func handleKeyDown(code: CGKeyCode, event: CGEvent) -> Unmanaged<CGEvent>? {
        // Repeats of a key we already took stay taken.
        if swallowed.contains(code) {
            return nil
        }

        // Any key ends the gesture and the chance of a second tap: this was
        // a shortcut, not a tap.
        sessionClean = false
        lastSolo = []
        cancelPendingSolo()

        guard let keyName = keyNames[code] else {
            return Unmanaged.passUnretained(event)
        }

        let mods = heldModifierNames()
        guard let layer = holdLayer(for: mods),
              let target = layer.keys?[keyName] else {
            return Unmanaged.passUnretained(event)
        }

        // A note names the key and leaves it to the app: nothing fires and
        // the press goes through untouched.
        if target.type == .note {
            return Unmanaged.passUnretained(event)
        }

        swallowed.insert(code)
        let title = layer.title ?? layer.id
        run(target: target, where: title + " · " + keyName.uppercased())
        return nil
    }

    func heldModifierNames() -> [String] {
        held.compactMap { modifierNames[$0] }.sorted()
    }

    // MARK: Actions

    func run(target: Action, where label: String) {
        switch target.type {
        case .block:
            report("fired", "\(label) → 屏蔽")
        case .app:
            toggleApp(target)
            report("fired", "\(label) → " + (target.bundleID ?? "?"))
        case .key:
            postKey(target)
            report("fired", "\(label) → " + keyLabel(target))
        case .note:
            return
        }
        Socket.shared.send(["type": "fired", "layer": label, "action": target.type.rawValue])
    }

    func keyLabel(_ target: Action) -> String {
        let symbols: [String: String] = [
            "lctrl": "⌃L", "rctrl": "⌃R",
            "lalt": "⌥L", "ralt": "⌥R",
            "lshift": "⇧L", "rshift": "⇧R",
            "lcmd": "⌘L", "rcmd": "⌘R",
        ]
        let mods = (target.mods ?? []).map { symbols[$0] ?? $0 }
        return (mods + [target.key?.uppercased() ?? "?"]).joined(separator: " ")
    }

    func postKey(_ target: Action) {
        guard let name = target.key, let code = keyCodes[name] else {
            report("error", "key not found: \(target.key ?? "?")")
            return
        }
        var flags: CGEventFlags = []
        func add(_ mod: String, _ flag: CGEventFlags) {
            flags.insert(flag)
            if let bit = deviceMods[mod] {
                flags.insert(CGEventFlags(rawValue: bit))
            }
        }
        for mod in target.mods ?? [] {
            switch mod {
            case "lctrl": add(mod, .maskControl)
            case "rctrl": add(mod, .maskControl)
            case "lalt": add(mod, .maskAlternate)
            case "ralt": add(mod, .maskAlternate)
            case "lshift": add(mod, .maskShift)
            case "rshift": add(mod, .maskShift)
            case "lcmd": add(mod, .maskCommand)
            case "rcmd": add(mod, .maskCommand)
            default: break
            }
        }
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            event.setIntegerValueField(.eventSourceUserData, value: Helper.syntheticTag)
            event.post(tap: .cghidEventTap)
        }
    }

    // An app may be named by bundle identifier; a bundle without one is named
    // by the path the installed-apps list falls back to.
    func appURL(_ target: Action) -> URL? {
        guard let name = target.bundleID else { return nil }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
            return url
        }
        if name.hasPrefix("/") {
            return URL(fileURLWithPath: name)
        }
        return nil
    }

    // The behaviour the whole app is built on: launch it when it is not
    // running, bring it forward when it is behind, hide it when it is in
    // front, and give it a window when it has none.
    //
    // Bringing an app forward is not the same as activating its process:
    // activating leaves an app with no open window showing nothing, and
    // leaves minimized windows in the Dock. Opening the app again is what a
    // Dock click does, and Launch Services turns that into the reopen event
    // the app answers itself, so it makes the window the app wants to make.
    func toggleApp(_ target: Action) {
        guard let url = appURL(target) else {
            report("error", "app not found: \(target.bundleID ?? "?")")
            return
        }

        if let bundleID = target.bundleID,
           let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first,
           !running.isTerminated {
            if running.isActive, hasVisibleWindow(running.processIdentifier) {
                debug("toggle \(bundleID): hide")
                running.hide()
                return
            }
            debug("toggle \(bundleID): reopen")
            openApp(url)
            return
        }
        debug("toggle \(target.bundleID ?? "?"): launch")
        openApp(url)
    }

    // hasVisibleWindow tells whether the app shows anything at all: a window
    // on screen at the normal layer. An app that is frontmost with nothing
    // showing must be given a window rather than hidden, or the press looks
    // like it did nothing. Assuming a window when the list cannot be read
    // keeps the hide half of the toggle working.
    func hasVisibleWindow(_ pid: pid_t) -> Bool {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return true }

        for window in list {
            guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, owner == pid else { continue }
            guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
            guard let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                  let height = bounds["Height"], height > 1
            else { continue }
            return true
        }
        return false
    }

    func openApp(_ url: URL) {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        // Launching an app through a launcher is not a document the user
        // opened, so it stays out of Recents.
        config.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error {
                self.report("error", "open: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Reporting

    func debug(_ message: String) {
        if ProcessInfo.processInfo.environment["MYCAST_DEBUG"] != nil {
            FileHandle.standardError.write("[debug] \(message)\n".data(using: .utf8)!)
        }
    }

    func report(_ type: String, _ message: String) {
        debug("[\(type)] \(message)")
        Socket.shared.send(["type": type, "message": message])
    }
}

// MARK: - Socket

// Sends newline-delimited JSON to the Go app. Reconnects lazily so a restart
// of the app does not take the helper down with it.
final class Socket {
    static let shared = Socket()
    var fd: Int32 = -1
    var path: String = ""
    var queue = DispatchQueue(label: "mycast.socket")

    func configure(path: String) {
        self.path = path
    }

    func connect() -> Bool {
        if fd >= 0 { return true }
        guard !path.isEmpty else { return false }
        let sock = socket(AF_UNIX, SOCK_STREAM, 0)
        if sock < 0 { return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        path.withCString { src in
            withUnsafeMutablePointer(to: &addr.sun_path) { dst in
                dst.withMemoryRebound(to: CChar.self, capacity: 104) { d in
                    _ = strncpy(d, src, 103)
                }
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Foundation.connect(sock, $0, size)
            }
        }
        if ok != 0 {
            close(sock)
            return false
        }
        fd = sock
        readLoop()
        return true
    }

    func send(_ payload: [String: Any]) {
        queue.async {
            guard self.connect(),
                  let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
            var line = data
            line.append(0x0A)
            line.withUnsafeBytes { buf in
                guard let base = buf.baseAddress else { return }
                var written = 0
                while written < line.count {
                    let n = write(self.fd, base + written, line.count - written)
                    if n <= 0 {
                        close(self.fd)
                        self.fd = -1
                        return
                    }
                    written += n
                }
            }
        }
    }

    // The app answers on the same connection, for example to ask for a reload.
    func readLoop() {
        let fd = self.fd
        DispatchQueue.global().async {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                let n = read(fd, &chunk, chunk.count)
                if n <= 0 { break }
                buffer.append(contentsOf: chunk[0..<n])
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<nl]
                    buffer.removeSubrange(buffer.startIndex...nl)
                    if let obj = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                       let cmd = obj["type"] as? String, cmd == "reload" {
                        DispatchQueue.main.async { engine?.reload() }
                    }
                }
            }
            DispatchQueue.main.async { Socket.shared.fd = -1 }
        }
    }
}

// MARK: - Main

var engine: Helper?
// The tap the app currently runs, so the callback can turn it back on.
var activeTap: CFMachPort?

func loadConfigPath() -> String {
    if let p = ProcessInfo.processInfo.environment["MYCAST_BINDINGS"] {
        return p
    }
    let args = CommandLine.arguments
    if args.count > 1 { return args[1] }
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent("Library/Application Support/mycast/bindings.json").path
}

func tapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let engine else { return Unmanaged.passUnretained(event) }
    return engine.handleTapEvent(proxy: proxy, type: type, event: event)
}

func startTap() -> Bool {
    let mask = (1 << CGEventType.keyDown.rawValue)
        | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)
        | (1 << CGEventType.leftMouseDown.rawValue)
        | (1 << CGEventType.rightMouseDown.rawValue)
        | (1 << CGEventType.otherMouseDown.rawValue)
        | (1 << CGEventType.scrollWheel.rawValue)

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: CGEventMask(mask),
        callback: tapCallback,
        userInfo: nil
    ) else {
        engine?.report("error", "cannot create event tap; grant 辅助功能 to \(CommandLine.arguments[0])")
        return false
    }

    activeTap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)

    let info: [String: Any] = [
        "type": "hello",
        "pid": ProcessInfo.processInfo.processIdentifier,
        "ax": true,
        "layers": engine?.config?.items.filter { $0.kind != .divider }.count ?? 0,
        "actions": engine?.config?.items.reduce(0) { $0 + ($1.keys?.count ?? 0) } as Any,
    ]
    Socket.shared.send(info)
    return true
}

func main() {
    let configPath = loadConfigPath()

    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)

    Socket.shared.configure(path: ProcessInfo.processInfo.environment["MYCAST_SOCKET"] ?? "")
    engine = Helper(configPath: configPath)
    engine?.reload()

    var waitTimer: Timer?
    if trusted {
        if !startTap() { exit(2) }
    } else {
        engine?.report("error", "等待辅助功能授权；在系统设置中启用后会自动继续")
        waitTimer = Timer(timeInterval: 1.0, repeats: true) { _ in
            guard AXIsProcessTrusted() else { return }
            waitTimer?.invalidate()
            waitTimer = nil
            engine?.report("log", "辅助功能已授权")
            if !startTap() { exit(2) }
        }
        RunLoop.current.add(waitTimer!, forMode: .common)
    }

    let timer = Timer(timeInterval: 1.0, repeats: true) { _ in
        if let tap = activeTap, !CGEvent.tapIsEnabled(tap: tap) {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        if getppid() == 1 {
            exit(0)
        }
    }
    RunLoop.current.add(timer, forMode: .common)

    CFRunLoopRun()
}

main()
