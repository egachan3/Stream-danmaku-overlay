#!/bin/bash
# Chrome Web Store提出用のファイル一式（dist/）とzipを作成するスクリプト。
#
# リポジトリにコミットしている .js は開発用にコメント（日本語の説明文）を
# 残したままにしているが、提出物にはコメントを含める必要がないため、
# 別途 --removeComments 付きでコンパイルし直したものを dist/ に集約する。
# .ts ソース・コミット済みの .js には一切手を加えない。
set -euo pipefail

cd "$(dirname "$0")/.."

RELEASE_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$RELEASE_TMP_DIR"' EXIT

echo "1/3 コメントを除去してコンパイルしています..."
npx tsc --removeComments --outDir "$RELEASE_TMP_DIR"

echo "2/3 dist/ に必要なファイルを集めています..."
rm -rf dist
mkdir -p dist/sites dist/icons
cp manifest.json popup.html dist/
cp icons/icon16.png icons/icon48.png icons/icon128.png dist/icons/
cp "$RELEASE_TMP_DIR/overlay.js" "$RELEASE_TMP_DIR/popup.js" dist/
cp "$RELEASE_TMP_DIR/sites/youtube.js" "$RELEASE_TMP_DIR/sites/twitch.js" dist/sites/

echo "3/3 zipを作成しています..."
rm -f stream-danmaku-overlay.zip
(cd dist && zip -r -q ../stream-danmaku-overlay.zip . -x ".*")

echo ""
echo "完了しました。"
du -sh dist
ls -lh stream-danmaku-overlay.zip
