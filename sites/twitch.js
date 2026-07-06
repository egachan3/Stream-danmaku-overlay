"use strict";
/**
 * sites/twitch.ts
 *
 * Twitch のチャットDOM監視を担当するモジュール。
 *
 * YouTubeと異なり、Twitchのチャットは別オリジンiframeではなく、メインページと
 * 同一ドキュメント内に存在する（実機のDevToolsで確認済み）。ページ内には広告・
 * 拡張機能用の複数のiframeが存在するが、チャットとは無関係であることも確認済み。
 * そのため、YouTube版のようなトップフレーム/iframeの分岐や、postMessageによる
 * フレーム間通信、隠しiframeによる「チャット欄を閉じても更新を止めない」回避策は
 * 一切不要で、単一コンテキストで完結する実装でよい。
 *
 * - module: "None" 構成のため import/export は使用不可。
 * - overlay.ts が読み込まれていればグローバル LiveChatOverlay を利用する。
 */
(function () {
    "use strict";
    /** チャットメッセージ一覧のコンテナのセレクタ */
    const CHAT_CONTAINER_SELECTOR = '[data-test-selector="chat-scrollable-area__message-container"]';
    /** メッセージ1件の要素のセレクタ */
    const CHAT_MESSAGE_SELECTOR = '[data-a-target="chat-line-message"]';
    /** 投稿者名の要素のセレクタ */
    const CHAT_AUTHOR_SELECTOR = '[data-a-target="chat-message-username"]';
    /** メッセージ本文の要素のセレクタ（テキストとエモート画像が混在する） */
    const CHAT_BODY_SELECTOR = '[data-a-target="chat-line-message-body"]';
    /** 録画（VOD）ページのチャットメッセージ一覧のコンテナのセレクタ */
    const VOD_CHAT_CONTAINER_SELECTOR = ".video-chat__message-list-wrapper";
    /** 録画（VOD）ページのメッセージ1件の要素のセレクタ */
    const VOD_CHAT_MESSAGE_SELECTOR = ".vod-message";
    /**
     * 本文の断片テキストの要素のセレクタ。ライブ配信・録画の両方の本文内に存在する
     * （実機で確認済み）。録画ページではCHAT_BODY_SELECTORに相当する
     * 「本文全体を包む1つの要素」が存在しないため、このセレクタで断片を集めて
     * 連結する必要がある。
     */
    const CHAT_TEXT_FRAGMENT_SELECTOR = '[data-a-target="chat-message-text"]';
    /**
     * シアターモード中の動画プレイヤーコンテナに付与されるクラス名（実機で確認済み）。
     * 通常モードでは一致する要素が存在せず、シアターモードONで出現する。
     */
    const THEATRE_MODE_SELECTOR = '[class*="channel-page__video-player--theatre-mode"]';
    /** ネイティブチャット欄の開閉トグルボタンのセレクタ */
    const CHAT_COLLAPSE_TOGGLE_SELECTOR = '[data-a-target="right-column__toggle-collapse-btn"]';
    /**
     * チャット欄が閉じている状態の時、開閉トグルボタンのaria-labelに含まれる文字列
     * （実機で確認済み。「チャットを展開」＝クリックすると展開される＝現在は閉じている）。
     */
    const CHAT_COLLAPSED_ARIA_LABEL_SUBSTRING = "展開";
    /**
     * チャット欄を開いてからすぐ閉じ直すまでの待機時間（ミリ秒）。
     * Twitchに新チャンネルのチャット接続を初期化させるための間隔。
     * チラつきを抑えるため短くしているが、値が小さすぎると接続初期化が
     * 間に合わない可能性がある（ユーザー体感を優先した値であり、
     * 実機で効果が薄い場合は増やすことを検討する）。
     */
    const CHAT_REOPEN_CLOSE_DELAY_MS = 50;
    /**
     * 通常時のオーバーレイのz-index。Twitchのヘッダー（nav.top-nav、z-index: 1000）
     * より低くすることで、オーバーレイがヘッダーに被らないようにする（実機で確認済み）。
     */
    const NORMAL_Z_INDEX = 900;
    /**
     * シアターモード/全画面表示中のオーバーレイのz-index。
     * Twitchのシアターモード/全画面用の動画プレイヤーコンテナ（z-index: 3000、
     * position: fixed）より高くする必要がある（実機で確認済み。この値でないと
     * オーバーレイが動画プレイヤーの後ろに隠れて一切表示されない）。
     * Twitchのトースト通知・snackbar（z-index: 4000〜5010）よりは低い値に留めている。
     * チャットコメントの視認性よりトースト通知の視認性を優先する設計判断のため。
     */
    const IMMERSIVE_Z_INDEX = 3500;
    /** 直近でLiveChatOverlay.setVideoElement()に渡した要素（重複呼び出し防止用） */
    let lastVideoEl = null;
    /** 直近確認したチャンネルのパス（location.pathname。チャンネル切り替え検知用） */
    let lastPathname = null;
    /**
     * <video>要素を探し、見つかればオーバーレイの位置決め基準として通知する。
     * オーバーレイ側は position: fixed とこの要素の getBoundingClientRect() を
     * 基に自身の座標を計算するため、動画要素の親要素（本体DOM）には触れない。
     */
    function syncVideoElement() {
        const video = document.querySelector("video");
        if (!video || video === lastVideoEl) {
            return;
        }
        if (typeof window.LiveChatOverlay?.setVideoElement === "function") {
            window.LiveChatOverlay.setVideoElement(video);
            lastVideoEl = video;
        }
    }
    /**
     * メッセージ本文要素の子ノードを走査し、テキストノードのみを出現順に連結して
     * 本文文字列を組み立てる。
     * <img>要素（エモート）は無視する。エモートのみで構成されたコメントは
     * 本文が空文字になり、extractComment側で自然に非表示（null）扱いとなる。
     */
    function extractBodyText(bodyEl) {
        let text = "";
        bodyEl.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent ?? "";
            }
            else if (node instanceof HTMLImageElement) {
                // エモート画像は無視する（altテキストは表示しない）
            }
            else if (node instanceof Element) {
                // 想定外の要素（装飾用span等）が挟まる場合に備え、再帰的に処理する
                text += extractBodyText(node);
            }
        });
        return text;
    }
    /**
     * コメント要素から投稿者名・本文テキストを抽出する。
     * 本文が抽出できない場合は null を返す。
     *
     * ライブ配信ではCHAT_BODY_SELECTORで本文全体を包む要素が1つ見つかるため、
     * それをextractBodyTextで処理する。録画（VOD）ページにはその要素が存在しない
     * ため、フォールバックとしてCHAT_TEXT_FRAGMENT_SELECTORに一致する断片スパンを
     * すべて集めて連結する（エモート画像や区切り文字":"のspanはdata-a-target属性を
     * 持たないため、この方法で自動的に除外される）。
     */
    function extractComment(el) {
        const authorEl = el.querySelector(CHAT_AUTHOR_SELECTOR);
        const author = authorEl?.textContent?.trim() ?? "";
        const bodyEl = el.querySelector(CHAT_BODY_SELECTOR);
        let text;
        if (bodyEl) {
            text = extractBodyText(bodyEl).trim();
        }
        else {
            const fragmentEls = el.querySelectorAll(CHAT_TEXT_FRAGMENT_SELECTOR);
            let fragmentText = "";
            fragmentEls.forEach((fragmentEl) => {
                fragmentText += fragmentEl.textContent ?? "";
            });
            text = fragmentText.trim();
        }
        if (text.length === 0) {
            return null;
        }
        return { author, text };
    }
    /**
     * 指定セレクタについて、ノード自身または子孫がそのセレクタに一致する要素を
     * すべて集めて返す。
     */
    function collectMatchingElements(node, selector) {
        return node.matches(selector)
            ? [node]
            : Array.from(node.querySelectorAll(selector));
    }
    /**
     * MutationObserver が検知した追加ノードを処理する。
     *
     * 実機検証済みの重要な挙動：addedNodes に渡ってくる要素は
     * [data-a-target="chat-line-message"] に一致するメッセージ要素自身ではなく、
     * その外側のラッパーdiv（クラス名 Layout-sc-1xcs6mc-0 など）である。
     * そのため「ノード自身が一致するか」だけでなく「子孫に一致する要素があるか」も
     * チェックする必要がある。1コメントにつき1回だけラッパーdivの追加が検知される
     * ことも確認済みのため、重複除去ロジックは不要。
     *
     * ライブ配信用（CHAT_MESSAGE_SELECTOR）と録画（VOD）用（VOD_CHAT_MESSAGE_SELECTOR）
     * の両方のセレクタで判定する。両ページが同一DOM内に混在することはないが、
     * 念のためSetで重複を除去してから処理する。
     */
    function handleAddedNode(node) {
        if (!(node instanceof Element)) {
            return;
        }
        const messageEls = new Set([
            ...collectMatchingElements(node, CHAT_MESSAGE_SELECTOR),
            ...collectMatchingElements(node, VOD_CHAT_MESSAGE_SELECTOR),
        ]);
        for (const messageEl of messageEls) {
            const comment = extractComment(messageEl);
            if (comment && typeof window.LiveChatOverlay?.addComment === "function") {
                window.LiveChatOverlay.addComment(comment.author, comment.text);
            }
        }
    }
    /**
     * ネイティブチャット欄が閉じているかどうかを判定する。
     * 開閉トグルボタンが見つからない場合は判定不能なため、false（開いている扱い）
     * を返し、呼び出し側で何もしないようにする（安全側に倒す）。
     */
    function isNativeChatCollapsed() {
        const toggleButton = document.querySelector(CHAT_COLLAPSE_TOGGLE_SELECTOR);
        if (!toggleButton) {
            return false;
        }
        const ariaLabel = toggleButton.getAttribute("aria-label") ?? "";
        return ariaLabel.includes(CHAT_COLLAPSED_ARIA_LABEL_SUBSTRING);
    }
    /**
     * reinitializeCollapsedChat() の多重実行防止フラグ。
     * 開く→閉じるの間（setTimeout待機中）に何らかの理由でchecckChannelChange()が
     * 再度この関数を呼び出しても、開閉操作が二重に走らないようにする。
     */
    let isReinitializingChat = false;
    /**
     * チャット欄が閉じたままチャンネルが切り替わった場合、Twitch側が新チャンネルの
     * チャット接続（DOM更新）を初期化しないことが実機で確認されている。
     * 開閉トグルボタンを「開く→閉じる」と自動クリックすることでTwitchに接続を
     * 初期化させ、最後にユーザーが元々選んでいた「閉じている」状態へ戻す。
     * DOMが差し替わっている可能性があるため、クリックの都度ボタン要素を探し直す。
     */
    function reinitializeCollapsedChat() {
        if (isReinitializingChat) {
            return;
        }
        const openButton = document.querySelector(CHAT_COLLAPSE_TOGGLE_SELECTOR);
        if (!openButton || !(openButton instanceof HTMLElement)) {
            return;
        }
        isReinitializingChat = true;
        openButton.click();
        setTimeout(() => {
            const closeButton = document.querySelector(CHAT_COLLAPSE_TOGGLE_SELECTOR);
            if (closeButton instanceof HTMLElement) {
                closeButton.click();
            }
            isReinitializingChat = false;
        }, CHAT_REOPEN_CLOSE_DELAY_MS);
    }
    /**
     * location.pathname の変化を確認し、チャンネルが切り替わっていれば
     * オーバーレイの表示中コメントをクリアする。
     * Twitchは<video>要素が使い回されたままチャンネルだけが切り替わるケースがあるため、
     * setVideoElement() 側の要素参照の同一性判定だけでは切り替わりを検知できない。
     * そのため pathname（チャンネル名を含むURLパス）の変化を判定材料として使う。
     */
    function checkChannelChange() {
        const pathname = location.pathname;
        if (lastPathname !== null && pathname !== lastPathname) {
            if (typeof window.LiveChatOverlay?.resetForNewStream === "function") {
                window.LiveChatOverlay.resetForNewStream();
            }
            // コメント表示自体がOFFの場合、Twitchのチャット接続を無理に再初期化させる
            // 意味がないため何もしない（ユーザーがコメントを見るつもりがないのに
            // チャット欄を自動で開閉させる必要はない）。
            // チャット欄が閉じたままチャンネルが変わった場合はTwitchの接続初期化を促す
            if (window.LiveChatOverlay?.isEnabled?.() !== false &&
                isNativeChatCollapsed()) {
                reinitializeCollapsedChat();
            }
        }
        lastPathname = pathname;
    }
    /**
     * 全画面表示中、またはシアターモード中かどうかを判定する。
     * どちらの場合も動画プレイヤーがz-index: 3000のposition: fixedで前面に出るため、
     * オーバーレイのz-indexをそれより高くする必要がある。
     */
    function isImmersiveMode() {
        return (document.fullscreenElement !== null ||
            document.querySelector(THEATRE_MODE_SELECTOR) !== null);
    }
    /**
     * 現在の表示モード（通常/シアターモード・全画面）に応じて、オーバーレイの
     * z-indexを切り替える。呼び出しごとに毎回判定して設定するだけの単純な処理
     * （setZIndex側は値が変わらなければ実質no-opなので、頻繁に呼んでも問題ない）。
     */
    function syncZIndex() {
        if (typeof window.LiveChatOverlay?.setZIndex === "function") {
            window.LiveChatOverlay.setZIndex(isImmersiveMode() ? IMMERSIVE_Z_INDEX : NORMAL_Z_INDEX);
        }
    }
    /** チャットコンテナ要素に対する MutationObserver（見つかり次第セットアップする） */
    let chatObserver = null;
    let observedChatContainerEl = null;
    /**
     * チャットメッセージコンテナが見つかれば、そのコンテナに対するコメント監視を
     * 開始する。すでに同じ要素を監視中であれば何もしない。
     *
     * ライブ配信用のコンテナが見つかればそちらを優先し、見つからない場合は
     * 録画（VOD）ページ用のコンテナにフォールバックする。
     */
    function ensureChatContainerObserved() {
        const containerEl = document.querySelector(CHAT_CONTAINER_SELECTOR) ??
            document.querySelector(VOD_CHAT_CONTAINER_SELECTOR);
        if (!containerEl || containerEl === observedChatContainerEl) {
            return;
        }
        chatObserver?.disconnect();
        chatObserver = new MutationObserver((mutations) => {
            checkChannelChange();
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(handleAddedNode);
            }
        });
        chatObserver.observe(containerEl, { childList: true, subtree: true });
        observedChatContainerEl = containerEl;
    }
    // 初回チェック（すでにDOMに存在している場合に対応。ページロード時点で既に
    // シアターモード/全画面だったケースにも対応するため syncZIndex() もここで呼ぶ）
    syncVideoElement();
    ensureChatContainerObserved();
    syncZIndex();
    lastPathname = location.pathname;
    // SPA遷移・チャンネル切り替えに対応するため document.body を常時監視する。
    // メッセージコンテナがまだ見つかっていない場合（初回ロード直後・SPA遷移直後）は
    // ここで継続的にリトライされる（YouTube版の ensureItemsObserved と同じ二段構え）。
    // シアターモードのクラス切り替えも childList/subtree の変更として検知できることを
    // 実機で確認済みのため、ここで syncZIndex() も呼ぶ。
    const bodyObserver = new MutationObserver(() => {
        syncVideoElement();
        checkChannelChange();
        ensureChatContainerObserved();
        syncZIndex();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
    // Fullscreen API使用時（fullscreenchange）はDOM構造の変更を伴わない場合があるため、
    // bodyObserverでは検知できない可能性がある。専用のイベントリスナーで確実に拾う。
    document.addEventListener("fullscreenchange", syncZIndex);
})();
