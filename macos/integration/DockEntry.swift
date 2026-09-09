import Foundation
import CoreFoundation
import Darwin

// This utility changes only a pinned shortcut. It never launches or stops apps.
let launcherID = "io.github.codex-dynamic-skin-system.launcher"
let officialID = "com.openai.codex"
let domain = "com.apple.dock" as CFString
let dockKey = "persistent-apps" as CFString

func fail(_ message: String) throws -> Never {
    throw NSError(domain: "ThemeDockEntry", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

func readPlist(_ path: String) throws -> [String: Any] {
    let value = try PropertyListSerialization.propertyList(from: Data(contentsOf: URL(fileURLWithPath: path)), options: [], format: nil)
    guard let result = value as? [String: Any] else { try fail("Expected a plist dictionary: \(path)") }
    return result
}

func appURL(_ path: String, identifier: String) throws -> URL {
    guard path.hasPrefix("/"), path.hasSuffix(".app") else { try fail("App path must be absolute and end in .app") }
    let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
    let info = try readPlist(url.appendingPathComponent("Contents/Info.plist").path)
    guard info["CFBundleIdentifier"] as? String == identifier else { try fail("Unexpected bundle identity at \(path)") }
    return url
}

func matches(_ tile: [String: Any], _ app: URL, _ identifier: String) -> Bool {
    guard tile["tile-type"] as? String == "file-tile",
          let data = tile["tile-data"] as? [String: Any],
          data["bundle-identifier"] as? String == identifier,
          let file = data["file-data"] as? [String: Any],
          let value = file["_CFURLString"] as? String else { return false }
    let url: URL
    if value.hasPrefix("/") { url = URL(fileURLWithPath: value) }
    else if let parsed = URL(string: value), parsed.isFileURL {
        let host = parsed.host?.lowercased() ?? ""
        guard host.isEmpty || host == "localhost" else { return false }
        url = parsed
    }
    else { return false }
    return url.standardizedFileURL.resolvingSymlinksInPath().path == app.path
}

func replace(_ tile: [String: Any], with app: URL) -> [String: Any] {
    var result = tile
    // Discard the old bookmark and mod dates, or Dock can resolve the old app.
    result["tile-data"] = [
        "bundle-identifier": launcherID,
        "file-label": "Codex Theme Launcher",
        "file-type": 41,
        "file-data": ["_CFURLString": app.absoluteString, "_CFURLStringType": 15]
    ] as [String: Any]
    return result
}

func writePlist(_ object: [String: Any], _ path: String, exclusive: Bool) throws {
    let bytes = try PropertyListSerialization.data(fromPropertyList: object, format: .xml, options: 0)
    try bytes.write(to: URL(fileURLWithPath: path), options: exclusive ? .withoutOverwriting : .atomic)
}

func readDock() throws -> [[String: Any]] {
    guard CFPreferencesAppSynchronize(domain),
          let entries = CFPreferencesCopyAppValue(dockKey, domain) as? [[String: Any]] else {
        try fail("Cannot read Dock persistent-apps")
    }
    return entries
}

do {
    umask(0o077)
    var values: [String: String] = [:]
    var apply = false, restore = false
    var args = Array(CommandLine.arguments.dropFirst())
    while !args.isEmpty {
        let key = args.removeFirst()
        if key == "--apply" { guard !apply else { try fail("Duplicate --apply") }; apply = true }
        else if key == "--restore" { guard !restore else { try fail("Duplicate --restore") }; restore = true }
        else {
            guard ["--target", "--launcher", "--input", "--output", "--backup"].contains(key),
                  values[key] == nil, !args.isEmpty, !args[0].hasPrefix("--") else { try fail("Invalid argument: \(key)") }
            values[key] = args.removeFirst()
        }
    }
    guard let targetPath = values["--target"], let launcherPath = values["--launcher"] else {
        try fail("Required: --target official.app --launcher launcher.app [--apply --backup file | --input plist --output plist]")
    }
    let offline = values["--input"] != nil
    guard offline == (values["--output"] != nil), !(offline && apply) else {
        try fail("Offline --input/--output must be paired and cannot use --apply")
    }
    if apply || restore { guard values["--backup"] != nil else { try fail("--backup is required") } }
    let target = try appURL(targetPath, identifier: officialID)
    let launcher = try appURL(launcherPath, identifier: launcherID)
    var document = offline ? try readPlist(values["--input"]!) : ["persistent-apps": try readDock()]
    guard let before = document["persistent-apps"] as? [[String: Any]] else { try fail("Malformed persistent-apps array") }
    var after = before
    var changed = 0
    if restore {
        let backup = try readPlist(values["--backup"]!)
        guard let originals = backup["persistent-apps"] as? [[String: Any]] else { try fail("Backup has no persistent-apps array") }
        for index in after.indices where matches(after[index], launcher, launcherID) {
            guard let guid = after[index]["GUID"] as? NSNumber else { try fail("Launcher tile has no GUID") }
            let originalTiles = originals.filter { ($0["GUID"] as? NSNumber) == guid && matches($0, target, officialID) }
            // A separately pinned launcher is not owned by this backup.
            if originalTiles.isEmpty { continue }
            guard originalTiles.count == 1 else { try fail("Backup does not identify exactly one original tile") }
            after[index] = originalTiles[0]
            changed += 1
        }
    } else {
        for index in after.indices where matches(after[index], target, officialID) {
            guard let guid = after[index]["GUID"] as? NSNumber else { try fail("Official tile has no GUID") }
            guard before.filter({ ($0["GUID"] as? NSNumber) == guid }).count == 1 else {
                try fail("Official tile GUID is not unique")
            }
            after[index] = replace(after[index], with: launcher)
            changed += 1
        }
    }
    document["persistent-apps"] = after
    if offline {
        guard values["--input"] != values["--output"] else { try fail("Input and output must differ") }
        try writePlist(document, values["--output"]!, exclusive: true)
    } else if apply && changed > 0 {
        // Preserve other preference keys. Re-read just before changing this one.
        guard NSArray(array: try readDock()).isEqual(to: before) else { try fail("Dock entries changed during planning; retry") }
        if !restore { try writePlist(["persistent-apps": before], values["--backup"]!, exclusive: true) }
        CFPreferencesSetAppValue(dockKey, after as CFArray, domain)
        guard CFPreferencesAppSynchronize(domain), NSArray(array: try readDock()).isEqual(to: after) else {
            try fail("Dock preference write could not be verified; retain the backup")
        }
    }
    let report: [String: Any] = ["changed": changed, "total": after.count, "applied": apply, "offline": offline, "restore": restore]
    let json = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print(String(decoding: json, as: UTF8.self))
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
