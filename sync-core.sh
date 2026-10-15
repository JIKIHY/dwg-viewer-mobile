#!/bin/zsh
# 데스크톱 dwg-viewer의 도면 해석·표시 코어를 모바일로 복사합니다 (코어는 데스크톱에서만 고칩니다).
set -e
cd "$(dirname "$0")"
SRC=../dwg-viewer/renderer
cp "$SRC/dxf.js" "$SRC/scene.js" "$SRC/view.js" web/core/
cp "$SRC/vendor/earcut.min.js" web/vendor/
echo "코어 복사 완료: dxf.js scene.js view.js earcut"
