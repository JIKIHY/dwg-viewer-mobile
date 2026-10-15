import SwiftUI

// DWG 뷰어 iOS 껍데기. 화면·변환은 전부 앱에 들어 있는 web 폴더(HTML/JS/WASM)가 하고,
// 여기서는 웹뷰를 띄우고 다른 앱에서 넘겨받은 파일과 공유(이미지 저장)만 이어 준다.
@main
struct DWGViewerApp: App {
    @StateObject private var bridge = WebBridge()

    var body: some Scene {
        WindowGroup {
            WebContainer(bridge: bridge)
                .ignoresSafeArea()
                .background(Color(red: 0x1B / 255, green: 0x1D / 255, blue: 0x21 / 255))
                .preferredColorScheme(.dark)
                .onOpenURL { url in bridge.receive([url]) }
                #if DEBUG
                // 자동 테스트: SIMCTL_CHILD_DWGV_TEST_OPEN=도면경로(| 로 구분) 로 실행하면 다른 앱에서 연 것처럼 넘긴다
                .task {
                    if let f = ProcessInfo.processInfo.environment["DWGV_TEST_FOLDER"] { bridge.debugLink(f) }
                    if let p = ProcessInfo.processInfo.environment["DWGV_TEST_OPEN"] {
                        // 상대경로는 앱 Documents 기준 (실기기에 devicectl로 복사한 시험 도면)
                        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                        bridge.receive(p.split(separator: "|").map { s in
                            s.hasPrefix("/") ? URL(fileURLWithPath: String(s)) : docs.appendingPathComponent(String(s))
                        })
                    }
                }
                #endif
        }
    }
}
