# DWG 뷰어 모바일 (iPhone/iPad, 웹 겸용)

데스크톱 `../dwg-viewer`(Electron)의 휴대폰판. 응답·주석은 한국어 존댓말.
DWG는 기기 안에서 LibreDWG WASM(`@mlightcad/libredwg-web` 0.8.0의 `dwg_write_dxf`)으로 DXF 변환 → 데스크톱과 같은 코어로 해석·표시한다. 인터넷 불필요.

## 구조
- `web/` — 화면 전체 (그대로 iOS 앱에 들어가고, 웹 서버에 올리면 PWA로도 동작)
  - `core/dxf.js scene.js view.js`, `vendor/earcut.min.js` — **데스크톱 코어 복사본. 여기서 고치지 말 것.** 데스크톱에서 고친 뒤 `./sync-core.sh`
  - `convert-worker.js` — DWG→DXF 워커(모듈 워커). 변환이 끝나 1.5초 쉬면 `app.js`가 워커를 종료해 WASM 메모리를 돌려준다 (38MB DWG 변환 시 ~3GB까지 늘어남)
  - `store.js` — 최근 도면 보관(IndexedDB, 원본 파일 내용 저장, 30개/300MB). XREF도 파일명으로 여기서 찾는다
  - `app.js` — 모바일 UI: 터치(한 손가락 이동·관성, 두 손가락 확대, 두 번 탭 확대), 측정(화면 가운데 십자선 + 스냅, 또는 탭한 자리에 스냅), 아래 시트(레이어·검색·측정·XREF·더보기)
  - XREF: 여러 파일을 함께 고르면 어느 것을 열지 묻고 나머지는 XREF 후보. 경로는 무시하고 파일명(NFC·소문자)으로 매칭
- `ios/` — SwiftUI + WKWebView 껍데기 (xcodegen `project.yml`)
  - `app://local/` 주소 체계(WKURLSchemeHandler)로 번들의 `web/`을 내려준다 (file:// 로는 WASM·워커 불가)
  - 다른 앱의 "다른 앱으로 열기"(DWG/DXF UTI 등록) → `app://local/__inbox/<id>` 로 웹에 넘김 → `window.__nativeOpen`
  - 웹 → 앱: `webkit.messageHandlers.native` (`ready`, `share`=PNG 공유시트, `pick`=앱 파일 선택창, `log`=콘솔 출력 `[DWG]`)
  - 앱에서는 웹의 `<input type=file>`을 쓰지 않는다 — 실기기에서 도면이 안 열렸던 원인. 열기·XREF 지정 모두 `UIDocumentPickerViewController`
- 실기기 자동 시험(Debug 빌드): `devicectl device copy to --domain-type appDataContainer --domain-identifier com.jgh.DWGViewer --destination Documents/x.dwg` 후 `devicectl device process launch --console --environment-variables '{"DWGV_TEST_OPEN":"x.dwg"}'` → `[DWG]` 로그 확인. iPhone 15 Pro에서 S-123 변환 0.56초 확인됨

## 빌드·실행
- 웹 확인: `python3 -m http.server 8765 --directory web` 후 브라우저 폰 크기로. 개발 훅 `window.__dwg = { S, view, openFiles, openMain, pool }`
- iOS: `cd ios && xcodegen generate && open DWGViewer.xcodeproj` → 팀 선택 후 실기기 실행
- 시뮬레이터 자동 테스트: `SIMCTL_CHILD_DWGV_TEST_OPEN=<dwg 경로> xcrun simctl launch --terminate-running-process booted com.jgh.DWGViewer` (DEBUG 빌드만)
- 팀 ID는 MeetNote와 같은 `Y78CLWCDMD`. 유료 팀으로 바꾸면 `project.yml`의 DEVELOPMENT_TEAM 교체

## 미지원 / 다음 후보
인쇄·CTB(데스크톱 전용), XREF 수동 부착(삽입점 지정), 배치(레이아웃) 탭, 안드로이드 앱 포장(지금은 웹 PWA로만), 대용량(30MB+) DWG 실기기 메모리 검증
