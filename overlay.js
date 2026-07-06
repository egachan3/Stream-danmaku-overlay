"use strict";
/**
 * overlay.ts
 *
 * ライブチャットオーバーレイの描画・設定管理を担当するモジュール。
 *
 * - module: "None" 構成のため import/export は使用不可。
 * - sites/youtube.ts などのサイト固有スクリプトから呼び出せるよう、
 *   グローバル名前空間 `LiveChatOverlay` として公開する。
 * - manifest.json の content_scripts で overlay.js → sites/youtube.js の順に
 *   同一グローバルスコープへ読み込まれる想定。
 */
(function () {
    "use strict";
    /** chrome.storage.local に保存する設定のキー */
    const STORAGE_KEY_ENABLED = "enabled";
    const STORAGE_KEY_FONT_SIZE = "fontSize";
    const STORAGE_KEY_OPACITY = "opacity";
    const STORAGE_KEY_DISPLAY_MODE = "displayMode";
    const STORAGE_KEY_STACK_POSITION = "stackPosition";
    /** 文字サイズの範囲・デフォルト値 */
    const DEFAULT_ENABLED = true;
    const DEFAULT_FONT_SIZE = 22;
    const MIN_FONT_SIZE = 12;
    const MAX_FONT_SIZE = 32;
    /**
     * コメントの不透明度の範囲・デフォルト値。
     * CSSの opacity プロパティにそのまま使えるよう、内部的には0〜1の小数で保持する
     * （popup.ts側のUIでは0〜100のパーセント整数値として扱い、保存・読み込み時に変換する）。
     */
    const DEFAULT_OPACITY = 0.6;
    const MIN_OPACITY = 0.1;
    const MAX_OPACITY = 1;
    const DEFAULT_DISPLAY_MODE = "stack";
    const DEFAULT_STACK_POSITION = "left";
    /** オーバーレイ本体のz-indexのデフォルト値（サイト側からsetZIndex()で上書きされる） */
    const DEFAULT_Z_INDEX = 2000;
    /** オーバーレイのDOM要素ID・クラス名 */
    const OVERLAY_WRAPPER_ID = "live-chat-overlay-wrapper";
    const OVERLAY_ROOT_ID = "live-chat-overlay-root";
    const FLOW_ROOT_ID = "live-chat-overlay-flow-root";
    const COMMENT_LIST_CLASS = "live-chat-overlay-list";
    const COMMENT_ITEM_CLASS = "live-chat-overlay-item";
    const FLOW_ITEM_CLASS = "live-chat-overlay-flow-item";
    const STYLE_ELEMENT_ID = "live-chat-overlay-style";
    /**
     * コメント要素のフォントファミリー。CSS（.${COMMENT_ITEM_CLASS} / .${FLOW_ITEM_CLASS}）と
     * measureTextWidth() の両方でこの定数を参照することで、CSS側だけ変更してcanvas側の
     * 計測用フォント指定が追従し忘れる（計測値と実描画幅がズレる）ドリフトを防ぐ。
     */
    const COMMENT_FONT_FAMILY = "sans-serif";
    /**
     * 流れる型：画面横断の移動速度（px/ms）。
     * 移動時間を固定するのではなく速度を固定することで、文字数（表示幅）に
     * 関わらず全コメントが同じ速さで流れるようにする（ニコニコ動画の弾幕表示と
     * 同じ考え方）。0.2px/ms（＝秒速200px）は読みやすさを狙った目安値であり、
     * 将来的な微調整の余地がある。
     */
    const FLOW_SPEED_PX_PER_MS = 0.2;
    /** 流れる型：1行あたりの高さを計算する際の行間係数 */
    const FLOW_LINE_HEIGHT_FACTOR = 1.4;
    /**
     * 流れる型のコメント幅を事前計測するための、DOMに追加しない専用canvas。
     * measureTextWidth() 専用に一度だけ生成して使い回す（毎回生成すると無駄なため）。
     */
    const textMeasureCanvas = document.createElement("canvas");
    const textMeasureCtx = textMeasureCanvas.getContext("2d");
    /**
     * Canvas 2D APIの measureText() を使い、指定テキストの表示幅を事前計算する。
     * 従来はDOMに要素を追加した直後に offsetWidth を読み取っていたが、この方式は
     * ブラウザに強制的な同期レイアウト計算（forced synchronous layout）を発生させ、
     * コメントが大量に届く場面でメインスレッドを圧迫しカクつきの原因になっていた。
     * measureText() はレイアウトを介さずに幅を計算できるため、この問題を回避できる。
     *
     * ctx.font には .${FLOW_ITEM_CLASS} に適用されているCSSのフォント指定
     * （font-family: sans-serif、フォントサイズは呼び出し元が渡すpx値）と
     * 一致する値を設定し、実際の描画幅とのズレを最小限にしている。
     * ただしCanvasでの計測値とDOMでの実際の描画幅には多少の誤差が生じ得るが、
     * 視覚的な影響はコメントが画面外へ消えるタイミングが多少前後する程度で軽微であり、
     * 許容範囲としている。
     */
    function measureTextWidth(text, fontSize) {
        if (!textMeasureCtx) {
            // Canvas 2D コンテキストが取得できない環境では計測不能なため、
            // フォールバックとして文字数からの粗い概算値を返す。
            return text.length * fontSize;
        }
        textMeasureCtx.font = `${fontSize}px ${COMMENT_FONT_FAMILY}`;
        return textMeasureCtx.measureText(text).width;
    }
    /** 現在の設定値（storageから読み込み後に更新される） */
    let currentEnabled = DEFAULT_ENABLED;
    let currentFontSize = DEFAULT_FONT_SIZE;
    let currentOpacity = DEFAULT_OPACITY;
    let currentDisplayMode = DEFAULT_DISPLAY_MODE;
    let currentStackPosition = DEFAULT_STACK_POSITION;
    /** オーバーレイ本体のz-index。サイト固有スクリプトからsetZIndex()で更新される想定。 */
    let currentZIndex = DEFAULT_Z_INDEX;
    /**
     * オーバーレイの位置・サイズ計算の基準となる動画要素。
     * sites/youtube.ts側から setVideoElement() で指定される。
     */
    let videoEl = null;
    /** 動画要素のサイズ変化を監視する ResizeObserver（動画要素が判明してから生成する） */
    let resizeObserver = null;
    /**
     * 動画要素の画面内可視性を監視する IntersectionObserver
     * （動画要素が判明してから生成する）。
     * スクロールで動画要素が画面外に出た際、position: fixed のオーバーレイが
     * 座標だけを追従して他のUIに重なって表示され続けてしまう問題への対応。
     */
    let intersectionObserver = null;
    /**
     * 動画要素が画面内にどれだけでも見えているかどうか。
     * IntersectionObserver 生成前（動画要素未判明時）は true 扱いとし、
     * ユーザー設定（currentEnabled）側の判定のみが効くようにする。
     */
    let isVideoIntersecting = true;
    /** オーバーレイ専用のラッパー要素（position: absolute を持つ自前div）への参照 */
    let overlayWrapperEl = null;
    /** オーバーレイのルート要素（積み上げ型）・コメントリスト要素への参照 */
    let overlayRootEl = null;
    let commentListEl = null;
    /** 流れる型専用のルート要素（幅100%、積み上げ型とは別コンテナ）への参照 */
    let flowRootEl = null;
    /**
     * 流れる型のレーン（行）管理。
     * 各要素は「そのレーンが次に使用可能になる時刻（performance.now()基準）」。
     * 配列のインデックスがそのままレーン番号（＝表示するY座標の行番号）に対応する。
     */
    let flowLaneAvailableAt = [];
    /**
     * scroll イベントを requestAnimationFrame でスロットリングするための
     * 予約済みフレームID。null の場合は次の scroll 発火時に新規予約する。
     * 同一フレーム中に複数回 scroll が発火しても updateOverlayPosition() の
     * 呼び出しは1回にまとめられる。
     */
    let scrollUpdateRafId = null;
    /**
     * 動画要素切り替え直後の追加座標再計算（requestAnimationFrame連続実行）を
     * キャンセルするためのID。新たな切り替えが発生した場合、前回分の
     * 再計算ループを止めてから新しいループを開始する。
     */
    let videoChangeRafId = null;
    /**
     * 動画要素切り替え直後の追加座標再計算（setTimeout）のIDリスト。
     * 新たな切り替えが発生した場合、前回分をすべてクリアする。
     */
    let videoChangeTimeoutIds = [];
    /**
     * オーバーレイ全体のスタイルを定義する <style> 要素を挿入する。
     * すでに存在する場合は何もしない。
     */
    function ensureStyleElement() {
        if (document.getElementById(STYLE_ELEMENT_ID)) {
            return;
        }
        const style = document.createElement("style");
        style.id = STYLE_ELEMENT_ID;
        style.textContent = `
      #${OVERLAY_WRAPPER_ID} {
        /* 動画コンテナ側のスタイル（position等）には一切依存せず、
           ビューポート基準の position: fixed で自身の位置・サイズを直接指定する。
           top/left/width/height の実際の値は JS 側で動画要素の
           getBoundingClientRect() から都度計算して設定する。 */
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: 0;
        pointer-events: none;
        /* YouTubeヘッダー（#masthead-container）の z-index: 2020 より低い値にする。
           z-index の数値が明確に異なる場合、CSSの重なり順はDOM順序に関係なく
           数値が大きい方が勝つため、通常コンテンツより上・ヘッダーより下となる
           値を指定することでヘッダーへの重なりを防ぐ。
           CSSカスタムプロパティ経由にしているのは、サイト固有スクリプト
           （sites/twitch.tsなど）がJSのsetZIndex()経由で動的に値を上書きできる
           ようにするため。Twitchはシアターモード/全画面時のみ動画プレイヤーが
           前面に出るため、状態に応じてz-indexを切り替える必要がある。 */
        z-index: var(--live-chat-overlay-z-index, 2000);
        overflow: hidden;
      }
      #${OVERLAY_ROOT_ID} {
        position: absolute;
        top: 0;
        right: 0;
        left: auto;
        width: 22%;
        height: 100%;
        pointer-events: none;
        display: flex;
        align-items: flex-end;
        overflow: hidden;
        box-sizing: border-box;
      }
      #${OVERLAY_ROOT_ID}.live-chat-overlay-position-left {
        right: auto;
        left: 0;
      }
      #${OVERLAY_ROOT_ID}.live-chat-overlay-hidden,
      #${OVERLAY_ROOT_ID}.live-chat-overlay-offscreen,
      #${OVERLAY_ROOT_ID}.live-chat-overlay-mode-inactive {
        display: none;
      }
      #${FLOW_ROOT_ID} {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        overflow: hidden;
        box-sizing: border-box;
      }
      #${FLOW_ROOT_ID}.live-chat-overlay-hidden,
      #${FLOW_ROOT_ID}.live-chat-overlay-offscreen,
      #${FLOW_ROOT_ID}.live-chat-overlay-mode-inactive {
        display: none;
      }
      .${COMMENT_LIST_CLASS} {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        width: 100%;
        height: 100%;
        overflow: hidden;
        padding: 4px 8px;
        box-sizing: border-box;
        pointer-events: none;
      }
      .${COMMENT_ITEM_CLASS} {
        color: #ffffff;
        text-shadow:
          -1px -1px 0 #000,
          1px -1px 0 #000,
          -1px 1px 0 #000,
          1px 1px 0 #000;
        font-family: ${COMMENT_FONT_FAMILY};
        line-height: 1.4;
        word-break: break-word;
        margin-top: 2px;
      }
      .${FLOW_ITEM_CLASS} {
        position: absolute;
        left: 0;
        white-space: nowrap;
        color: #ffffff;
        text-shadow:
          -1px -1px 0 #000,
          1px -1px 0 #000,
          -1px 1px 0 #000,
          1px 1px 0 #000;
        font-family: ${COMMENT_FONT_FAMILY};
        will-change: transform;
      }
    `;
        document.head.appendChild(style);
    }
    /**
     * オーバーレイのルート要素・ラッパー要素を生成する（未生成の場合のみ）。
     */
    function createOverlayElement() {
        if (overlayRootEl) {
            return overlayRootEl;
        }
        ensureStyleElement();
        // オーバーレイ専用のラッパー要素。position: absolute はこの自前div側にのみ
        // 設定し、動画コンテナ本体のスタイルは書き換えない（YouTube本体のレイアウトへの
        // 影響を避けるため）。
        const wrapper = document.createElement("div");
        wrapper.id = OVERLAY_WRAPPER_ID;
        const root = document.createElement("div");
        root.id = OVERLAY_ROOT_ID;
        const list = document.createElement("div");
        list.className = COMMENT_LIST_CLASS;
        root.appendChild(list);
        wrapper.appendChild(root);
        // 流れる型専用のルート要素（幅100%）。積み上げ型（root）とは別コンテナとし、
        // 現在の表示モードに応じてどちらか一方だけを表示する。
        const flowRoot = document.createElement("div");
        flowRoot.id = FLOW_ROOT_ID;
        wrapper.appendChild(flowRoot);
        overlayWrapperEl = wrapper;
        overlayRootEl = root;
        commentListEl = list;
        flowRootEl = flowRoot;
        applyFontSize(currentFontSize);
        applyOpacity(currentOpacity);
        applyEnabled(currentEnabled);
        applyVisibility();
        applyDisplayMode(currentDisplayMode);
        applyStackPosition(currentStackPosition);
        setZIndex(currentZIndex);
        attachOverlayToDom();
        return root;
    }
    /**
     * オーバーレイ用ラッパー要素をDOMツリーに配置する。
     * position: fixed で自身の座標を直接指定する方式のため、配置先の親要素の
     * position・レイアウトには依存しない。通常時は document.body に、
     * 全画面表示中は全画面要素の子として配置する（Fullscreen APIの制約対応）。
     * 親要素自体のスタイルは一切書き換えない。
     *
     * ヘッダーとの重なり順は z-index（#${OVERLAY_WRAPPER_ID} の z-index: 2000、
     * YouTubeヘッダー #masthead-container の z-index: 2020）で制御しているため、
     * DOM挿入順序（先頭/末尾）は重なり順に影響しない。通常時・全画面時ともに
     * appendChild で配置先の子要素として追加すればよい。
     */
    function attachOverlayToDom() {
        if (!overlayWrapperEl) {
            return;
        }
        const parent = document.fullscreenElement ?? document.body;
        if (overlayWrapperEl.parentElement !== parent) {
            parent.appendChild(overlayWrapperEl);
        }
    }
    /**
     * 動画要素の getBoundingClientRect() を基に、オーバーレイラッパーの
     * position: fixed 用座標（top/left/width/height）を計算して反映する。
     * 動画コンテナ本体のDOM・スタイルには一切触れない。
     */
    function updateOverlayPosition() {
        if (!overlayWrapperEl || !videoEl) {
            return;
        }
        const rect = videoEl.getBoundingClientRect();
        overlayWrapperEl.style.top = `${rect.top}px`;
        overlayWrapperEl.style.left = `${rect.left}px`;
        overlayWrapperEl.style.width = `${rect.width}px`;
        overlayWrapperEl.style.height = `${rect.height}px`;
    }
    /**
     * scroll イベント発生時に呼び出すハンドラ。
     * YouTubeは内部に複数のスクロールコンテナを持つ可能性があるため、window
     * には capture: true で登録し、どのコンテナのスクロールでも拾えるようにする。
     * scroll は高頻度で発火するため、直接 updateOverlayPosition() を呼ばず
     * requestAnimationFrame でスロットリングする（1フレームにつき最大1回の実行）。
     */
    function scheduleUpdateOverlayPosition() {
        if (scrollUpdateRafId !== null) {
            return;
        }
        scrollUpdateRafId = requestAnimationFrame(() => {
            scrollUpdateRafId = null;
            updateOverlayPosition();
        });
    }
    /**
     * 動画要素を基準にオーバーレイの位置決めを開始する。
     * ResizeObserver で動画要素のサイズ変化（ウィンドウリサイズ・全画面切り替え・
     * レイアウト変更等）を監視し、変化のたびに座標を再計算する。
     */
    function observeVideoElement(el) {
        resizeObserver?.disconnect();
        resizeObserver = new ResizeObserver(() => {
            updateOverlayPosition();
        });
        resizeObserver.observe(el);
        updateOverlayPosition();
        observeVideoIntersection(el);
    }
    /**
     * 動画要素切り替え直後、短期間だけ追加で座標の再計算を行う。
     *
     * SPA遷移直後は動画要素自体のサイズが変わらないままページ全体の
     * レイアウトが後から確定するケースがあり、その場合 ResizeObserver は
     * 発火しないため、getBoundingClientRect() の結果が古いままになり
     * オーバーレイの位置がずれて見える（スクロールするまで直らない）。
     * これを避けるため、切り替え直後の数フレーム・数百msにわたって
     * updateOverlayPosition() を追加実行し、レイアウト確定後の座標に
     * 追従させる。
     */
    function scheduleVideoChangeRecalculation() {
        // 前回の動画切り替えに伴う再計算がまだ残っていればキャンセルする
        if (videoChangeRafId !== null) {
            cancelAnimationFrame(videoChangeRafId);
            videoChangeRafId = null;
        }
        for (const timeoutId of videoChangeTimeoutIds) {
            clearTimeout(timeoutId);
        }
        videoChangeTimeoutIds = [];
        // 数フレーム連続で再計算する（直後の細かいレイアウト変化に追従するため）
        const RAF_REPEAT_COUNT = 10;
        let rafCount = 0;
        const rafStep = () => {
            updateOverlayPosition();
            rafCount++;
            if (rafCount < RAF_REPEAT_COUNT) {
                videoChangeRafId = requestAnimationFrame(rafStep);
            }
            else {
                videoChangeRafId = null;
            }
        };
        videoChangeRafId = requestAnimationFrame(rafStep);
        // rAFループより長いスパンで発生するレイアウトシフト（画像・広告等の
        // 読み込み完了タイミング）にも追従できるよう、数百ms後にも再計算する
        const DELAYS_MS = [100, 300, 500, 1000];
        for (const delay of DELAYS_MS) {
            const timeoutId = window.setTimeout(() => {
                updateOverlayPosition();
            }, delay);
            videoChangeTimeoutIds.push(timeoutId);
        }
    }
    /**
     * 動画要素切り替え時、前の配信のコメント表示を引き継がないよう
     * オーバーレイをクリーンアップする。
     * - 積み上げ型：コメント一覧のDOM要素の中身をすべて削除する
     * - 流れる型：アニメーション中のコメント要素をすべて削除する。
     *   Web Animations APIの仕様上、要素をDOMから切り離しても進行中の
     *   Animationオブジェクト自体は自動キャンセルされないが、
     *   animation.finished解決時に呼ばれるitem.remove()は既にDOM外に
     *   ある要素への無害なno-opになるだけなので実害はない。
     *   あわせてレーンの空き状況（flowLaneAvailableAt）もリセットし、
     *   前の配信のタイミング情報を引き継がないようにする。
     */
    function resetOverlayContent() {
        if (commentListEl) {
            commentListEl.replaceChildren();
        }
        if (flowRootEl) {
            flowRootEl.replaceChildren();
        }
        flowLaneAvailableAt = [];
    }
    /**
     * 動画要素の画面内可視性を IntersectionObserver で監視する。
     * threshold: 0 とすることで「1pxでも画面内にあれば表示」というシンプルな
     * 判定にしている。動画要素が画面外に出た場合はオーバーレイを隠し、
     * 画面内に戻ったらユーザー設定がONであれば再表示する。
     */
    function observeVideoIntersection(el) {
        intersectionObserver?.disconnect();
        intersectionObserver = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) {
                return;
            }
            isVideoIntersecting = entry.isIntersecting;
            applyVisibility();
        }, { threshold: 0 });
        intersectionObserver.observe(el);
    }
    /**
     * オーバーレイの位置・サイズ計算の基準となる動画要素を外部（sites/youtube.tsなど）
     * から指定する。SPA遷移で動画要素が入れ替わった場合も、検知の都度呼び出すことで
     * 追従させる。
     */
    function setVideoElement(el) {
        if (!(el instanceof HTMLVideoElement)) {
            return;
        }
        const changed = videoEl !== el;
        videoEl = el;
        if (!overlayRootEl) {
            // 初回呼び出し時はここで生成するが、return はせず後続の
            // observeVideoElement() 呼び出しまで必ず到達させる
            // （そうしないと座標計算・ResizeObserver登録が一度も行われない）。
            createOverlayElement();
        }
        if (changed) {
            resetOverlayContent();
            observeVideoElement(el);
            scheduleVideoChangeRecalculation();
        }
    }
    /**
     * 別配信への切り替わりを検知した際に外部（sites/youtube.tsなど）から呼び出す公開API。
     * 既存の resetOverlayContent() をそのまま呼ぶだけで、前の配信のコメント表示
     * （積み上げ型・流れる型）とレーン状態をクリアする。
     */
    function resetForNewStream() {
        resetOverlayContent();
    }
    /**
     * オーバーレイ本体（overlayWrapperEl）のz-indexを外部（sites/twitch.tsなど）
     * から動的に指定する公開API。CSSカスタムプロパティ（--live-chat-overlay-z-index）
     * としてインラインスタイルに設定することで、<style>要素側のCSSを書き換えずに
     * 反映できるようにしている。
     * overlayWrapperElがまだ生成されていないタイミングで呼ばれる可能性があるため、
     * 他のcurrent○○系設定値と同様にcurrentZIndexとして保持しておき、
     * createOverlayElement()内でも適用する。
     */
    function setZIndex(zIndex) {
        // 入力値のバリデーション：数値以外・NaN・負数は無視する
        if (typeof zIndex !== "number" || Number.isNaN(zIndex) || zIndex < 0) {
            return;
        }
        currentZIndex = zIndex;
        overlayWrapperEl?.style.setProperty("--live-chat-overlay-z-index", String(zIndex));
    }
    /**
     * 全画面表示切り替え時のハンドラ。
     * Fullscreen API使用中は通常のDOM子要素が表示されなくなるため、
     * オーバーレイ要素を全画面要素の子として再配置し、座標も再計算する。
     */
    function handleFullscreenChange() {
        if (!overlayWrapperEl) {
            return;
        }
        attachOverlayToDom();
        updateOverlayPosition();
    }
    /**
     * 文字サイズをオーバーレイに反映する。
     */
    function applyFontSize(fontSize) {
        currentFontSize = fontSize;
        if (commentListEl) {
            commentListEl.style.fontSize = `${fontSize}px`;
        }
        if (flowRootEl) {
            flowRootEl.style.fontSize = `${fontSize}px`;
        }
    }
    /**
     * コメントの不透明度をオーバーレイに反映する。
     */
    function applyOpacity(opacity) {
        currentOpacity = opacity;
        if (commentListEl) {
            commentListEl.style.opacity = String(opacity);
        }
        if (flowRootEl) {
            flowRootEl.style.opacity = String(opacity);
        }
    }
    /**
     * ON/OFF設定をオーバーレイに反映する。
     * 表示スタイル（積み上げ型／流れる型）に関係なく、両方のコンテナに共通して
     * 適用する（表示/非表示の制御ロジックとモードの違いは独立させるため）。
     */
    function applyEnabled(enabled) {
        currentEnabled = enabled;
        overlayRootEl?.classList.toggle("live-chat-overlay-hidden", !enabled);
        flowRootEl?.classList.toggle("live-chat-overlay-hidden", !enabled);
    }
    /**
     * 動画要素の画面内可視性をオーバーレイに反映する。
     * 「ユーザー設定でOFF」（live-chat-overlay-hidden）とは別クラスで管理し、
     * どちらか一方でも該当すればCSS上は非表示になる（互いに競合しない）。
     * こちらも表示スタイルに関係なく両方のコンテナに共通して適用する。
     */
    function applyVisibility() {
        overlayRootEl?.classList.toggle("live-chat-overlay-offscreen", !isVideoIntersecting);
        flowRootEl?.classList.toggle("live-chat-overlay-offscreen", !isVideoIntersecting);
    }
    /**
     * 表示スタイル（積み上げ型／流れる型）をオーバーレイに反映する。
     * 選択中でない方のコンテナは非表示クラスで隠す。
     * ON/OFF・オフスクリーン判定用のクラス（live-chat-overlay-hidden /
     * live-chat-overlay-offscreen）と同じ「非表示クラスの付与」という形に揃えることで、
     * CSS詳細度の競合（インラインstyleとの優先度逆転）を避ける。
     */
    function applyDisplayMode(mode) {
        currentDisplayMode = mode;
        overlayRootEl?.classList.toggle("live-chat-overlay-mode-inactive", mode !== "stack");
        flowRootEl?.classList.toggle("live-chat-overlay-mode-inactive", mode !== "flow");
    }
    /**
     * 積み上げ型の表示位置（動画に対して右/左）をオーバーレイに反映する。
     * ON/OFF・表示スタイルと同様に、非表示クラス方式ではなく専用クラスの
     * 付与/除去で切り替えることで、インラインstyleとのCSS詳細度競合を避ける。
     */
    function applyStackPosition(position) {
        currentStackPosition = position;
        overlayRootEl?.classList.toggle("live-chat-overlay-position-left", position === "left");
    }
    /**
     * 文字サイズを有効範囲内にクランプする。
     */
    function clampFontSize(fontSize) {
        if (Number.isNaN(fontSize)) {
            return DEFAULT_FONT_SIZE;
        }
        return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, fontSize));
    }
    /**
     * コメントの不透明度を有効範囲内にクランプする。
     */
    function clampOpacity(opacity) {
        if (Number.isNaN(opacity)) {
            return DEFAULT_OPACITY;
        }
        return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, opacity));
    }
    /**
     * パネルの高さが埋まっている間、古いコメントから削除する。
     * 固定行数ではなく実際の高さ（scrollHeight vs clientHeight）で判定する。
     */
    function trimOldComments() {
        if (!commentListEl) {
            return;
        }
        // clientHeight が 0 の場合（レイアウト未確定・非表示状態など）は
        // 高さ基準の判定が機能せず、削除処理が全コメントを消し去ってしまう
        // （＝永久に表示されなくなる）おそれがあるため、判定自体をスキップする。
        if (commentListEl.clientHeight === 0) {
            return;
        }
        while (commentListEl.children.length > 0 &&
            commentListEl.scrollHeight > commentListEl.clientHeight) {
            commentListEl.removeChild(commentListEl.children[0]);
        }
    }
    /**
     * コメント本文のみのコメント要素を組み立てる。
     * 積み上げ型・流れる型で共通のDOM構造を使うための共通処理。
     * textContent経由で設定することでXSS（HTMLインジェクション）を防止する。
     */
    function buildCommentElement(className, trimmedText) {
        const item = document.createElement("div");
        item.className = className;
        item.textContent = trimmedText;
        return item;
    }
    /**
     * 積み上げ型のコメント描画処理。
     */
    function addCommentStack(trimmedText) {
        if (!commentListEl) {
            return;
        }
        const item = buildCommentElement(COMMENT_ITEM_CLASS, trimmedText);
        commentListEl.appendChild(item);
        trimOldComments();
    }
    /**
     * 流れる型（弾幕方式）：現在のパネル高さ・文字サイズから確保できる
     * レーン数を計算する。最低1行は確保する。
     */
    function getFlowLaneCount() {
        if (!flowRootEl) {
            return 1;
        }
        const panelHeight = flowRootEl.clientHeight;
        const lineHeight = currentFontSize * FLOW_LINE_HEIGHT_FACTOR;
        if (panelHeight <= 0 || lineHeight <= 0) {
            return 1;
        }
        return Math.max(1, Math.floor(panelHeight / lineHeight));
    }
    /**
     * 流れる型（弾幕方式）：新しいコメントを流すレーン（行番号）を選ぶ。
     * 空いている（現在時刻時点で使用可能な）レーンがあればそれを使い、
     * なければ最も早く空く見込みのレーンを使う。
     */
    function pickFlowLane(now) {
        const laneCount = getFlowLaneCount();
        // レーン数が変化した場合（文字サイズ変更・パネルリサイズ等）に合わせて配列を調整する
        if (flowLaneAvailableAt.length !== laneCount) {
            const next = new Array(laneCount).fill(0);
            for (let i = 0; i < Math.min(laneCount, flowLaneAvailableAt.length); i++) {
                next[i] = flowLaneAvailableAt[i];
            }
            flowLaneAvailableAt = next;
        }
        let bestLane = 0;
        let bestAvailableAt = Infinity;
        for (let i = 0; i < flowLaneAvailableAt.length; i++) {
            const availableAt = flowLaneAvailableAt[i];
            if (availableAt <= now) {
                // 即座に使える空きレーンが見つかったのでそれを採用する
                return i;
            }
            if (availableAt < bestAvailableAt) {
                bestAvailableAt = availableAt;
                bestLane = i;
            }
        }
        // 空きレーンがなければ、最も早く空く見込みのレーンを使う
        return bestLane;
    }
    /**
     * 流れる型（弾幕方式）のコメント描画処理。
     * 画面右端から左端まで固定速度（FLOW_SPEED_PX_PER_MS）で流れるアニメーションを
     * Web Animations API（Element.animate）で実装する。移動距離はコメントごとに
     * 異なる（表示幅が長いほど距離も長い）ため、durationはコメントごとに動的に計算する。
     */
    function addCommentFlow(trimmedText) {
        if (!flowRootEl) {
            return;
        }
        const containerWidth = flowRootEl.clientWidth;
        if (containerWidth <= 0) {
            return;
        }
        // DOM追加前にCanvasのmeasureText()で表示幅を計算する。DOM追加直後に
        // offsetWidthを読む方式は強制的な同期レイアウト計算を発生させ、コメントが
        // 大量に届く場面でカクつきの原因になっていたため、この方式に変更した。
        const itemWidth = measureTextWidth(trimmedText, currentFontSize);
        const item = buildCommentElement(FLOW_ITEM_CLASS, trimmedText);
        flowRootEl.appendChild(item);
        const now = performance.now();
        const laneIndex = pickFlowLane(now);
        const lineHeight = currentFontSize * FLOW_LINE_HEIGHT_FACTOR;
        item.style.top = `${laneIndex * lineHeight}px`;
        // 開始位置：コンテナ幅分右にオフセット（画面右端の外側からスタート）
        // 終了位置：コメント自身の表示幅分左にオフセット（画面左端の外側まで流れきる）
        // 移動距離は (containerWidth + itemWidth) で、速度は全コメント共通の
        // FLOW_SPEED_PX_PER_MS のため、durationはコメントごとの移動距離から動的に計算する。
        // これにより長文ほど距離は長くなるが速度自体は変わらない（＝長文ほど速くなる問題を解消）。
        const durationMs = (containerWidth + itemWidth) / FLOW_SPEED_PX_PER_MS;
        const animation = item.animate([
            { transform: `translateX(${containerWidth}px)` },
            { transform: `translateX(-${itemWidth}px)` },
        ], {
            duration: durationMs,
            easing: "linear",
            fill: "forwards",
        });
        // アニメーション終了後、DOMから要素を削除する
        animation.finished
            .then(() => {
            item.remove();
        })
            .catch(() => {
            // cancel()等でPromiseがrejectされた場合も念のため要素を削除しておく
            item.remove();
        });
        // レーンの解放時刻：このコメントの末尾（右端）が、次のコメントのスタート地点
        // （画面右端＝コンテナ右端）を完全に通過し終えるまでの時間を目安に計算する。
        // 速度が全コメント共通の定数（FLOW_SPEED_PX_PER_MS）になったため、
        // 末尾がスタート地点（移動距離 itemWidth の時点）を通過し終えるまでの所要時間は
        // 単純に itemWidth / FLOW_SPEED_PX_PER_MS で求まる（コメントごとの速度計算が不要になった）。
        // これにより、この解放時刻以降に出走したコメント同士は、後発が先発に追いつく
        // ことがなくなる（全コメントが同じ速度で流れるため）。ただし全レーンが
        // 埋まっている状況では pickFlowLane() が解放前のレーンを選ぶことがあり、
        // その場合は出走直後に一瞬重なって見えることがある（レーン枯渇時の
        // トレードオフであり、この修正で解消したのは「速度差による追い越し」のみ）。
        const occupancyMs = itemWidth / FLOW_SPEED_PX_PER_MS;
        if (laneIndex >= 0 && laneIndex < flowLaneAvailableAt.length) {
            flowLaneAvailableAt[laneIndex] = now + occupancyMs;
        }
    }
    /**
     * コメントを1件追加して描画する。
     * sites/youtube.ts など、サイト固有のDOM監視スクリプトから呼び出される公開API。
     * 現在の表示モード（積み上げ型／流れる型）に応じて描画処理を分岐させる。
     */
    function addComment(author, text) {
        // 入力値のバリデーション：文字列以外・空文字は無視する
        // author は公開API・データ取得側のシグネチャ維持のため引数として受け取るが、
        // 画面描画では使用しない（表示するのはコメント本文のみ）。
        if (typeof author !== "string" || typeof text !== "string") {
            return;
        }
        const trimmedText = text.trim();
        if (trimmedText.length === 0) {
            return;
        }
        if (!overlayRootEl || !commentListEl || !flowRootEl) {
            createOverlayElement();
        }
        if (currentDisplayMode === "flow") {
            addCommentFlow(trimmedText);
        }
        else {
            addCommentStack(trimmedText);
        }
    }
    /**
     * 表示スタイルの値を検証し、不正な値であればデフォルトにフォールバックする。
     */
    function normalizeDisplayMode(value) {
        return value === "flow" || value === "stack" ? value : DEFAULT_DISPLAY_MODE;
    }
    /**
     * 積み上げ型の表示位置の値を検証し、不正な値であればデフォルトにフォールバックする。
     */
    function normalizeStackPosition(value) {
        return value === "left" || value === "right" ? value : DEFAULT_STACK_POSITION;
    }
    /**
     * chrome.storage.local から設定を読み込み、現在値に反映する。
     */
    function loadSettings() {
        chrome.storage.local.get([
            STORAGE_KEY_ENABLED,
            STORAGE_KEY_FONT_SIZE,
            STORAGE_KEY_OPACITY,
            STORAGE_KEY_DISPLAY_MODE,
            STORAGE_KEY_STACK_POSITION,
        ], (items) => {
            const enabled = typeof items[STORAGE_KEY_ENABLED] === "boolean"
                ? items[STORAGE_KEY_ENABLED]
                : DEFAULT_ENABLED;
            const fontSize = clampFontSize(typeof items[STORAGE_KEY_FONT_SIZE] === "number"
                ? items[STORAGE_KEY_FONT_SIZE]
                : DEFAULT_FONT_SIZE);
            const opacity = clampOpacity(typeof items[STORAGE_KEY_OPACITY] === "number"
                ? items[STORAGE_KEY_OPACITY]
                : DEFAULT_OPACITY);
            const displayMode = normalizeDisplayMode(items[STORAGE_KEY_DISPLAY_MODE]);
            const stackPosition = normalizeStackPosition(items[STORAGE_KEY_STACK_POSITION]);
            applyEnabled(enabled);
            applyFontSize(fontSize);
            applyOpacity(opacity);
            applyDisplayMode(displayMode);
            applyStackPosition(stackPosition);
        });
    }
    /**
     * chrome.storage.onChanged を監視し、設定変更をリアルタイムに反映する。
     */
    function watchSettingsChanges() {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "local") {
                return;
            }
            if (changes[STORAGE_KEY_ENABLED]) {
                const newValue = changes[STORAGE_KEY_ENABLED].newValue;
                applyEnabled(typeof newValue === "boolean" ? newValue : DEFAULT_ENABLED);
            }
            if (changes[STORAGE_KEY_FONT_SIZE]) {
                const newValue = changes[STORAGE_KEY_FONT_SIZE].newValue;
                applyFontSize(clampFontSize(typeof newValue === "number" ? newValue : DEFAULT_FONT_SIZE));
            }
            if (changes[STORAGE_KEY_OPACITY]) {
                const newValue = changes[STORAGE_KEY_OPACITY].newValue;
                applyOpacity(clampOpacity(typeof newValue === "number" ? newValue : DEFAULT_OPACITY));
            }
            if (changes[STORAGE_KEY_DISPLAY_MODE]) {
                applyDisplayMode(normalizeDisplayMode(changes[STORAGE_KEY_DISPLAY_MODE].newValue));
            }
            if (changes[STORAGE_KEY_STACK_POSITION]) {
                applyStackPosition(normalizeStackPosition(changes[STORAGE_KEY_STACK_POSITION].newValue));
            }
        });
    }
    /**
     * 初期化処理：オーバーレイ要素の生成、設定読み込み、イベント監視の開始を行う。
     */
    function init() {
        createOverlayElement();
        loadSettings();
        watchSettingsChanges();
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        // content script は1ページにつき1回しかロードされないため、scroll監視は
        // ここで一度だけ登録すればよい（動画要素の切り替え時に再登録は不要）。
        // capture: true により、YouTube内の任意のスクロールコンテナ（ページ本体・
        // サイドパネル等）でのスクロールを取りこぼさず検知する。
        window.addEventListener("scroll", scheduleUpdateOverlayPosition, {
            passive: true,
            capture: true,
        });
    }
    init();
    // sites/youtube.ts などから利用できるようグローバルに公開する
    window.LiveChatOverlay = {
        addComment,
        setVideoElement,
        resetForNewStream,
        setZIndex,
        isEnabled: () => currentEnabled,
    };
})();
