"use strict";
/**
 * sites/youtube.ts
 *
 * YouTube Live のチャットDOM監視を担当するモジュール。
 *
 * YouTubeのライブチャットは以下のような二層構造になっている。
 *
 *   トップフレーム（https://www.youtube.com/watch*）
 *     └ <ytd-live-chat-frame>
 *         └ <iframe src="https://www.youtube.com/live_chat?...">
 *             （↑ このiframeが別ドキュメントとして
 *                https://www.youtube.com/live_chat* にマッチする）
 *             └ <yt-live-chat-renderer>
 *                 └ #items
 *                     └ <yt-live-chat-text-message-renderer> ...（コメント本体）
 *
 * iframe内のDOMを監視するには、iframeのURL（live_chat*）にもマッチする
 * content_scriptエントリが必要（manifest.json側で対応済み）。
 * トップフレームとiframeで役割が異なるため、window.top === window.self で判定し、
 * 処理を分岐させる。
 *
 * - トップフレーム側：<video>要素・<ytd-live-chat-frame>要素の出現をSPA遷移も
 *   含めて監視し、LiveChatOverlay.setContainer() でオーバーレイの配置基準を更新する。
 *   また、iframe側から postMessage で送られてくるコメントを受信し、
 *   LiveChatOverlay.addComment() を呼び出す。
 * - iframe側：チャットDOMのコメント追加を監視し、投稿者名・本文を抽出して
 *   window.top へ postMessage で送信する。
 *
 *   Chrome拡張機能のcontent scriptは「isolated world」と呼ばれる、ページ本来の
 *   JavaScript実行環境とは隔離された環境で動作する。このisolated worldは
 *   フレームごとに独立しているため、同一オリジンであっても、iframe側の
 *   content scriptからトップフレーム側content scriptが定義したグローバル変数
 *   （window.top.LiveChatOverlay）へ直接アクセスすることはできない
 *   （常に undefined になる）。そのため、フレームをまたぐ通信には
 *   window.postMessage を使用する。
 *
 * - module: "None" 構成のため import/export は使用不可。
 * - overlay.ts が読み込まれていればグローバル LiveChatOverlay を利用する。
 */
