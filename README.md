# DWG 뷰어 (iPhone · iPad · 웹)

휴대폰에서 AutoCAD DWG/DXF 도면을 보는 무료 뷰어입니다. DWG 변환까지 기기 안에서 처리하며, 도면을 인터넷으로 보내지 않습니다.

## 바로 쓰기 (설치 없이)
**https://jikihy.github.io/dwg-viewer-mobile/**

iPhone·iPad: Safari에서 위 주소를 열고 **공유 → 홈 화면에 추가**를 누르면 앱처럼 쓸 수 있습니다. 한 번 열면 인터넷 없이도 동작합니다.

## 기능
- 한 손가락 이동, 두 손가락 확대, 두 번 탭 확대
- 레이어 켜고 끄기, 문자 검색, 배경 검정/흰색
- 거리·면적 측정(십자선 + 스냅), 현재 화면 이미지 저장·공유
- XREF: 본 도면과 XREF 파일을 함께 고르면 자동으로 붙습니다

## 구조
- `web/` — 화면 전체(HTML/JS/WASM). 웹 서버에 올리면 그대로 동작합니다.
- `ios/` — 같은 `web/`을 감싸는 iOS 앱(SwiftUI + WKWebView). `cd ios && xcodegen generate`
- 도면 해석 코어(`web/core/`)는 [Mac 버전](https://github.com/JIKIHY/dwg-viewer)과 같습니다.

로컬 실행: `python3 -m http.server 8765 --directory web`

## 라이선스
GNU General Public License v3.0 — [LICENSE](LICENSE)

DWG 변환에 [@mlightcad/libredwg-web](https://github.com/mlightcad/libredwg-web) 0.8.0 (GNU LibreDWG의 WebAssembly 빌드, GPLv3)을 포함합니다. 삼각 분할에 [earcut](https://github.com/mapbox/earcut) (ISC)을 사용합니다.
