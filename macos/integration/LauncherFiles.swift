import Darwin
import Foundation

// File operations for the independent launcher only. No app or Dock APIs.
private let launcherID = "io.github.codex-dynamic-skin-system.launcher"

private func fail(_ message: String) throws -> Never {
    throw NSError(domain: "LauncherFiles", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private func posixFailure(_ operation: String) throws -> Never {
    let code = errno
    try fail("\(operation): \(String(cString: strerror(code)))")
}

private func metadata(_ path: String) throws -> stat? {
    var value = stat()
    if lstat(path, &value) == 0 { return value }
    if errno == ENOENT { return nil }
    try posixFailure("Cannot inspect \(path)")
}

private func launcherIdentity(_ path: String) throws -> stat? {
    guard let value = try metadata(path) else { return nil }
    guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
        try fail("Refusing an unrelated application or symlink: \(path)")
    }
    let infoPath = URL(fileURLWithPath: path).appendingPathComponent("Contents/Info.plist")
    let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: infoPath), options: [], format: nil)
    guard (info as? [String: Any])?["CFBundleIdentifier"] as? String == launcherID else {
        try fail("Refusing an unrelated application identity: \(path)")
    }
    return value
}

private func moveExclusive(_ source: String, _ destination: String) throws {
    // Unlike mv, this always addresses the exact destination and cannot nest
    // in a directory, follow a destination symlink, or overwrite a new arrival.
    guard renameatx_np(AT_FDCWD, source, AT_FDCWD, destination, UInt32(RENAME_EXCL)) == 0 else {
        try posixFailure("Cannot move \(source) to exact destination \(destination)")
    }
}

private func createBackupDirectory(_ state: String) throws -> String {
    try FileManager.default.createDirectory(atPath: state, withIntermediateDirectories: true)
    var template = Array((state + "/previous-app.XXXXXX").utf8CString)
    return try template.withUnsafeMutableBufferPointer { buffer in
        guard let directory = mkdtemp(buffer.baseAddress!) else { try posixFailure("Cannot reserve launcher backup") }
        return String(cString: directory)
    }
}

private func createShortcut(_ target: String, _ shortcut: String) throws {
    try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: shortcut).deletingLastPathComponent().path,
                                          withIntermediateDirectories: true)
    if symlink(target, shortcut) == 0 { return }
    guard errno == EEXIST else { try posixFailure("Cannot create Desktop shortcut \(shortcut)") }
    guard let value = try metadata(shortcut), value.st_mode & mode_t(S_IFMT) == mode_t(S_IFLNK),
          try FileManager.default.destinationOfSymbolicLink(atPath: shortcut) == target else {
        try fail("Refusing to overwrite an unrelated Desktop shortcut: \(shortcut)")
    }
}

private func install(_ values: [String: String]) throws {
    guard let source = values["--source"], let target = values["--target"], let state = values["--state-dir"] else {
        try fail("Required: install --source staged.app --target launcher.app --state-dir path [--shortcut path]")
    }
    guard source != target, source.hasSuffix(".app"), target.hasSuffix(".app") else {
        try fail("Source and target must be different app paths")
    }
    let parent = URL(fileURLWithPath: target).deletingLastPathComponent().path
    try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    let lockPath = parent + "/.cdss-theme-launcher.install.lock"
    let descriptor = open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600))
    guard descriptor >= 0 else { try posixFailure("Cannot open installation lock") }
    defer { close(descriptor) }
    var lockInfo = stat()
    guard fstat(descriptor, &lockInfo) == 0, lockInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          lockInfo.st_uid == geteuid() else { try fail("Unsafe installation lock: \(lockPath)") }
    guard flock(descriptor, LOCK_EX) == 0 else { try posixFailure("Cannot acquire installation lock") }
    // Keep the inode on disk so every concurrent installation locks the same file.
    defer { flock(descriptor, LOCK_UN) }

    var phase = "validate existing app"
    var backup = ""
    var previousMoved = false
    var installed = false
    do {
        // Revalidate under the installation lock, after any lengthy build.
        if let original = try launcherIdentity(target) {
            phase = "backup previous app"
            backup = try createBackupDirectory(state)
            let previous = backup + "/Codex Theme Launcher.app"
            try moveExclusive(target, previous)
            previousMoved = true
            guard let moved = try launcherIdentity(previous), moved.st_dev == original.st_dev,
                  moved.st_ino == original.st_ino else {
                try fail("The destination changed during backup; refusing to publish")
            }
        }
        phase = "publish launcher"
        try moveExclusive(source, target)
        installed = true
        if let shortcut = values["--shortcut"] {
            phase = "create Desktop shortcut"
            try createShortcut(target, shortcut)
        }
        let result: [String: Any] = ["installed": true, "target": target, "backup": backup]
        let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(json + Data("\n".utf8))
    } catch {
        var details = ["Installation failed during \(phase): \(error.localizedDescription)"]
        if !installed && previousMoved {
            do {
                try moveExclusive(backup + "/Codex Theme Launcher.app", target)
                previousMoved = false
                details.append("Previous launcher restored: \(target)")
            } catch {
                details.append("Could not restore the previous launcher without overwriting the destination: \(error.localizedDescription)")
            }
        }
        if installed { details.append("New launcher remains installed: \(target)") }
        if previousMoved { details.append("Previous launcher retained: \(backup)") }
        else if !backup.isEmpty { _ = rmdir(backup) }
        try fail(details.joined(separator: "\n"))
    }
}

do {
    umask(0o077)
    var args = Array(CommandLine.arguments.dropFirst())
    guard !args.isEmpty, args.removeFirst() == "install" else { try fail("Expected install command") }
    var values: [String: String] = [:]
    while !args.isEmpty {
        let key = args.removeFirst()
        guard ["--source", "--target", "--state-dir", "--shortcut"].contains(key),
              values[key] == nil, !args.isEmpty else { try fail("Invalid argument: \(key)") }
        let value = args.removeFirst()
        guard value.hasPrefix("/"), value != "/" else { try fail("Paths must be absolute and cannot be the filesystem root") }
        values[key] = value
    }
    try install(values)
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
