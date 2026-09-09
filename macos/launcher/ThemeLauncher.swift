import AppKit
import CryptoKit
import Darwin
import Foundation

private struct LauncherFailure: Error {
    let status: Int32
    let message: String
}

private struct Configuration {
    let engineRoot: URL
    let entryScript: URL
    let port: Int

    init() throws {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "CDSSEngineRoot") as? String,
              root.hasPrefix("/"), root != "/" else {
            throw LauncherFailure(status: 78, message: "The launcher needs an absolute CDSSEngineRoot in Contents/Info.plist. Rebuild it with --engine-root.")
        }
        guard let number = Bundle.main.object(forInfoDictionaryKey: "CDSSPort") as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == Double(number.intValue),
              (1024...65535).contains(number.intValue) else {
            throw LauncherFailure(status: 78, message: "CDSSPort must be an integer between 1024 and 65535. Rebuild the launcher with --port.")
        }
        engineRoot = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        entryScript = engineRoot.appendingPathComponent("scripts/open-dream-skin-macos.sh")
        port = number.intValue
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: entryScript.path, isDirectory: &isDirectory),
              !isDirectory.boolValue,
              FileManager.default.isReadableFile(atPath: entryScript.path) else {
            throw LauncherFailure(status: 78, message: "Theme engine entry script is missing or unreadable: \(entryScript.path). Install the engine or rebuild the launcher with the correct --engine-root.")
        }
    }

    var lockPath: String {
        // The parent survives replacement of the engine directory during updates.
        let digest = SHA256.hash(data: Data(engineRoot.path.utf8)).map { String(format: "%02x", $0) }.joined()
        return engineRoot.deletingLastPathComponent().appendingPathComponent(".cdss-theme-launcher-\(digest).lock").path
    }

    func check() throws {
        let payload: [String: Any] = ["engineRoot": engineRoot.path, "entryScript": entryScript.path, "port": port]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }
}

private func launch(_ configuration: Configuration) throws {
    let descriptor = open(configuration.lockPath, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600))
    guard descriptor >= 0 else {
        throw LauncherFailure(status: 73, message: "Cannot open launcher lock at \(configuration.lockPath): \(String(cString: strerror(errno)))")
    }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        if errno == EWOULDBLOCK || errno == EAGAIN {
            return
        }
        throw LauncherFailure(status: 73, message: "Cannot acquire launcher lock: \(String(cString: strerror(errno)))")
    }
    // Never unlink the lock inode: another click may already have opened it.
    defer { flock(descriptor, LOCK_UN) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [configuration.entryScript.path, "--port", String(configuration.port)]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    let errors = Pipe()
    process.standardError = errors
    do {
        try process.run()
    } catch {
        throw LauncherFailure(status: 71, message: "Could not run the theme engine: \(error.localizedDescription)")
    }
    // Drain while the child is running so diagnostic output cannot fill the pipe.
    // Keep only a bounded tail for the native failure dialog.
    var tail = Data()
    while true {
        let data = errors.fileHandleForReading.availableData
        if data.isEmpty { break }
        tail.append(data)
        if tail.count > 16_384 { tail = Data(tail.suffix(16_384)) }
    }
    process.waitUntilExit()
    guard process.terminationReason == .exit && process.terminationStatus == 0 else {
        let diagnostics = String(decoding: tail, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let status = process.terminationReason == .uncaughtSignal ? 128 + process.terminationStatus : process.terminationStatus
        throw LauncherFailure(status: status, message: "The theme engine exited with status \(status).\n\(diagnostics)\nEntry script: \(configuration.entryScript.path)")
    }
}

private func report(_ failure: LauncherFailure) {
    FileHandle.standardError.write(Data("Codex Theme Launcher: \(failure.message)\n".utf8))
}

private final class LauncherDelegate: NSObject, NSApplicationDelegate {
    let configuration: Configuration

    init(configuration: Configuration) {
        self.configuration = configuration
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.global(qos: .userInitiated).async { [configuration] in
            let failure: LauncherFailure?
            do {
                try launch(configuration)
                failure = nil
            } catch let error as LauncherFailure {
                failure = error
            } catch {
                failure = LauncherFailure(status: 70, message: error.localizedDescription)
            }
            DispatchQueue.main.async {
                if let failure {
                    report(failure)
                    showAlert(failure)
                    exit(failure.status)
                }
                NSApplication.shared.terminate(nil)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // A running launcher already owns this click; no queued repeat or retry.
        return false
    }
}

private func showAlert(_ failure: LauncherFailure) {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Codex Theme Launcher could not finish"
    alert.informativeText = failure.message
    alert.addButton(withTitle: "OK")
    alert.runModal()
}

let arguments = Array(CommandLine.arguments.dropFirst())
let noAlert = arguments.contains("--no-alert") || arguments.contains("--check")
do {
    let unknown = arguments.filter { !["--check", "--no-alert", "--help"].contains($0) && !$0.hasPrefix("-psn_") }
    guard unknown.isEmpty else {
        throw LauncherFailure(status: 64, message: "Unknown launcher argument: \(unknown.joined(separator: " ")). Supported options: --check, --no-alert, --help.")
    }
    if arguments.contains("--help") {
        print("Codex Theme Launcher [--check] [--no-alert]\n--check validates configuration without starting the engine.\n--no-alert reports errors to stderr instead of displaying a dialog.")
        exit(0)
    }
    let configuration = try Configuration()
    if arguments.contains("--check") {
        try configuration.check()
    } else if noAlert {
        try launch(configuration)
    } else {
        let application = NSApplication.shared
        let delegate = LauncherDelegate(configuration: configuration)
        application.setActivationPolicy(.accessory)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
} catch let failure as LauncherFailure {
    report(failure)
    if !noAlert { showAlert(failure) }
    exit(failure.status)
} catch {
    let failure = LauncherFailure(status: 70, message: error.localizedDescription)
    report(failure)
    if !noAlert { showAlert(failure) }
    exit(failure.status)
}
