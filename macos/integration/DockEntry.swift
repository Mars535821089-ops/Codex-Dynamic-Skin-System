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

func tileGUID(_ tile: [String: Any]) throws -> NSNumber {
    guard let guid = tile["GUID"] as? NSNumber,
          CFGetTypeID(guid) != CFBooleanGetTypeID(), guid.doubleValue > 0,
          guid.doubleValue == Double(guid.uint64Value) else { try fail("Tile has no valid GUID") }
    return guid
}

func indexForGUID(_ guid: NSNumber, in entries: [[String: Any]]) throws -> Int? {
    let indices = entries.indices.filter { (entries[$0]["GUID"] as? NSNumber) == guid }
    guard indices.count <= 1 else { try fail("Ambiguous duplicate GUID: \(guid)") }
    return indices.first
}

func sameIdentity(_ lhs: [String: Any], _ rhs: [String: Any]) -> Bool {
    guard let left = lhs["tile-data"] as? [String: Any], let right = rhs["tile-data"] as? [String: Any],
          let leftFile = left["file-data"] as? [String: Any], let rightFile = right["file-data"] as? [String: Any],
          let leftURL = leftFile["_CFURLString"] as? String, let rightURL = rightFile["_CFURLString"] as? String else { return false }
    return lhs["tile-type"] as? String == rhs["tile-type"] as? String
        && left["bundle-identifier"] as? String == right["bundle-identifier"] as? String
        && leftURL == rightURL
}

// Only explicit removal records authorize reinsertion. Legacy backups continue
// to restore converted tiles only, without resurrecting user-deleted shortcuts.
func restoreRemoved(_ metadata: Any, originals: [[String: Any]], entries: inout [[String: Any]], target: URL, launcher: URL) throws -> Int {
    guard let record = metadata as? [String: Any], record["version"] as? Int == 1,
          let removed = record["removedOfficialGUIDs"] as? [NSNumber], !removed.isEmpty,
          let keeper = record["retainedLauncherGUID"] as? NSNumber,
          let keeperIndex = try indexForGUID(keeper, in: originals),
          matches(originals[keeperIndex], launcher, launcherID) else { try fail("Invalid deduplication backup metadata") }
    _ = try tileGUID(originals[keeperIndex])
    var removalIndices: [Int] = []
    for guid in removed {
        guard let index = try indexForGUID(guid, in: originals),
              matches(originals[index], target, officialID), !removalIndices.contains(index) else {
            try fail("Ambiguous removed official GUID in backup")
        }
        _ = try tileGUID(originals[index])
        removalIndices.append(index)
    }
    var changed = 0
    for originalIndex in removalIndices.sorted() {
        let original = originals[originalIndex]
        let guid = try tileGUID(original)
        if let existing = try indexForGUID(guid, in: entries) {
            guard matches(entries[existing], target, officialID) else { try fail("Removed official GUID is now occupied by another tile") }
            continue
        }
        // Use surviving original neighbours as anchors, preserving all current
        // entries and their order. Ignore appearance dates and bookmark bytes.
        func anchor(_ indices: [Int]) throws -> Int? {
            for index in indices {
                guard let candidateGUID = originals[index]["GUID"] as? NSNumber else { continue }
                _ = try indexForGUID(candidateGUID, in: originals)
                if let current = try indexForGUID(candidateGUID, in: entries), sameIdentity(entries[current], originals[index]) {
                    return current
                }
            }
            return nil
        }
        let left = try anchor(Array((0..<originalIndex).reversed()))
        let right = try anchor(Array((originalIndex + 1)..<originals.count))
        if let left, let right, left >= right { try fail("Surviving anchor order changed; cannot safely restore removed tile") }
        guard left != nil || right != nil else { try fail("No surviving anchor identifies the removed tile position") }
        entries.insert(original, at: right ?? (left! + 1))
        changed += 1
    }
    return changed
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
    var backupDocument: [String: Any] = ["persistent-apps": before]
    if restore {
        let backup = try readPlist(values["--backup"]!)
        guard let originals = backup["persistent-apps"] as? [[String: Any]] else { try fail("Backup has no persistent-apps array") }
        for index in after.indices where matches(after[index], launcher, launcherID) {
            let guid = try tileGUID(after[index])
            _ = try indexForGUID(guid, in: after)
            let originalTiles = originals.filter { ($0["GUID"] as? NSNumber) == guid && matches($0, target, officialID) }
            // A separately pinned launcher is not owned by this backup.
            if originalTiles.isEmpty { continue }
            guard originalTiles.count == 1 else { try fail("Backup does not identify exactly one original tile") }
            _ = try indexForGUID(guid, in: originals)
            after[index] = originalTiles[0]
            changed += 1
        }
        if let metadata = backup["cdss-dock-entry"] {
            changed += try restoreRemoved(metadata, originals: originals, entries: &after, target: target, launcher: launcher)
        }
    } else {
        let officialIndices = before.indices.filter { matches(before[$0], target, officialID) }
        let launcherIndices = before.indices.filter { matches(before[$0], launcher, launcherID) }
        for index in officialIndices {
            _ = try indexForGUID(tileGUID(before[index]), in: before)
        }
        if !officialIndices.isEmpty, !launcherIndices.isEmpty {
            guard launcherIndices.count == 1 else { try fail("Ambiguous existing launcher tiles; refusing to choose one") }
            let keeper = try tileGUID(before[launcherIndices[0]])
            _ = try indexForGUID(keeper, in: before)
            let removed = try officialIndices.map { try tileGUID(before[$0]) }
            for index in officialIndices.reversed() { after.remove(at: index) }
            changed = officialIndices.count
            backupDocument["cdss-dock-entry"] = ["version": 1, "removedOfficialGUIDs": removed, "retainedLauncherGUID": keeper]
        } else {
            guard officialIndices.count <= 1 else {
                try fail("Ambiguous multiple official tiles without an existing launcher; refusing to choose one")
            }
            for index in officialIndices {
                after[index] = replace(after[index], with: launcher)
                changed += 1
            }
        }
    }
    document["persistent-apps"] = after
    if offline {
        guard values["--input"] != values["--output"] else { try fail("Input and output must differ") }
        if !restore, changed > 0, let backup = values["--backup"] {
            try writePlist(backupDocument, backup, exclusive: true)
        }
        try writePlist(document, values["--output"]!, exclusive: true)
    } else if apply && changed > 0 {
        // Preserve other preference keys. Re-read just before changing this one.
        guard NSArray(array: try readDock()).isEqual(to: before) else { try fail("Dock entries changed during planning; retry") }
        if !restore { try writePlist(backupDocument, values["--backup"]!, exclusive: true) }
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
