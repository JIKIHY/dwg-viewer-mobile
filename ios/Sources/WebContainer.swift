import SwiftUI
import WebKit
import UniformTypeIdentifiers

// 웹 화면을 app://local/ 로 띄운다. file:// 로 열면 WASM·워커를 못 불러오기 때문에
// 앱 안의 web 폴더를 직접 내려주는 주소 체계(WKURLSchemeHandler)를 쓴다.
struct WebContainer: UIViewRepresentable {
    let bridge: WebBridge

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(bridge, forURLScheme: WebBridge.scheme)
        cfg.userContentController.add(bridge, name: "native")
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "nativeReply") // 응답이 필요한 요청
        cfg.websiteDataStore = .default() // 최근 도면(IndexedDB) 유지
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 0x1B / 255, green: 0x1D / 255, blue: 0x21 / 255, alpha: 1)
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { wv.isInspectable = true } // Mac 사파리 → 개발자용 메뉴에서 확인
        #endif
        bridge.webView = wv
        wv.navigationDelegate = bridge
        var q = ""
        #if DEBUG
        q = ProcessInfo.processInfo.environment["DWGV_TEST_QUERY"].map { "?" + $0 } ?? "" // 예: bench
        #endif
        wv.load(URLRequest(url: URL(string: "\(WebBridge.scheme)://local/index.html\(q)")!))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class WebBridge: NSObject, ObservableObject, WKURLSchemeHandler, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate, WKNavigationDelegate {
    static let scheme = "app"
    weak var webView: WKWebView?
    private var ready = false
    private var pending: [[String: String]] = []
    private var pickMode = "open"
    private let lib = FolderLibrary()
    private var folderReply: ((Any?, String?) -> Void)?
    private var inbox: [String: Data] = [:] // 다른 앱에서 받은 파일 (웹이 fetch로 가져가면 지운다)
    private let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web")

    // MARK: 다른 앱에서 넘겨받은 파일
    func receive(_ urls: [URL], mode: String = "open") {
        var items: [[String: String]] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = FolderLibrary.read(url) else { NSLog("[DWG] %@", "파일 읽기 실패: \(url.path)"); continue }
            NSLog("[DWG] %@", "파일 받음: \(url.lastPathComponent) \(data.count) bytes")
            // 앱 Documents/Inbox 로 복사돼 온 파일은 내용을 받았으니 지운다 (보관은 웹의 최근 도면이 맡음)
            let copied = url.path.contains("/Inbox/") || url.path.contains("-Inbox/") || url.path.hasPrefix(FileManager.default.temporaryDirectory.path)
            var item = ["name": url.lastPathComponent, "url": stash(data)]
            if copied { try? FileManager.default.removeItem(at: url) } else { item["path"] = url.standardizedFileURL.path } // 원본 위치 = XREF 상대경로 기준
            items.append(item)
        }
        guard !items.isEmpty else { return }
        if ready { deliver(items, mode: mode) } else { pending += items }
    }

    #if DEBUG
    func debugLink(_ path: String) {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : docs.appendingPathComponent(path)
        lib.queue.sync { lib.link(url) }
    }
    #endif

    private func stash(_ data: Data) -> String {
        let id = UUID().uuidString
        inbox[id] = data
        return "\(Self.scheme)://local/__inbox/\(id)"
    }

    private func deliver(_ items: [[String: String]], mode: String = "open") {
        guard let json = try? JSONSerialization.data(withJSONObject: items),
              let s = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__nativeOpen(\(s), '\(mode)'); 0") { _, err in
            if let err { NSLog("[DWG] %@", "웹에 전달 실패: \(err)") }
        }
    }

    // MARK: 파일 선택창 (웹뷰의 <input type=file> 은 DWG를 회색으로 막는 경우가 있어 앱 쪽 선택창을 쓴다)
    private func presentPicker(mode: String) {
        guard let wv = webView, let root = wv.window?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        pickMode = mode
        let picker: UIDocumentPickerViewController
        if mode == "folder" {
            picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        } else {
            var types: [UTType] = [.data]
            for id in ["com.autodesk.dwg", "com.autodesk.dxf"] { if let t = UTType(id) { types.insert(t, at: 0) } }
            picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.allowsMultipleSelection = true
        }
        picker.delegate = self
        top.present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        if pickMode == "folder" {
            let reply = folderReply
            folderReply = nil
            lib.queue.async {
                for u in urls { self.lib.link(u) }
                let list = self.folderList()
                DispatchQueue.main.async { reply?(list, nil) }
            }
            return
        }
        receive(urls, mode: pickMode)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        if pickMode == "folder" { folderReply?(nil, nil); folderReply = nil }
    }

    // MARK: 응답이 필요한 요청 (웹: await webkit.messageHandlers.nativeReply.postMessage(...))
    private func folderList() -> [[String: String]] { lib.folders.map { ["name": $0.lastPathComponent] } }

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { replyHandler(nil, "잘못된 요청"); return }
        let done: (Any?) -> Void = { v in DispatchQueue.main.async { replyHandler(v, nil) } }
        switch type {
        case "folders":
            lib.queue.async { done(self.folderList()) }
        case "linkFolder":
            folderReply?(nil, nil)
            folderReply = replyHandler
            presentPicker(mode: "folder")
        case "unlinkFolder":
            let i = body["index"] as? Int ?? -1
            lib.queue.async { self.lib.unlink(i); done(self.folderList()) }
        case "listDrawings":
            let refresh = body["refresh"] as? Bool ?? false
            lib.queue.async {
                if refresh { self.lib.invalidate() }
                done(self.lib.drawings().map { ["name": $0.name, "path": $0.url.path, "rel": $0.rel, "folder": $0.folder] })
            }
        case "readFile", "findXref":
            lib.queue.async {
                let url: URL?
                if type == "readFile" { url = (body["path"] as? String).map { URL(fileURLWithPath: $0) } }
                else { url = self.lib.resolve(ref: body["ref"] as? String ?? "", host: body["host"] as? String) }
                guard let u = url, let data = FolderLibrary.read(u) else {
                    if type == "findXref" { NSLog("[DWG] %@", "XREF 못 찾음: \(body["ref"] ?? "")") }
                    done(nil); return
                }
                DispatchQueue.main.async {
                    replyHandler(["name": u.lastPathComponent, "path": u.path, "url": self.stash(data)], nil)
                }
            }
        default:
            replyHandler(nil, "알 수 없는 요청: \(type)")
        }
    }

    // MARK: 웹 → 앱 메시지
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            if !pending.isEmpty { deliver(pending); pending = [] }
        case "log":
            NSLog("[DWG] %@", "\(body["msg"] as? String ?? "")")
        case "pick":
            presentPicker(mode: body["mode"] as? String ?? "open")
        case "share":
            guard let name = body["name"] as? String, let dataUrl = body["dataUrl"] as? String,
                  let comma = dataUrl.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else { return }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try? data.write(to: file)
            share(file)
        default: break
        }
    }

    private func share(_ file: URL) {
        guard let wv = webView, let root = wv.window?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let vc = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let pop = vc.popoverPresentationController { // 아이패드
            pop.sourceView = wv
            pop.sourceRect = CGRect(x: wv.bounds.midX, y: wv.bounds.maxY - 80, width: 1, height: 1)
        }
        top.present(vc, animated: true)
    }

    // 웹 화면 프로세스가 iOS에 의해 꺼지면(메모리 초과 등) 기록하고 처음 화면으로 다시 띄운다
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[DWG] %@", "웹 화면 프로세스 종료됨 (메모리 초과 가능성) — 다시 불러옴")
        ready = false
        webView.reload()
    }

    // MARK: app://local/… 내려주기
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path.removingPercentEncoding ?? url.path
        var data: Data?
        var mime = "application/octet-stream"
        if path.hasPrefix("/__inbox/") {
            let id = String(path.dropFirst("/__inbox/".count))
            data = inbox.removeValue(forKey: id)
        } else {
            let rel = path == "/" ? "index.html" : String(path.dropFirst())
            let file = webRoot.appendingPathComponent(rel).standardizedFileURL
            if file.path.hasPrefix(webRoot.standardizedFileURL.path) { data = try? Data(contentsOf: file) }
            mime = Self.mimeType(file.pathExtension)
        }
        guard let body = data else {
            let r = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!
            task.didReceive(r)
            task.didFinish()
            return
        }
        let headers = ["Content-Type": mime, "Content-Length": String(body.count), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(body)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "wasm": return "application/wasm"
        case "json", "webmanifest": return "application/json"
        case "png": return "image/png"
        case "txt": return "text/plain; charset=utf-8"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
