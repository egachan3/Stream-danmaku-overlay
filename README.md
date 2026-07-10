# Stream Danmaku Overlay

YouTube Live・Twitch のライブチャットを、配信画面の上にオーバーレイ表示する Chrome 拡張機能。

要件・仕様の詳細は [REQUIREMENTS.md](REQUIREMENTS.md)、実装ステップの進捗は [docs/design.md](docs/design.md)、プライバシーポリシーは [docs/privacy-policy.md](docs/privacy-policy.md) を参照。

不具合を見つけた場合は、[不具合報告フォーム](https://forms.gle/N2UCgSfa6JucbHq19) または [GitHub Issues](https://github.com/egachan3/Stream-danmaku-overlay/issues) からご報告ください。

## Features / 特徴

Written in vanilla TypeScript and CSS (no libraries, no bundler)
Vanilla TypeScriptとCSSで書かれています（ライブラリ・バンドラー不使用）

Works on both YouTube Live and Twitch, including archived (VOD) chat replay
YouTube Live・Twitchのどちらにも対応、録画（VOD）のチャットリプレイにも対応しています

Two display styles available: flowing danmaku-style or stacked native-chat-style
弾幕のように流れる表示と、ネイティブチャット風に積み上がる表示を切り替え可能です

Font size, opacity, and stack position are customizable
文字サイズ・不透明度・積み上げ位置をカスタマイズ可能です

Works in fullscreen and theater mode
全画面表示・シアターモードでも動作します

No account, API key, or external server required — everything works via local DOM observation
アカウント登録やAPIキー、外部サーバーは不要。すべてローカルのDOM監視だけで動作します

Settings are stored only on your device (chrome.storage.local); nothing is sent externally
設定は端末内（chrome.storage.local）にのみ保存され、外部への送信は一切行いません

## スクリーンショット

### 積み上げ型

コメントが画面端に下から積み上がっていく、ネイティブのチャット欄に近いスタイル。

![積み上げ型の表示例](docs/images/screenshot-stack-mode.png)

### 横スクロール型（弾幕表示）

コメントが右から左へ画面を横切って流れる、ニコニコ動画の弾幕表示に近いスタイル。

![横スクロール型の表示例](docs/images/screenshot-flow-mode.png)

### 設定ポップアップ

表示ON/OFF・文字サイズ・不透明度・表示スタイルの切り替えを1画面で操作できる。

<table>
  <tr>
    <td align="center"><img src="docs/images/screenshot-popup.png" width="260" alt="設定ポップアップの画面（日本語）" /></td>
    <td align="center"><img src="docs/images/screenshot-popup-en.png" width="260" alt="Settings popup (English)" /></td>
  </tr>
</table>

スクリーンショットの配信画面はGON様より引用させていただいてます。

- https://www.twitch.tv/gon_vl
- https://www.twitch.tv/gon_vl/clip/FuriousAlertTofuSoBayed-zvGWQo2eSK3wJsDi

## 免責事項

本拡張機能の利用によって生じたいかなる損害についても、開発者は一切の責任を負いません。
また、本拡張機能は個人が非営利で開発・公開しているものであり、業として開発・提供するものではないため、日本国内における株式会社ドワンゴの特許権を侵害するものではありません。
