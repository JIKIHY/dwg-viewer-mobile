import Foundation

// 사용자가 한 번 연결한 도면 폴더(파일 앱·iCloud Drive·외장 등)를 기억하고,
// 그 안에서 데스크톱 main.js의 resolveXref와 같은 방식으로 XREF를 찾는다.
// iOS는 고른 파일 하나에만 접근을 허락하므로, 이웃 폴더의 XREF를 읽으려면 상위 폴더 연결이 필요하다.
final class FolderLibrary {
    struct Entry { let name: String; let url: URL; let rel: String; let folder: String }

    private let key = "linkedFolders"
    private(set) var folders: [URL] = []
    private var index: [String: [Entry]]? = nil // 파일명(NFC 소문자) → 후보
    private var all: [Entry] = []
    let queue = DispatchQueue(label: "dwg.folders") // 폴더 훑기·파일 읽기는 이 줄에서

    init() { restore() }

    static func norm(_ s: String) -> String { s.precomposedStringWithCanonicalMapping.lowercased() }

    // MARK: 연결 기억 (보안 범위 북마크)
    private func restore() {
        let datas = UserDefaults.standard.array(forKey: key) as? [Data] ?? []
        var fresh: [Data] = []
        for d in datas {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: d, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { continue }
            _ = url.startAccessingSecurityScopedResource() // 앱이 떠 있는 동안 계속 접근
            folders.append(url)
            fresh.append(stale ? ((try? url.bookmarkData()) ?? d) : d)
        }
        UserDefaults.standard.set(fresh, forKey: key)
    }

    private func save() {
        UserDefaults.standard.set(folders.compactMap { try? $0.bookmarkData() }, forKey: key)
    }

    func link(_ url: URL) {
        _ = url.startAccessingSecurityScopedResource()
        if folders.contains(where: { $0.standardizedFileURL == url.standardizedFileURL }) { return }
        folders.append(url)
        save()
        index = nil
    }

    func unlink(_ i: Int) {
        guard folders.indices.contains(i) else { return }
        folders[i].stopAccessingSecurityScopedResource()
        folders.remove(at: i)
        save()
        index = nil
    }

    func invalidate() { index = nil }

    // MARK: 폴더 훑기
    // iCloud에서 아직 안 내려받은 파일은 ".이름.dwg.icloud" 자리표시로 보인다 → 실제 이름으로 바꿔 둔다
    private static func realName(_ name: String) -> String? {
        if name.hasPrefix(".") && name.hasSuffix(".icloud") { return String(name.dropFirst().dropLast(7)) }
        if name.hasPrefix(".") { return nil }
        return name
    }

    private func buildIndex() {
        var idx: [String: [Entry]] = [:]
        var list: [Entry] = []
        let fm = FileManager.default
        for folder in folders {
            let root = folder.standardizedFileURL.path
            guard let en = fm.enumerator(at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsPackageDescendants]) else { continue }
            for case let u as URL in en {
                if list.count > 50000 { break }
                let raw = u.lastPathComponent
                if raw.hasPrefix(".") && !raw.hasSuffix(".icloud") {
                    if (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { en.skipDescendants() }
                    continue
                }
                guard let name = Self.realName(raw) else { continue }
                let low = name.lowercased()
                guard low.hasSuffix(".dwg") || low.hasSuffix(".dxf") else { continue }
                let real = u.deletingLastPathComponent().appendingPathComponent(name).standardizedFileURL
                var rel = real.path
                if rel.hasPrefix(root) { rel = String(rel.dropFirst(root.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
                let e = Entry(name: name, url: real, rel: rel, folder: folder.lastPathComponent)
                list.append(e)
                idx[Self.norm(name), default: []].append(e)
            }
        }
        index = idx
        all = list.sorted { $0.rel.localizedStandardCompare($1.rel) == .orderedAscending }
    }

    func drawings() -> [Entry] {
        if index == nil { buildIndex() }
        return all
    }

    private func exists(_ url: URL) -> Bool {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) { return true }
        let ph = url.deletingLastPathComponent().appendingPathComponent("." + url.lastPathComponent + ".icloud")
        return fm.fileExists(atPath: ph.path)
    }

    // 데스크톱과 같은 순서: 도면 기준 상대경로 → 도면과 같은 폴더 → 연결 폴더 전체에서 파일명으로
    // (같은 이름이 여럿이면 XREF 경로 끝부분이 더 많이 맞고, 본 도면과 가까운 것)
    func resolve(ref: String, host: String?) -> URL? {
        let normRef = ref.replacingOccurrences(of: "\\", with: "/")
        let parts = normRef.split(separator: "/").map(String.init)
        guard var base = parts.last, !base.isEmpty else { return nil }
        if !base.lowercased().hasSuffix(".dwg") && !base.lowercased().hasSuffix(".dxf") { base += ".dwg" }
        if let host {
            let hostDir = URL(fileURLWithPath: host).deletingLastPathComponent()
            var tries: [URL] = []
            if normRef.hasPrefix("/") { tries.append(URL(fileURLWithPath: normRef)) }
            if !(normRef.count > 1 && Array(normRef)[1] == ":") { tries.append(hostDir.appendingPathComponent(normRef).standardizedFileURL) }
            tries.append(hostDir.appendingPathComponent(base))
            for t in tries where exists(t) && inLinked(t) { return t }
        }
        if index == nil { buildIndex() }
        guard let cands = index?[Self.norm(base)], !cands.isEmpty else { return nil }
        let refParts = parts.map(Self.norm)
        let hostParts = host.map { URL(fileURLWithPath: $0).deletingLastPathComponent().standardizedFileURL.pathComponents.map(Self.norm) } ?? []
        func score(_ e: Entry) -> (Int, Int) {
            let cp = e.url.pathComponents.map(Self.norm)
            var tail = 0
            while tail < min(cp.count, refParts.count), cp[cp.count - 1 - tail] == refParts[refParts.count - 1 - tail] { tail += 1 }
            var common = 0
            while common < min(cp.count, hostParts.count), cp[common] == hostParts[common] { common += 1 }
            return (tail, common)
        }
        return cands.max { score($0) < score($1) }?.url
    }

    private func inLinked(_ url: URL) -> Bool {
        let p = url.standardizedFileURL.path
        return folders.contains { p.hasPrefix($0.standardizedFileURL.path) }
    }

    // iCloud 자리표시 파일이면 내려받으면서 읽는다
    static func read(_ url: URL) -> Data? {
        var data: Data?
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &err) { u in data = try? Data(contentsOf: u) }
        if data == nil { data = try? Data(contentsOf: url) }
        return data
    }
}