(function () {
    "use strict";
    /** 通常動画では存在しない、ライブチャット用のDOM構造のセレクタ */
    const LIVE_CHAT_FRAME_SELECTOR = "ytd-live-chat-frame";
    /** iframe内、チャットメッセージが追加されていくコンテナのセレクタ */
    const CHAT_ITEMS_SELECTOR = "yt-live-chat-renderer #items";
    /** コメント本文を持つ要素（通常メッセージ・メンバー限定メッセージ等）のセレクタ */
    const CHAT_MESSAGE_SELECTOR = "yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, yt-live-chat-membership-item-renderer";
    /** postMessage送受信で使う、他のメッセージと衝突しない専用の識別子 */
    const ADD_COMMENT_MESSAGE_TYPE = "live-chat-overlay:add-comment";
    /** postMessageの送信先・受信元として許可するオリジン */
    const YOUTUBE_ORIGIN = "https://www.youtube.com";
    const isTopFrame = window.top === window.self;
    /** 隠しiframeの要素ID（重複生成防止用） */
    const HIDDEN_CHAT_IFRAME_ID = "live-chat-overlay-hidden-chat-frame";
    /** ネイティブのチャットiframeを内包する要素・iframe自体のセレクタ */
    const NATIVE_CHAT_IFRAME_SELECTOR = `${LIVE_CHAT_FRAME_SELECTOR} iframe#chatframe`;
    /** 重複排除のため記録しておく、処理済みコメントIDの最大保持件数 */
    const MAX_PROCESSED_COMMENT_IDS = 500;
    /** 再生位置を通知するメッセージの送信間隔（ミリ秒） */
    const VIDEO_PROGRESS_SYNC_INTERVAL_MS = 250;
    /**
     * トップフレーム側の処理。
     * 動画要素・ライブチャット枠の出現を監視し、オーバーレイの配置基準を更新する。
     */
    function initTopFrame() {
        /** 直近でLiveChatOverlay.setVideoElement()に渡した要素（重複呼び出し防止用） */
        let lastVideoEl = null;
        /** 自分専用に生成した隠しiframe要素への参照 */
        let hiddenChatFrame = null;
        /** 直近で隠しiframeに設定したURL（ネイティブiframeのURL変化検知用） */
        let lastChatUrl = null;
        /** 再生位置の定期送信に使う setInterval のID（未実行時は null） */
        let videoProgressIntervalId = null;
        /** 現在イベントリスナーを設定している動画要素の解除用関数（未設定時は null） */
        let removeVideoEventListeners = null;
        /**
         * 隠しiframeへアーカイブ再生同期用のメッセージを送信する。
         * 隠しiframeが未生成・contentWindow未取得の場合は何もしない
         * （ライブ配信ではそもそも同期情報が使われないため、害はない）。
         */
        function postSyncMessageToHiddenFrame(message) {
            const targetWindow = hiddenChatFrame?.contentWindow;
            if (!targetWindow) {
                return;
            }
            try {
                targetWindow.postMessage(message, YOUTUBE_ORIGIN);
            }
            catch {
                // postMessage自体の失敗（フレーム破棄タイミング等）は無視する
            }
        }
        /** 再生位置の定期送信を停止する（すでに停止中なら何もしない） */
        function stopVideoProgressSync() {
            if (videoProgressIntervalId !== null) {
                clearInterval(videoProgressIntervalId);
                videoProgressIntervalId = null;
            }
        }
        /**
         * 再生位置の定期送信を開始する（すでに開始中なら一旦止めてから開始し直す）。
         * video要素を直接参照するクロージャのため、動画要素切り替え時は
         * 呼び出し側で古いintervalを止めてから新しい要素に対して呼び直すこと。
         */
        function startVideoProgressSync(video) {
            stopVideoProgressSync();
            videoProgressIntervalId = setInterval(() => {
                postSyncMessageToHiddenFrame({
                    "yt-player-video-progress": video.currentTime,
                });
            }, VIDEO_PROGRESS_SYNC_INTERVAL_MS);
        }
        /**
         * 動画要素の再生状態変化イベントを監視し、隠しiframeへ同期メッセージを送る
         * リスナーをセットアップする。イベントリスナー解除用の関数を返す。
         */
        function attachVideoSyncListeners(video) {
            const handlePlaying = () => {
                postSyncMessageToHiddenFrame({ "yt-player-state-change": 1 });
                startVideoProgressSync(video);
            };
            const handlePause = () => {
                postSyncMessageToHiddenFrame({ "yt-player-state-change": 2 });
                stopVideoProgressSync();
            };
            const handleWaiting = () => {
                postSyncMessageToHiddenFrame({ "yt-player-state-change": 3 });
                stopVideoProgressSync();
            };
            video.addEventListener("playing", handlePlaying);
            video.addEventListener("pause", handlePause);
            video.addEventListener("waiting", handleWaiting);
            // リスナー設定時点ですでに再生中の場合、"playing" イベントは
            // 再生開始の瞬間にしか発火しないため、二度と発火せず定期送信が
            // 永久に始まらない。そのため、ここで現在の再生状態を確認し、
            // すでに再生中であればイベント発火を待たず即座に開始する。
            if (!video.paused) {
                handlePlaying();
            }
            return () => {
                video.removeEventListener("playing", handlePlaying);
                video.removeEventListener("pause", handlePause);
                video.removeEventListener("waiting", handleWaiting);
            };
        }
        /**
         * <video>要素を探し、見つかればオーバーレイの位置決め基準として通知する。
         * オーバーレイ側は position: fixed とこの要素の getBoundingClientRect() を
         * 基に自身の座標を計算するため、動画要素の親要素（本体DOM）には触れない。
         * ytd-live-chat-frame が存在しない通常動画ページでは何もしない
         * （その場合コメント検知自体が発生しないため、オーバーレイは実質未使用のままになる）。
         */
        function syncVideoElement() {
            if (!document.querySelector(LIVE_CHAT_FRAME_SELECTOR)) {
                // ライブ配信視聴後に通常動画へ遷移した場合への対応。
                // ytd-live-chat-frame が存在しないページに来たとき、以前ライブ配信の
                // video要素を保持していれば（lastVideoElがnullでなければ）、
                // オーバーレイに残った古いコメント表示・タイマー・リスナーを
                // 確実に片付ける。もともとライブ配信を見ていなければ何もしない。
                if (lastVideoEl) {
                    if (typeof window.LiveChatOverlay?.resetForNewStream === "function") {
                        window.LiveChatOverlay.resetForNewStream();
                    }
                    lastVideoEl = null;
                    stopVideoProgressSync();
                    removeVideoEventListeners?.();
                    removeVideoEventListeners = null;
                    // 隠しiframe（ネイティブのチャット欄が閉じられても更新を続けるための
                    // 自前iframe）も、ライブ配信を離れた時点で不要になるため破棄する。
                    // 残したままにすると、次にライブ配信へ戻るまでDOM上にリークし続ける。
                    hiddenChatFrame?.remove();
                    hiddenChatFrame = null;
                    lastChatUrl = null;
                }
                return;
            }
            const video = document.querySelector("video");
            if (!video || video === lastVideoEl) {
                return;
            }
            if (typeof window.LiveChatOverlay?.setVideoElement === "function") {
                window.LiveChatOverlay.setVideoElement(video);
                lastVideoEl = video;
            }
            // 動画要素が切り替わったので、古い要素へのリスナー・進捗送信を確実に
            // 止めてから、新しい要素に対して再設定する（リーク防止）。
            stopVideoProgressSync();
            removeVideoEventListeners?.();
            removeVideoEventListeners = attachVideoSyncListeners(video);
        }
        /**
         * ネイティブのチャットiframeを自分専用に複製した「隠しiframe」を用意・更新する。
         *
         * 背景：YouTubeはネイティブのチャット欄（ytd-live-chat-frame内のiframe）が
         * ユーザーによって閉じられると、そのiframe内でのチャット更新自体を停止して
         * しまう（DOM自体は残るが新規コメントが追加されなくなる）。これを回避する
         * ため、同じURLを独立して読み込む自分専用のiframeを作成し、ネイティブの
         * チャット欄が閉じられても構わずコメントを受信し続けられるようにする。
         *
         * 画面外配置には display:none / visibility:hidden ではなく
         * position:fixed; left:-9999px を用いる。実機検証で、前者2つは
         * レンダリングが停止しチャット更新も止まる可能性があるとわかったため。
         */
        function syncHiddenChatFrame() {
            const nativeIframe = document.querySelector(NATIVE_CHAT_IFRAME_SELECTOR);
            if (!nativeIframe) {
                return;
            }
            // 注意：このiframeは src 属性ではなく contentWindow.location でURLが
            // 設定される方式のため、iframe.src ではなく contentWindow.location.href
            // からURLを取得する（実機検証で iframe.src は空文字になることを確認済み）。
            let chatUrl = null;
            try {
                chatUrl = nativeIframe.contentWindow?.location.href ?? null;
            }
            catch {
                // クロスオリジン等でアクセスできない場合は取得できるまでリトライする
                chatUrl = null;
            }
            // チャット欄を閉じるとYouTube側がiframeの中身を
            // "about:blank#blocked" のようにフラグメント付きの空白ページへ
            // 書き換えることがあるため、完全一致ではなく前方一致で判定する。
            if (!chatUrl || chatUrl.startsWith("about:blank")) {
                return;
            }
            if (!hiddenChatFrame) {
                const frame = document.createElement("iframe");
                frame.id = HIDDEN_CHAT_IFRAME_ID;
                frame.style.position = "fixed";
                frame.style.top = "0";
                frame.style.left = "-9999px";
                frame.style.width = "400px";
                frame.style.height = "600px";
                frame.style.border = "none";
                document.body.appendChild(frame);
                hiddenChatFrame = frame;
            }
            // SPA遷移で動画（≒チャットのcontinuationトークン）が切り替わった場合、
            // ネイティブiframeのURLが変化するので、隠しiframe側も追従させる。
            if (chatUrl !== lastChatUrl) {
                // おすすめ動画クリック等で<video>要素自体は使い回されたまま
                // 配信内容だけが差し替わるケースでは、overlay.ts側のsetVideoElement()の
                // changed判定（要素参照の同一性）だけでは切り替わりを検知できない。
                // その一方でチャットのURL（continuationトークン）は配信が変わるたびに
                // 必ず変化するため、こちらを「本当に別の配信に切り替わったか」の
                // 判定材料として使い、前の配信のコメント表示をクリアする。
                // ただし lastChatUrl が null の場合（ページ初回読み込み時）は
                // 配信の切り替わりではないため呼び出さない。
                if (lastChatUrl !== null && typeof window.LiveChatOverlay?.resetForNewStream === "function") {
                    window.LiveChatOverlay.resetForNewStream();
                }
                hiddenChatFrame.src = chatUrl;
                lastChatUrl = chatUrl;
            }
        }
        // 初回チェック（すでにDOMに存在している場合に対応）
        syncVideoElement();
        syncHiddenChatFrame();
        // SPA遷移・動画切り替えに対応するため document.body を常時監視する。
        // YouTube独自イベント yt-navigate-finish には依存しない。
        // ネイティブiframeがまだ見つからない・URLが未確定の場合もここで継続的に
        // リトライされる。
        const observer = new MutationObserver(() => {
            syncVideoElement();
            syncHiddenChatFrame();
            // DOM変化（レイアウトシフトの可能性がある兆候）をトリガーに座標を
            // 再計算する。ResizeObserverは動画要素自身のサイズ変化にしか反応せず、
            // 周囲のコンテンツ（関連動画欄・広告等）の読み込みによる位置ずれを
            // 検知できないため、常時稼働しているこのMutationObserverのコールバックを
            // 座標再計算のトリガーとしても活用する
            // （scheduleVideoChangeRecalculation()による時間ベースの再計算と併用）。
            // matches が https://www.youtube.com/* に拡大されたことで、このObserver
            // 自体はライブ配信と無関係なページ（トップページ等）でも常時稼働している
            // ため、ライブチャット枠が存在するページに限定して呼び出す（無駄な
            // rAF予約サイクルを避けるため）。
            if (document.querySelector(LIVE_CHAT_FRAME_SELECTOR)) {
                window.LiveChatOverlay?.recalculatePosition?.();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        /**
         * 重複排除用：直近に処理済みのコメントIDを記録するSet。
         * ネイティブのチャット欄が開いている間は、ネイティブiframeと隠しiframeの
         * 両方が同じコメントを検知して送ってくるため、同一IDの再受信を無視する。
         * メモリが無限に増えないよう、挿入順を配列でも保持し、上限を超えたら
         * 古いものから破棄する（シンプルなFIFO方式）。
         */
        const processedCommentIds = new Set();
        const processedCommentIdOrder = [];
        function isDuplicateComment(commentId) {
            // IDが取得できなかった場合は重複判定ができないため、安全側に倒して
            // 常に「重複ではない」＝表示する扱いにする。
            if (commentId.length === 0) {
                return false;
            }
            if (processedCommentIds.has(commentId)) {
                return true;
            }
            processedCommentIds.add(commentId);
            processedCommentIdOrder.push(commentId);
            if (processedCommentIdOrder.length > MAX_PROCESSED_COMMENT_IDS) {
                const oldestId = processedCommentIdOrder.shift();
                if (oldestId !== undefined) {
                    processedCommentIds.delete(oldestId);
                }
            }
            return false;
        }
        // live_chat iframe側から postMessage で送られてくるコメントを受信する。
        // isolated worldの制約によりグローバル変数への直接アクセスができないため、
        // フレーム間通信には postMessage を用いる。
        window.addEventListener("message", (event) => {
            // 送信元オリジンがYouTube本体でなければ、なりすましメッセージとして無視する。
            if (event.origin !== YOUTUBE_ORIGIN) {
                return;
            }
            const data = event.data;
            if (!data || data.type !== ADD_COMMENT_MESSAGE_TYPE) {
                return;
            }
            if (typeof data.author !== "string" ||
                typeof data.text !== "string" ||
                typeof data.commentId !== "string") {
                return;
            }
            if (isDuplicateComment(data.commentId)) {
                return;
            }
            if (typeof window.LiveChatOverlay?.addComment === "function") {
                window.LiveChatOverlay.addComment(data.author, data.text);
            }
        });
    }
    /**
     * コメント要素から投稿者名・本文テキスト・コメントIDを抽出する。
     * 見つからない場合は null を返す。
     *
     * id はコメント要素自身（例：yt-live-chat-text-message-renderer）の id属性から
     * 取得する。ネイティブiframeと隠しiframeの両方が同じコメントを検知した際、
     * トップフレーム側で重複排除するために使う一意な値（実機で確認済み）。
     * 取得できない場合は空文字を返す（呼び出し側で「常に表示」扱いとする）。
     */
    function extractComment(el) {
        const authorEl = el.querySelector("#author-name");
        const textEl = el.querySelector("#message");
        if (!textEl) {
            return null;
        }
        const author = authorEl?.textContent?.trim() ?? "";
        const text = textEl.textContent?.trim() ?? "";
        if (text.length === 0) {
            return null;
        }
        const id = el.id ?? "";
        return { id, author, text };
    }
    /**
     * 抽出したコメントをトップフレームのオーバーレイへ連携する。
     * isolated worldの制約により window.top.LiveChatOverlay へ直接アクセスすることは
     * できないため、window.postMessage でトップフレームへメッセージを送信する。
     * 送信先オリジンを明示的に指定することで、意図しない相手への漏洩を防ぐ。
     */
    function dispatchComment(commentId, author, text) {
        if (!window.top) {
            return;
        }
        const message = {
            type: ADD_COMMENT_MESSAGE_TYPE,
            commentId,
            author,
            text,
        };
        try {
            window.top.postMessage(message, YOUTUBE_ORIGIN);
        }
        catch {
            // postMessage自体の失敗（フレーム破棄タイミング等）は無視する
        }
    }
    /**
     * iframe（live_chatページ）側の処理。
     * #items 配下へのコメント追加を監視し、検知するたびにオーバーレイへ連携する。
     */
    function initChatFrame() {
        /** #items 要素に対する MutationObserver（見つかり次第セットアップする） */
        let itemsObserver = null;
        let observedItemsEl = null;
        function handleAddedNode(node) {
            if (!(node instanceof Element)) {
                return;
            }
            const matched = node.matches(CHAT_MESSAGE_SELECTOR);
            const comment = matched ? extractComment(node) : null;
            if (comment) {
                dispatchComment(comment.id, comment.author, comment.text);
            }
        }
        /**
         * #items 要素が見つかれば、その要素に対するコメント監視を開始する。
         * すでに同じ要素を監視中であれば何もしない。
         */
        function ensureItemsObserved() {
            const itemsEl = document.querySelector(CHAT_ITEMS_SELECTOR);
            if (!itemsEl || itemsEl === observedItemsEl) {
                return;
            }
            itemsObserver?.disconnect();
            itemsObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    mutation.addedNodes.forEach(handleAddedNode);
                }
            });
            itemsObserver.observe(itemsEl, { childList: true });
            observedItemsEl = itemsEl;
        }
        ensureItemsObserved();
        // チャットリプレイ（アーカイブ）の場合も #items の初期出現タイミングが
        // 前後することがあるため、body全体をSPA遷移対応も兼ねて監視し続ける。
        const bodyObserver = new MutationObserver(() => {
            ensureItemsObserved();
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (isTopFrame) {
        initTopFrame();
    }
    else {
        initChatFrame();
    }
})();
