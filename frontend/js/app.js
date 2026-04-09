/* ═══════════════════════════════════════════════════════════
   VInnyy — App Logic
   WebSocket Sync · YouTube IFrame API · Chat · Reactions
   🔥 Server-Authoritative Time Sync with Latency Compensation
   ═══════════════════════════════════════════════════════════ */

// ── State ───────────────────────────────────────────────
const state = {
    roomId: null,
    username: null,
    ws: null,
    isRemoteAction: false,
    player: null,
    playerReady: false,
    currentVideoId: null,
    currentTitle: null,
    typingTimeout: null,
    reconnectAttempts: 0,
    maxReconnect: 5,
    searchTimeout: null,
    lastQuery: '',
    wasPlayingBeforeHide: false,
    silentAudio: null,
    bgResumeTimeout: null,
    bgResumeIntervalId: null,
    bgWatchdogId: null,
    audioCtx: null,
    bgOscillator: null,
    bgGainNode: null,
    bgOscillatorStarted: false,
    wakeLock: null,

    // ── Sync Engine State ──
    serverTimeOffset: 0,         // server_time - local_time (ms)
    networkLatency: 0,           // one-way latency estimate (ms)
    latencySamples: [],          // recent RTT samples for averaging
    maxLatencySamples: 10,
    syncIntervalId: null,        // periodic sync check
    syncCheckMs: 10000,          // check sync every 10 seconds (less aggressive)
    driftThreshold: 2.0,         // 2s — only hard seek for major drift
    pingIntervalId: null,        // periodic latency measurement
    pingIntervalMs: 15000,       // measure latency every 15 seconds
    lastSyncState: null,         // last received sync payload from server
    isSyncing: false,            // prevent recursive sync loops
    remoteActionTimeout: null,   // timeout for isRemoteAction flag

    // ── Video Call State ──
    videoCallActive: false,
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    micMuted: false,
    camOff: false,
    vcSizeIndex: 0,
};

// ── DOM Cache ───────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const el = {
    app: $('#app'),
    canvas: $('#particles-canvas'),
    landingView: $('#landing-view'),
    watchView: $('#watch-view'),
    modalOverlay: $('#modal-overlay'),
    createRoomBtn: $('#create-room-btn'),
    joinRoomBtn: $('#join-room-btn'),
    modalClose: $('#modal-close'),
    createContent: $('#create-room-content'),
    joinContent: $('#join-room-content'),
    generatedCode: $('#generated-code'),
    copyCodeBtn: $('#copy-code-btn'),
    createUsername: $('#create-username'),
    createConfirm: $('#create-confirm'),
    joinRoomCode: $('#join-room-code'),
    joinUsername: $('#join-username'),
    joinConfirm: $('#join-confirm'),
    displayRoomCode: $('#display-room-code'),
    connectionStatus: $('#connection-status'),
    usersOnline: $('#users-online'),
    leaveBtn: $('#leave-btn'),
    playerPlaceholder: $('#player-placeholder'),
    nowPlayingBar: $('#now-playing-bar'),
    npTitle: $('#np-title'),
    visualizer: $('#visualizer'),
    videoUrl: $('#video-url'),
    loadVideoBtn: $('#load-video-btn'),
    addQueueBtn: $('#add-queue-btn'),
    searchInput: $('#search-input'),
    searchSpinner: $('#search-spinner'),
    searchResults: $('#search-results'),
    searchResultsGrid: $('#search-results-grid'),
    resultsCount: $('#results-count'),
    closeSearchResults: $('#close-search-results'),
    chatMessages: $('#chat-messages'),
    chatTyping: $('#chat-typing'),
    typingName: $('#typing-name'),
    chatInput: $('#chat-input'),
    chatSend: $('#chat-send'),
    chatPanel: $('#chat-panel'),
    queuePanel: $('#queue-panel'),
    queueList: $('#queue-list'),
    queueEmpty: $('#queue-empty'),
    queueBadge: $('#queue-badge'),
    playNextBtn: $('#play-next-btn'),
    foldersPanel: $('#folders-panel'),
    foldersList: $('#folders-list'),
    foldersEmpty: $('#folders-empty'),
    foldersSearch: $('#folders-search'),
    playlistUrlInput: $('#playlist-url-input'),
    importPlaylistBtn: $('#import-playlist-btn'),
    reactionsContainer: $('#reactions-container'),
    toastContainer: $('#toast-container'),
    // Video Call
    videocallBtn: $('#videocall-btn'),
    videocallPanel: $('#videocall-panel'),
    localVideo: $('#local-video'),
    remoteVideo: $('#remote-video'),
    remotePlaceholder: $('#remote-placeholder'),
    videocallStatus: $('#videocall-status'),
    vcToggleMic: $('#vc-toggle-mic'),
    vcToggleCam: $('#vc-toggle-cam'),
    vcHangup: $('#vc-hangup'),
    vcMicIcon: $('#vc-mic-icon'),
    vcCamIcon: $('#vc-cam-icon'),
    vcDragHandle: $('#videocall-drag-handle'),
    vcMinimize: $('#vc-minimize'),
    vcMinimizeIcon: $('#vc-minimize-icon'),
    vcTimer: $('#vc-timer'),
    vcBody: $('#videocall-body'),
    vcResizeHandle: $('#vc-resize-handle'),
    vcSizeToggle: $('#vc-size-toggle'),
    vcSizeIcon: $('#vc-size-icon'),
};

// ── Initialize ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initParticles();
    initBackgroundPlayback();
    bindEvents();
});

function bindEvents() {
    el.createRoomBtn.addEventListener('click', () => openModal('create'));
    el.joinRoomBtn.addEventListener('click', () => openModal('join'));
    el.modalClose.addEventListener('click', closeModal);
    el.modalOverlay.addEventListener('click', (e) => { if (e.target === el.modalOverlay) closeModal(); });
    el.copyCodeBtn.addEventListener('click', copyRoomCode);
    el.createConfirm.addEventListener('click', confirmCreate);
    el.joinConfirm.addEventListener('click', confirmJoin);
    el.leaveBtn.addEventListener('click', leaveRoom);
    el.loadVideoBtn.addEventListener('click', loadVideoFromInput);
    el.addQueueBtn.addEventListener('click', addToQueueFromInput);
    el.chatSend.addEventListener('click', sendChat);
    el.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
        else sendTyping();
    });
    el.videoUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVideoFromInput(); });
    
    el.importPlaylistBtn.addEventListener('click', importPlaylist);
    el.playlistUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') importPlaylist(); });

    // Video call
    el.videocallBtn.addEventListener('click', toggleVideoCall);
    el.vcToggleMic.addEventListener('click', toggleMic);
    el.vcToggleCam.addEventListener('click', toggleCam);
    el.vcHangup.addEventListener('click', endVideoCall);
    el.vcMinimize.addEventListener('click', toggleMinimize);
    if (el.vcSizeToggle) el.vcSizeToggle.addEventListener('click', cycleVideoSize);
    initDragPanel();
    initResizePanel();

    // Tab buttons
    $$('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Reaction buttons (inline in now-playing bar)
    $$('.reaction-btn-sm').forEach(btn => {
        btn.addEventListener('click', () => sendReaction(btn.dataset.emoji));
    });

    // ── Search ──
    el.searchInput.addEventListener('input', onSearchInput);
    el.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); performSearch(el.searchInput.value.trim()); } });
    el.closeSearchResults.addEventListener('click', closeSearchResults);

    // Mood tag buttons
    $$('.mood-tag').forEach(btn => {
        btn.addEventListener('click', () => {
            const query = btn.dataset.query;
            el.searchInput.value = query;
            $$('.mood-tag').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            performSearch(query);
        });
    });

    // Enter key on modal inputs
    el.createUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmCreate(); });
    el.joinUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmJoin(); });
    el.joinRoomCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinUsername.focus(); });
}

// ── View Management ─────────────────────────────────────
function showView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    if (name === 'landing') el.landingView.classList.add('active');
    if (name === 'watch') el.watchView.classList.add('active');
}

// ── Modal ───────────────────────────────────────────────
function openModal(mode) {
    el.createContent.style.display = mode === 'create' ? 'block' : 'none';
    el.joinContent.style.display = mode === 'join' ? 'block' : 'none';
    el.modalOverlay.classList.add('active');

    if (mode === 'create') {
        const code = generateCode();
        el.generatedCode.textContent = code;
        el.createUsername.focus();
    } else {
        el.joinRoomCode.value = '';
        el.joinUsername.value = '';
        el.joinRoomCode.focus();
    }
}

function closeModal() {
    el.modalOverlay.classList.remove('active');
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function copyRoomCode() {
    const code = el.generatedCode.textContent;
    navigator.clipboard.writeText(code).then(() => {
        el.copyCodeBtn.classList.add('copied');
        el.copyCodeBtn.innerHTML = '✓';
        showToast('Room code copied!', 'success');
        setTimeout(() => {
            el.copyCodeBtn.classList.remove('copied');
            el.copyCodeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
        }, 2000);
    });
}

// ── Room Actions ────────────────────────────────────────
function confirmCreate() {
    const name = el.createUsername.value.trim();
    if (!name) { el.createUsername.style.borderColor = '#f87171'; return; }
    state.roomId = el.generatedCode.textContent;
    state.username = name;
    closeModal();
    enterRoom();
}

function confirmJoin() {
    const code = el.joinRoomCode.value.trim().toUpperCase();
    const name = el.joinUsername.value.trim();
    if (!code) { el.joinRoomCode.style.borderColor = '#f87171'; return; }
    if (!name) { el.joinUsername.style.borderColor = '#f87171'; return; }
    state.roomId = code;
    state.username = name;
    closeModal();
    enterRoom();
}

function enterRoom() {
    showView('watch');
    el.displayRoomCode.textContent = state.roomId;
    loadYouTubeAPI();
    connectWebSocket();
}

function leaveRoom() {
    // Stop video call
    if (state.videoCallActive) cleanupVideoCall();
    // Stop sync engine
    stopSyncEngine();
    // Stop background playback systems
    clearTimeout(state.bgResumeTimeout);
    if (state.bgResumeIntervalId) { clearInterval(state.bgResumeIntervalId); state.bgResumeIntervalId = null; }
    if (state.silentAudio) { state.silentAudio.pause(); }
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    state.wasPlayingBeforeHide = false;

    if (state.ws) { state.ws.close(); state.ws = null; }
    if (state.player) { state.player.destroy(); state.player = null; }
    state.playerReady = false;
    state.currentVideoId = null;
    state.currentTitle = null;
    state.roomId = null;
    state.reconnectAttempts = 0;
    state.lastSyncState = null;
    state.latencySamples = [];
    state.serverTimeOffset = 0;
    state.networkLatency = 0;
    el.chatMessages.innerHTML = '';
    el.queueList.innerHTML = '<div class="queue-empty" id="queue-empty"><span>📋</span><p>Queue is empty</p><p class="queue-hint">Paste a URL and click "+ Queue" to add</p></div>';
    el.nowPlayingBar.style.display = 'none';
    el.playerPlaceholder.style.display = 'flex';
    el.playNextBtn.style.display = 'none';
    showView('landing');
    showToast('Left the room', 'info');
}

// ═══════════════════════════════════════════════════════════
// ██  SYNC ENGINE — Server-Authoritative Time Sync        ██
// ═══════════════════════════════════════════════════════════

/**
 * Get current local time in milliseconds.
 */
function localTimeMs() {
    return performance.now() + performance.timeOrigin;
}

/**
 * Estimate the server's current time based on our measured offset.
 */
function estimatedServerTimeMs() {
    return localTimeMs() + state.serverTimeOffset;
}

/**
 * Send a ping to measure network latency.
 */
function sendPing() {
    wsSend({ type: 'ping', client_send_time: localTimeMs() });
}

/**
 * Handle pong response — update latency estimate and server time offset.
 */
function handlePong(data) {
    const now = localTimeMs();
    const rtt = now - data.client_send_time;
    const oneWay = rtt / 2;

    // Add to samples
    state.latencySamples.push(rtt);
    if (state.latencySamples.length > state.maxLatencySamples) {
        state.latencySamples.shift();
    }

    // Use median RTT for robustness (resistant to outliers)
    const sorted = [...state.latencySamples].sort((a, b) => a - b);
    const medianRtt = sorted[Math.floor(sorted.length / 2)];
    state.networkLatency = medianRtt / 2;

    // Calculate server time offset:
    // server_time was stamped at (client_send_time + oneWay)
    // so offset = server_time - (client_send_time + oneWay)
    state.serverTimeOffset = data.server_time - (data.client_send_time + oneWay);
}

/**
 * Request authoritative sync state from the server.
 */
function requestSync() {
    wsSend({ type: 'sync_request', client_send_time: localTimeMs() });
}

/**
 * Handle sync response from server — correct local playback.
 */
function handleSyncResponse(data) {
    const sync = data.sync;
    state.lastSyncState = sync;

    // Calculate where the server says the video should be RIGHT NOW
    // accounting for the time the response took to arrive
    const now = localTimeMs();
    const rtt = now - data.client_send_time;
    const oneWay = rtt / 2;

    // The server stamped its time. Since then, oneWay ms have passed.
    let expectedPosition;
    if (sync.is_playing) {
        // Server's position at stamp time + time elapsed since
        const elapsedSinceStamp = oneWay / 1000; // convert ms to seconds
        expectedPosition = sync.position + elapsedSinceStamp;
    } else {
        expectedPosition = sync.position;
    }

    applySync(expectedPosition, sync.is_playing);
}

/**
 * Apply sync correction — minimal intervention to avoid stuttering.
 * Only does a hard seek when drift is very large (>2s).
 * No playback rate manipulation (it causes audible artifacts).
 */
function applySync(expectedPosition, shouldBePlaying) {
    if (!state.playerReady || !state.player || state.isSyncing) return;
    if (!state.currentVideoId) return;

    state.isSyncing = true;

    try {
        const currentTime = state.player.getCurrentTime();
        const playerState = state.player.getPlayerState();
        const isPlaying = playerState === YT.PlayerState.PLAYING;

        // Handle play/pause state mismatch
        if (shouldBePlaying && !isPlaying && playerState !== YT.PlayerState.BUFFERING) {
            state.isRemoteAction = true;
            state.player.seekTo(expectedPosition, true);
            state.player.playVideo();
            el.visualizer.classList.remove('paused');
            clearRemoteActionFlag(800);
            state.isSyncing = false;
            return;
        }

        if (!shouldBePlaying && isPlaying) {
            state.isRemoteAction = true;
            state.player.seekTo(expectedPosition, true);
            state.player.pauseVideo();
            el.visualizer.classList.add('paused');
            clearRemoteActionFlag(800);
            state.isSyncing = false;
            return;
        }

        // If paused, just make sure position is right
        if (!shouldBePlaying) {
            const drift = Math.abs(currentTime - expectedPosition);
            if (drift > 2.0) {
                state.isRemoteAction = true;
                state.player.seekTo(expectedPosition, true);
                clearRemoteActionFlag(800);
            }
            state.isSyncing = false;
            return;
        }

        // ── Playing: only correct if majorly out of sync ──
        const drift = Math.abs(currentTime - expectedPosition);

        if (drift > state.driftThreshold) {
            // Large drift — hard seek (only for 2+ seconds)
            console.log(`[SYNC] Correcting: drift=${drift.toFixed(1)}s, seeking to ${expectedPosition.toFixed(1)}s`);
            state.isRemoteAction = true;
            state.player.seekTo(expectedPosition, true);
            clearRemoteActionFlag(800);
        }
        // Otherwise: do nothing — let it play smoothly

    } finally {
        state.isSyncing = false;
    }
}

// resetPlaybackRate removed — no longer manipulating playback rate
// (playback rate changes cause audible stuttering on mobile)

/**
 * Clear the isRemoteAction flag after a timeout.
 * Uses a single timeout to prevent overlapping clears.
 */
function clearRemoteActionFlag(ms) {
    clearTimeout(state.remoteActionTimeout);
    state.remoteActionTimeout = setTimeout(() => {
        state.isRemoteAction = false;
    }, ms);
}

/**
 * Start the sync engine — periodic latency pings and sync checks.
 */
function startSyncEngine() {
    // Initial ping burst to quickly establish latency
    sendPing();
    setTimeout(() => sendPing(), 300);
    setTimeout(() => sendPing(), 700);
    setTimeout(() => sendPing(), 1200);

    // Periodic latency measurement
    state.pingIntervalId = setInterval(() => {
        sendPing();
    }, state.pingIntervalMs);

    // Periodic sync check — ask server for authoritative time
    state.syncIntervalId = setInterval(() => {
        if (state.currentVideoId && state.playerReady) {
            requestSync();
        }
    }, state.syncCheckMs);
}

/**
 * Stop the sync engine.
 */
function stopSyncEngine() {
    clearInterval(state.pingIntervalId);
    clearInterval(state.syncIntervalId);
    clearTimeout(state.remoteActionTimeout);
    state.pingIntervalId = null;
    state.syncIntervalId = null;
}


// ── WebSocket ───────────────────────────────────────────
function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${location.host}/ws/${state.roomId}/${state.username}`;
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
        state.reconnectAttempts = 0;
        updateConnectionStatus(true);
        showToast('Connected to room!', 'success');

        // Start sync engine after connection
        startSyncEngine();
    };

    state.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWSMessage(data);
    };

    state.ws.onclose = () => {
        updateConnectionStatus(false);
        stopSyncEngine();
        if (state.roomId && state.reconnectAttempts < state.maxReconnect) {
            state.reconnectAttempts++;
            setTimeout(connectWebSocket, 2000 * state.reconnectAttempts);
        }
    };

    state.ws.onerror = () => {
        showToast('Connection error', 'info');
    };
}

function wsSend(data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(data));
    }
}

function handleWSMessage(data) {
    switch (data.type) {
        case 'room_state': {
            updateUsers(data.users);
            if (data.chat_history) data.chat_history.forEach(m => displayChat(m));
            if (data.playlist) updateQueue(data.playlist);

            // Process initial server time offset from room_state
            if (data.server_time) {
                const now = localTimeMs();
                // Rough offset (will be refined by pings)
                state.serverTimeOffset = data.server_time - now;
            }

            if (data.current_video && data.current_video.video_id && data.sync) {
                state.lastSyncState = data.sync;
                waitForPlayer(() => {
                    state.isRemoteAction = true;
                    const sync = data.sync;

                    // Calculate expected position accounting for load time
                    let targetPosition;
                    if (sync.is_playing) {
                        const elapsedSinceAnchor = (estimatedServerTimeMs() - sync.anchor_server_time) / 1000;
                        targetPosition = sync.anchor_position + elapsedSinceAnchor;
                    } else {
                        targetPosition = sync.position;
                    }

                    state.player.loadVideoById(data.current_video.video_id, Math.max(0, targetPosition));
                    state.currentVideoId = data.current_video.video_id;
                    showNowPlaying(data.current_video.title);

                    if (!sync.is_playing) {
                        setTimeout(() => state.player.pauseVideo(), 500);
                    }
                    clearRemoteActionFlag(1500);
                });
            }
            break;
        }

        case 'user_joined':
            updateUsers(data.users);
            addSystemChat(`${data.username} joined the room ✨`);
            showToast(`${data.username} joined!`, 'success');
            break;

        case 'user_left':
            updateUsers(data.users);
            addSystemChat(`${data.username} left the room`);
            break;

        case 'play': {
            const sync = data.sync;
            state.lastSyncState = sync;
            waitForPlayer(() => {
                state.isRemoteAction = true;
                const elapsedSinceAnchor = (estimatedServerTimeMs() - sync.anchor_server_time) / 1000;
                const targetPosition = sync.anchor_position + Math.max(0, elapsedSinceAnchor);
                const diff = Math.abs(state.player.getCurrentTime() - targetPosition);
                if (diff > 0.3) state.player.seekTo(targetPosition, true);
                state.player.playVideo();
                el.visualizer.classList.remove('paused');
                clearRemoteActionFlag(800);
            });
            break;
        }

        case 'pause': {
            const sync = data.sync;
            state.lastSyncState = sync;
            waitForPlayer(() => {
                state.isRemoteAction = true;
                state.player.seekTo(sync.position, true);
                state.player.pauseVideo();
                el.visualizer.classList.add('paused');
                clearRemoteActionFlag(800);
            });
            break;
        }

        case 'seek': {
            const sync = data.sync;
            state.lastSyncState = sync;
            waitForPlayer(() => {
                state.isRemoteAction = true;
                let targetPosition;
                if (sync.is_playing) {
                    const elapsedSinceAnchor = (estimatedServerTimeMs() - sync.anchor_server_time) / 1000;
                    targetPosition = sync.anchor_position + Math.max(0, elapsedSinceAnchor);
                } else {
                    targetPosition = sync.position;
                }
                state.player.seekTo(targetPosition, true);
                clearRemoteActionFlag(800);
            });
            break;
        }

        case 'change_video': {
            const sync = data.sync;
            state.lastSyncState = sync;
            waitForPlayer(() => {
                state.isRemoteAction = true;
                state.player.loadVideoById(data.video_id);
                state.currentVideoId = data.video_id;
                showNowPlaying(data.title);
                if (data.from !== state.username) addSystemChat(`${data.from} started playing: ${data.title}`);
                clearRemoteActionFlag(1500);
            });
            break;
        }

        case 'queue_updated':
            updateQueue(data.playlist);
            break;

        case 'chat':
            displayChat(data);
            break;

        case 'reaction':
            spawnReaction(data.emoji);
            break;

        case 'typing':
            showTyping(data.username);
            break;

        // ── Sync Engine Messages ──
        case 'pong':
            handlePong(data);
            break;

        case 'sync_response':
            handleSyncResponse(data);
            break;

        // ── WebRTC Signaling ──
        case 'webrtc_offer':
            handleWebRTCOffer(data);
            break;
        case 'webrtc_answer':
            handleWebRTCAnswer(data);
            break;
        case 'webrtc_ice':
            handleWebRTCIce(data);
            break;
        case 'webrtc_hangup':
            handleRemoteHangup(data);
            break;
    }
}

function waitForPlayer(callback) {
    if (state.playerReady) { callback(); return; }
    const interval = setInterval(() => {
        if (state.playerReady) { clearInterval(interval); callback(); }
    }, 200);
    setTimeout(() => clearInterval(interval), 10000);
}

function updateConnectionStatus(connected) {
    const el_status = el.connectionStatus;
    if (connected) {
        el_status.classList.add('connected');
        el_status.querySelector('.status-text').textContent = 'Connected';
    } else {
        el_status.classList.remove('connected');
        el_status.querySelector('.status-text').textContent = 'Reconnecting...';
    }
}

function updateUsers(users) {
    el.usersOnline.querySelector('.online-count').textContent = users.length;
    const statusText = users.length > 1 ? 'Watching together ✨' : 'Waiting for someone...';
    el.connectionStatus.querySelector('.status-text').textContent = statusText;
}

// ── YouTube Player ──────────────────────────────────────
function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) { createPlayer(); return; }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = createPlayer;
}

function createPlayer() {
    state.player = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 0, controls: 1, modestbranding: 1,
            rel: 0, fs: 1, playsinline: 1
        },
        events: {
            onReady: () => { state.playerReady = true; },
            onStateChange: onPlayerStateChange,
            onError: onPlayerError,
        }
    });
}

function onPlayerStateChange(event) {
    if (state.isRemoteAction) return;

    switch (event.data) {
        case YT.PlayerState.PLAYING:
            el.playerPlaceholder.style.display = 'none';
            el.visualizer.classList.remove('paused');
            wsSend({ type: 'play', time: state.player.getCurrentTime() });
            updateMediaSession('playing');
            startSilentAudio();
            break;
        case YT.PlayerState.PAUSED:
            // If page is hidden or server says we should be playing, this is a browser-forced pause
            const browserForcedPause = (document.hidden && state.wasPlayingBeforeHide) ||
                                       (document.hidden && state.lastSyncState && state.lastSyncState.is_playing);
            if (browserForcedPause) {
                // Fight the browser pause immediately
                state.isRemoteAction = true;
                state.player.playVideo();
                clearRemoteActionFlag(500);
                // Also ensure background resume loop is running
                if (!state.bgResumeIntervalId) {
                    startBackgroundResume();
                }
                return; // don't broadcast this fake pause
            }
            el.visualizer.classList.add('paused');
            wsSend({ type: 'pause', time: state.player.getCurrentTime() });
            updateMediaSession('paused');
            break;
        case YT.PlayerState.ENDED:
            el.visualizer.classList.add('paused');
            wsSend({ type: 'next_in_queue' });
            break;
    }
}

function onPlayerError(event) {
    showToast('Video unavailable or restricted', 'info');
}

function parseYouTubeUrl(input) {
    input = input.trim();
    // Direct video ID (11 chars)
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

    try {
        const url = new URL(input);
        if (url.hostname.includes('youtube.com')) {
            if (url.pathname === '/watch') return url.searchParams.get('v');
            if (url.pathname.startsWith('/embed/')) return url.pathname.split('/embed/')[1].split('?')[0];
            if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/shorts/')[1].split('?')[0];
        }
        if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('?')[0];
    } catch (e) {}

    return null;
}

function loadVideoFromInput() {
    const url = el.videoUrl.value.trim();
    if (!url) return;
    const videoId = parseYouTubeUrl(url);
    if (!videoId) { showToast('Invalid YouTube URL', 'info'); return; }

    const title = url;
    wsSend({ type: 'change_video', video_id: videoId, title: title });
    state.isRemoteAction = true;
    state.player.loadVideoById(videoId);
    state.currentVideoId = videoId;
    showNowPlaying(title);
    el.playerPlaceholder.style.display = 'none';
    el.videoUrl.value = '';
    clearRemoteActionFlag(1500);
}

function addToQueueFromInput() {
    const url = el.videoUrl.value.trim();
    if (!url) return;
    const videoId = parseYouTubeUrl(url);
    if (!videoId) { showToast('Invalid YouTube URL', 'info'); return; }

    const thumb = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    wsSend({ type: 'add_queue', video_id: videoId, title: url, thumbnail: thumb });
    el.videoUrl.value = '';
    showToast('Added to queue!', 'success');
}

function showNowPlaying(title) {
    el.nowPlayingBar.style.display = 'flex';
    el.npTitle.textContent = title;
    state.currentTitle = title;
    updateMediaSession('playing');
}

// ══════════════════ BACKGROUND PLAYBACK ══════════════════
// Robust system to keep music alive on mobile (screen off, home button, app switch)
// Uses: Web Audio API keep-alive, Wake Lock, Media Session, playback watchdog

function initBackgroundPlayback() {
    // ── 1. Web Audio API keep-alive (reliable silent tone for mobile) ──
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        state.audioCtx = new AudioContext();
        // Create a silent oscillator — keeps audio session alive
        const oscillator = state.audioCtx.createOscillator();
        const gainNode = state.audioCtx.createGain();
        gainNode.gain.value = 0.001; // essentially silent
        oscillator.connect(gainNode);
        gainNode.connect(state.audioCtx.destination);
        oscillator.frequency.value = 1; // 1 Hz — inaudible
        oscillator.type = 'sine';
        state.bgOscillator = oscillator;
        state.bgGainNode = gainNode;
    } catch (e) {
        console.warn('[BG] Web Audio API not available:', e);
    }

    // ── 2. Also keep the HTML5 Audio element as a fallback ──
    const silentAudio = new Audio();
    // Longer silence data URI (more compatible across mobile browsers)
    silentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    silentAudio.loop = true;
    silentAudio.volume = 0.01;
    silentAudio.setAttribute('playsinline', '');
    silentAudio.setAttribute('webkit-playsinline', '');
    state.silentAudio = silentAudio;

    // ── 3. Event listeners for all visibility/focus scenarios ──
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('blur', onWindowBlur);

    // ── 4. Acquire Web Lock to prevent tab throttling ──
    if (navigator.locks) {
        navigator.locks.request('vinnyy-bg-playback', { mode: 'shared' }, () => {
            return new Promise(() => {}); // hold forever
        });
    }

    // ── 5. Capture first user gesture to unlock all audio systems ──
    const unlockAudio = () => {
        // Resume AudioContext (required on mobile after user gesture)
        if (state.audioCtx && state.audioCtx.state === 'suspended') {
            state.audioCtx.resume();
        }
        // Start the silent oscillator
        if (state.bgOscillator && !state.bgOscillatorStarted) {
            try {
                state.bgOscillator.start(0);
                state.bgOscillatorStarted = true;
            } catch (e) {}
        }
        // Start silent audio element
        if (state.silentAudio && state.silentAudio.paused) {
            state.silentAudio.play().catch(() => {});
        }
        // Acquire Wake Lock
        acquireWakeLock();
        // Remove listeners after first gesture
        document.removeEventListener('touchstart', unlockAudio);
        document.removeEventListener('click', unlockAudio);
    };
    document.addEventListener('touchstart', unlockAudio, { once: true });
    document.addEventListener('click', unlockAudio, { once: true });

    // ── 6. Start playback watchdog (periodic check) ──
    state.bgWatchdogId = setInterval(playbackWatchdog, 2000);
}

/**
 * Watchdog: every 2s, check if the player should be playing but isn't.
 * This catches cases where the browser silently pauses the player
 * without firing a stateChange event (common on mobile background).
 */
function playbackWatchdog() {
    if (!state.player || !state.playerReady || !state.currentVideoId) return;

    // Check the last known server state — should we be playing?
    const shouldBePlaying = state.lastSyncState && state.lastSyncState.is_playing;
    if (!shouldBePlaying) return;

    const ps = state.player.getPlayerState();
    // If player is paused or unstarted but should be playing, force resume
    if (ps === YT.PlayerState.PAUSED || ps === -1 || ps === YT.PlayerState.CUED) {
        console.log('[BG-WATCHDOG] Player stopped unexpectedly, force-resuming');
        state.isRemoteAction = true;
        state.player.playVideo();
        clearRemoteActionFlag(800);

        // Also keep audio session alive
        startSilentAudio();
    }

    // Keep AudioContext alive
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume().catch(() => {});
    }
}

function onVisibilityChange() {
    if (document.hidden) {
        // ── Page is being hidden (screen off / home button / tab switch) ──
        if (state.player && state.playerReady) {
            const playerState = state.player.getPlayerState();
            state.wasPlayingBeforeHide = (playerState === YT.PlayerState.PLAYING ||
                                           playerState === YT.PlayerState.BUFFERING);
            if (state.wasPlayingBeforeHide) {
                // Start aggressive resume loop
                startBackgroundResume();
                // Make sure silent audio is running to hold audio session
                startSilentAudio();
                // Keep AudioContext alive
                if (state.audioCtx && state.audioCtx.state === 'suspended') {
                    state.audioCtx.resume().catch(() => {});
                }
            }
        }
    } else {
        // ── Page is visible again ──
        onReturnToForeground();
    }
}

function onPageShow(event) {
    // Fired when page is shown (including back-forward cache restores)
    if (!document.hidden) {
        onReturnToForeground();
    }
}

function onWindowFocus() {
    // Additional catch for when the window gains focus
    if (!document.hidden) {
        onReturnToForeground();
    }
}

function onWindowBlur() {
    // Window lost focus (may happen before visibilitychange on some browsers)
    if (state.player && state.playerReady) {
        const playerState = state.player.getPlayerState();
        if (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING) {
            state.wasPlayingBeforeHide = true;
            startSilentAudio();
        }
    }
}

function onReturnToForeground() {
    // Clear any background resume loops
    clearTimeout(state.bgResumeTimeout);
    if (state.bgResumeIntervalId) {
        clearInterval(state.bgResumeIntervalId);
        state.bgResumeIntervalId = null;
    }

    // Re-acquire wake lock (it may have been released)
    acquireWakeLock();

    // Resume AudioContext if suspended
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume().catch(() => {});
    }

    // Request a fresh sync from server
    if (state.currentVideoId) {
        setTimeout(() => requestSync(), 100);
    }

    // Force-resume if the player was paused by the browser
    if (state.player && state.playerReady && state.currentVideoId) {
        const playerState = state.player.getPlayerState();
        const shouldResume = state.wasPlayingBeforeHide ||
                             (state.lastSyncState && state.lastSyncState.is_playing);

        if ((playerState === YT.PlayerState.PAUSED || playerState === -1) && shouldResume) {
            state.isRemoteAction = true;
            state.player.playVideo();
            el.visualizer.classList.remove('paused');
            clearRemoteActionFlag(800);
        }
    }

    state.wasPlayingBeforeHide = false;
}

function startBackgroundResume() {
    // Clear any existing resume attempts
    clearTimeout(state.bgResumeTimeout);
    if (state.bgResumeIntervalId) {
        clearInterval(state.bgResumeIntervalId);
    }

    const tryResume = () => {
        if (!document.hidden && !state.wasPlayingBeforeHide) return;
        if (state.player && state.playerReady) {
            const ps = state.player.getPlayerState();
            if (ps === YT.PlayerState.PAUSED || ps === -1 || ps === YT.PlayerState.CUED) {
                state.isRemoteAction = true;
                state.player.playVideo();
                clearRemoteActionFlag(500);
            }
        }
    };

    // First attempt quickly
    state.bgResumeTimeout = setTimeout(tryResume, 150);

    // Then keep trying every 800ms while in background (more aggressive)
    state.bgResumeIntervalId = setInterval(tryResume, 800);
}

function startSilentAudio() {
    // Start silent audio to keep audio session alive
    if (state.silentAudio && state.silentAudio.paused) {
        state.silentAudio.play().catch(() => {});
    }
    // Also ensure AudioContext oscillator is running
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
        state.audioCtx.resume().catch(() => {});
    }
}

/**
 * Wake Lock API — prevents screen from sleeping / browser from suspending.
 */
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => {
            // Re-acquire if released (e.g., tab switch)
            if (!document.hidden) {
                setTimeout(acquireWakeLock, 1000);
            }
        });
    } catch (e) {
        // Wake lock request failed (e.g., low battery, or page hidden)
    }
}

function updateMediaSession(playbackState) {
    // Media Session API — shows controls on lock screen / notification
    if (!('mediaSession' in navigator)) return;
    const title = state.currentTitle || 'VInnyy';

    navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: 'VInnyy — Watching Together',
        album: 'VInnyy Sync',
        artwork: state.currentVideoId ? [
            { src: `https://img.youtube.com/vi/${state.currentVideoId}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' },
            { src: `https://img.youtube.com/vi/${state.currentVideoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' },
            { src: `https://img.youtube.com/vi/${state.currentVideoId}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' },
        ] : []
    });

    navigator.mediaSession.playbackState = playbackState || 'playing';

    // Lock screen controls — these override the default media button behavior
    navigator.mediaSession.setActionHandler('play', () => {
        if (state.player && state.playerReady) {
            state.player.playVideo();
            wsSend({ type: 'play', time: state.player.getCurrentTime() });
            startSilentAudio();
        }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        if (state.player && state.playerReady) {
            state.player.pauseVideo();
            wsSend({ type: 'pause', time: state.player.getCurrentTime() });
        }
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        wsSend({ type: 'next_in_queue' });
    });
    navigator.mediaSession.setActionHandler('previoustrack', null);
    try {
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            if (state.player && state.playerReady) {
                const skipTime = details.seekOffset || 10;
                const newTime = Math.max(0, state.player.getCurrentTime() - skipTime);
                state.player.seekTo(newTime, true);
                wsSend({ type: 'seek', time: newTime });
            }
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
            if (state.player && state.playerReady) {
                const skipTime = details.seekOffset || 10;
                const newTime = state.player.getCurrentTime() + skipTime;
                state.player.seekTo(newTime, true);
                wsSend({ type: 'seek', time: newTime });
            }
        });
    } catch (e) {}
}

// ── In-App Search ───────────────────────────────────────
function onSearchInput() {
    clearTimeout(state.searchTimeout);
    const q = el.searchInput.value.trim();
    if (!q) { closeSearchResults(); return; }
    // Debounce 500ms
    state.searchTimeout = setTimeout(() => performSearch(q), 500);
}

async function performSearch(query) {
    if (!query || query === state.lastQuery) return;
    state.lastQuery = query;

    el.searchSpinner.style.display = 'block';
    el.searchResults.style.display = 'block';
    el.searchResultsGrid.innerHTML = '';
    el.resultsCount.textContent = 'Searching...';

    try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        el.searchSpinner.style.display = 'none';

        if (!data.results || data.results.length === 0) {
            el.resultsCount.textContent = 'No results found';
            el.searchResultsGrid.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); grid-column:1/-1;">No results found. Try a different search.</div>';
            return;
        }

        el.resultsCount.textContent = `${data.results.length} results`;
        renderSearchResults(data.results);
    } catch (err) {
        el.searchSpinner.style.display = 'none';
        el.resultsCount.textContent = 'Search failed';
        showToast('Search failed, please try again', 'info');
    }
}

function renderSearchResults(results) {
    el.searchResultsGrid.innerHTML = '';
    results.forEach((r, idx) => {
        const card = document.createElement('div');
        card.className = 'search-result-card';
        card.style.animationDelay = `${idx * 0.05}s`;
        card.innerHTML = `
            <div class="result-thumb">
                <img src="${r.thumbnail || `https://img.youtube.com/vi/${r.video_id}/mqdefault.jpg`}" alt="" loading="lazy">
                ${r.duration ? `<span class="result-duration">${escapeHtml(r.duration)}</span>` : ''}
                <div class="result-play-overlay">
                    <div class="result-play-icon">▶</div>
                </div>
            </div>
            <div class="result-info">
                <div class="result-title">${escapeHtml(r.title)}</div>
                <div class="result-meta">
                    <span class="result-channel">${escapeHtml(r.channel)}</span>
                    ${r.views ? ` · ${escapeHtml(r.views)}` : ''}
                </div>
            </div>
            <div class="result-actions">
                <button class="result-action-btn play-btn" data-vid="${r.video_id}" data-title="${escapeHtml(r.title)}">▶ Play</button>
                <button class="result-action-btn queue-btn" data-vid="${r.video_id}" data-title="${escapeHtml(r.title)}">+ Queue</button>
            </div>
        `;

        // Click on thumbnail = play
        card.querySelector('.result-thumb').addEventListener('click', () => playFromSearch(r.video_id, r.title));
        // Play button
        card.querySelector('.play-btn').addEventListener('click', (e) => { e.stopPropagation(); playFromSearch(r.video_id, r.title); });
        // Queue button
        card.querySelector('.queue-btn').addEventListener('click', (e) => { e.stopPropagation(); queueFromSearch(r.video_id, r.title, r.thumbnail); });

        el.searchResultsGrid.appendChild(card);
    });
}

function playFromSearch(videoId, title) {
    wsSend({ type: 'change_video', video_id: videoId, title: title });
    state.isRemoteAction = true;
    state.player.loadVideoById(videoId);
    state.currentVideoId = videoId;
    showNowPlaying(title);
    el.playerPlaceholder.style.display = 'none';
    clearRemoteActionFlag(1500);
    showToast(`Now playing: ${title}`, 'success');
}

function queueFromSearch(videoId, title, thumbnail) {
    const thumb = thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    wsSend({ type: 'add_queue', video_id: videoId, title: title, thumbnail: thumb });
    showToast('Added to queue!', 'success');
}

function closeSearchResults() {
    el.searchResults.style.display = 'none';
    el.searchResultsGrid.innerHTML = '';
    state.lastQuery = '';
    $$('.mood-tag').forEach(b => b.classList.remove('active'));
}

// ── Chat ────────────────────────────────────────────────
function sendChat() {
    const msg = el.chatInput.value.trim();
    if (!msg) return;
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    wsSend({ type: 'chat', message: msg, timestamp: timestamp });
    displayChat({ username: state.username, message: msg, timestamp: timestamp });
    el.chatInput.value = '';
}

function displayChat(data) {
    if (data.username === state.username && el.chatMessages.querySelector(`[data-last-self]`)) {
        // Avoid duplicating own messages if they echo back
        const lastSelf = el.chatMessages.querySelector(`[data-last-self]`);
        if (lastSelf && lastSelf.dataset.lastSelf === data.message) return;
    }

    const div = document.createElement('div');
    const isSelf = data.username === state.username;
    div.className = `chat-msg ${isSelf ? 'self' : 'other'}`;

    if (!isSelf) {
        div.innerHTML = `<div class="msg-username">${escapeHtml(data.username)}</div>`;
    }
    div.innerHTML += `<div class="msg-text">${escapeHtml(data.message)}</div>`;
    div.innerHTML += `<div class="msg-time">${data.timestamp || ''}</div>`;

    if (isSelf) div.dataset.lastSelf = data.message;

    // Remove previous last-self markers
    if (isSelf) {
        el.chatMessages.querySelectorAll('[data-last-self]').forEach(el => {
            if (el !== div) delete el.dataset.lastSelf;
        });
    }

    el.chatMessages.appendChild(div);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function addSystemChat(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.textContent = text;
    el.chatMessages.appendChild(div);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function sendTyping() {
    clearTimeout(state.typingTimeout);
    wsSend({ type: 'typing' });
}

function showTyping(username) {
    el.chatTyping.style.display = 'flex';
    el.typingName.textContent = username;
    clearTimeout(state.typingHideTimeout);
    state.typingHideTimeout = setTimeout(() => {
        el.chatTyping.style.display = 'none';
    }, 2000);
}

// ── Queue ───────────────────────────────────────────────
function updateQueue(playlist) {
    // Update badge
    if (playlist.length > 0) {
        el.queueBadge.style.display = 'inline';
        el.queueBadge.textContent = playlist.length;
        el.playNextBtn.style.display = 'block';
    } else {
        el.queueBadge.style.display = 'none';
        el.playNextBtn.style.display = 'none';
    }

    el.queueList.innerHTML = '';
    if (playlist.length === 0) {
        el.queueList.innerHTML = '<div class="queue-empty"><span>📋</span><p>Queue is empty</p><p class="queue-hint">Paste a URL and click "+ Queue" to add</p></div>';
        return;
    }

    playlist.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'queue-item';
        div.innerHTML = `
            <div class="queue-thumb"><img src="${item.thumbnail || `https://img.youtube.com/vi/${item.video_id}/mqdefault.jpg`}" alt="" loading="lazy"></div>
            <div class="queue-item-info">
                <div class="queue-item-title">${escapeHtml(item.title || item.video_id)}</div>
            </div>
            <button class="queue-remove" data-index="${idx}" title="Remove">✕</button>
        `;
        div.querySelector('.queue-remove').addEventListener('click', () => {
            wsSend({ type: 'remove_queue', index: idx });
        });
        el.queueList.appendChild(div);
    });

    // Play next button
    el.playNextBtn.onclick = () => wsSend({ type: 'next_in_queue' });
}

// ── Tabs ────────────────────────────────────────────────
function switchTab(tab) {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    el.chatPanel.style.display = tab === 'chat' ? 'flex' : 'none';
    el.queuePanel.style.display = tab === 'queue' ? 'flex' : 'none';
    el.foldersPanel.style.display = tab === 'folders' ? 'flex' : 'none';
    if (tab === 'folders') {
        loadFolders();
    }
}

// ── Folders ──────────────────────────────────────────────
async function importPlaylist() {
    const url = el.playlistUrlInput.value.trim();
    if (!url) return;
    if (!state.username) { showToast('Please join a room first', 'info'); return; }
    
    el.importPlaylistBtn.disabled = true;
    el.importPlaylistBtn.innerHTML = '<span class="search-spinner" style="display:inline-block;width:12px;height:12px;margin:0;border-top-color:#fff;"></span>';
    
    const isYouTube = url.includes('youtube.com/') && url.includes('list=');
    const endpoint = isYouTube ? '/api/music/youtube/import' : '/api/music/spotify/import';
    const folderName = isYouTube ? "YouTube Import" : "Spotify Import";

    try {
        const payload = {
            username: state.username,
            playlist: url,
            folder_name: folderName,
            room_id: state.roomId,
            add_to_shared: true
        };
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.detail || 'Import failed');
        }
        showToast('Playlist imported successfully!', 'success');
        el.playlistUrlInput.value = '';
        loadFolders();
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        el.importPlaylistBtn.disabled = false;
        el.importPlaylistBtn.textContent = 'Import';
    }
}

async function loadFolders() {
    el.foldersList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">Loading folders...</div>';
    try {
        const res = await fetch(`/api/music/folders/${state.username}`);
        const data = await res.json();
        
        if (!data.folders || data.folders.length === 0) {
            el.foldersList.innerHTML = `<div class="folders-empty"><span>📁</span><p>No folders yet</p><p class="folders-hint">Import Spotify or YouTube playlists to create folders</p></div>`;
            return;
        }

        el.foldersList.innerHTML = '';
        data.folders.forEach(folder => {
            const div = document.createElement('div');
            div.className = 'folder-item glass';
            div.innerHTML = `
                <div class="folder-info">
                    <div class="folder-name">📁 ${escapeHtml(folder.folder_name)}</div>
                    <div class="folder-count">${folder.count} song${folder.count !== 1 ? 's' : ''}</div>
                </div>
                <button class="folder-queue-btn" data-folder="${escapeHtml(folder.folder_name)}" title="Queue all">+ Queue</button>
            `;
            
            div.querySelector('.folder-queue-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                queueFolder(folder.folder_name);
            });
            
            div.addEventListener('click', () => viewFolderSongs(folder.folder_name));
            el.foldersList.appendChild(div);
        });
    } catch (err) {
        el.foldersList.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:20px;">Error loading folders</div>';
        showToast('Failed to load folders', 'info');
    }
}

async function viewFolderSongs(folderName) {
    try {
        const res = await fetch(`/api/music/folders/${state.username}/${encodeURIComponent(folderName)}`);
        const data = await res.json();
        
        if (!data.songs || data.songs.length === 0) {
            showToast('Folder is empty', 'info');
            return;
        }

        // Show songs in a toast-like panel or modal (simple approach: list in foldersList)
        el.foldersList.innerHTML = `
            <div style="margin-bottom:10px;">
                <button class="btn-ghost" style="width:100%; margin-bottom:10px;" onclick="loadFolders()">← Back to Folders</button>
            </div>
        `;
        
        const heading = document.createElement('div');
        heading.innerHTML = `<div style="color:var(--text-secondary); font-size:0.9rem; margin:10px 0; font-weight:600;">📁 ${escapeHtml(folderName)}</div>`;
        el.foldersList.appendChild(heading);

        data.songs.forEach(song => {
            const div = document.createElement('div');
            div.className = 'song-preview glass';
            div.innerHTML = `
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:500; font-size:0.85rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(song.title)}</div>
                    <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(song.artist)}</div>
                </div>
                <button class="folder-song-queue-btn" data-vid="${song.youtube_video_id}" data-title="${escapeHtml(song.title)}" style="padding:4px 8px; font-size:0.75rem;">+ Q</button>
            `;
            
            div.querySelector('.folder-song-queue-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const vid = e.target.dataset.vid;
                const title = e.target.dataset.title;
                wsSend({ type: 'add_queue', video_id: vid, title: title, thumbnail: `https://img.youtube.com/vi/${vid}/mqdefault.jpg` });
                showToast(`Added to queue`, 'success');
            });
            
            el.foldersList.appendChild(div);
        });
    } catch (err) {
        showToast('Failed to load folder songs', 'info');
    }
}

async function queueFolder(folderName) {
    try {
        const res = await fetch(`/api/music/queue/load-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: state.username,
                folder_name: folderName,
                room_id: state.roomId
            })
        });
        const data = await res.json();
        
        if (res.ok && data.songs) {
            // Send each song to queue via WebSocket
            data.songs.forEach(song => {
                wsSend({ 
                    type: 'add_queue', 
                    video_id: song.youtube_video_id, 
                    title: song.title, 
                    thumbnail: `https://img.youtube.com/vi/${song.youtube_video_id}/mqdefault.jpg` 
                });
            });
            showToast(`Queued ${data.count} songs from ${folderName}`, 'success');
        } else {
            showToast('Failed to queue folder', 'info');
        }
    } catch (err) {
        showToast('Error queuing folder', 'info');
    }
}


// ── Reactions ───────────────────────────────────────────
function sendReaction(emoji) {
    wsSend({ type: 'reaction', emoji: emoji });
    spawnReaction(emoji);
}

function spawnReaction(emoji) {
    const span = document.createElement('span');
    span.className = 'floating-reaction';
    span.textContent = emoji;
    span.style.left = `${Math.random() * 100 - 50}px`;
    el.reactionsContainer.appendChild(span);
    setTimeout(() => span.remove(), 2000);
}

// ── Toast Notifications ─────────────────────────────────
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : 'ℹ'}</span> ${escapeHtml(message)}`;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('exit');
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// ── Particles ───────────────────────────────────────────
function initParticles() {
    const canvas = el.canvas;
    const ctx = canvas.getContext('2d');
    let particles = [];
    const count = 80;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    class Particle {
        constructor() { this.reset(); }
        reset() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 0.5;
            this.speedX = (Math.random() - 0.5) * 0.3;
            this.speedY = (Math.random() - 0.5) * 0.3;
            this.opacity = Math.random() * 0.5 + 0.1;
            this.pulse = Math.random() * Math.PI * 2;
        }
        update() {
            this.x += this.speedX;
            this.y += this.speedY;
            this.pulse += 0.02;
            if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) this.reset();
        }
        draw() {
            const alpha = this.opacity + Math.sin(this.pulse) * 0.15;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(167, 139, 250, ${alpha})`;
            ctx.fill();
        }
    }

    for (let i = 0; i < count; i++) particles.push(new Particle());

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });

        // Draw connections
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    ctx.beginPath();
                    ctx.strokeStyle = `rgba(139, 92, 246, ${0.06 * (1 - dist / 120)})`;
                    ctx.lineWidth = 0.5;
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.stroke();
                }
            }
        }
        requestAnimationFrame(animate);
    }
    animate();
}

// ── Utilities ───────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
// ██  VIDEO CALL — WebRTC Peer-to-Peer                    ██
// ═══════════════════════════════════════════════════════════

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]
};

function toggleVideoCall() {
    if (state.videoCallActive) {
        endVideoCall();
    } else {
        startVideoCall();
    }
}

async function startVideoCall() {
    try {
        // Get local camera + mic
        state.localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: true,
        });

        // Show local video
        el.localVideo.srcObject = state.localStream;
        el.videocallPanel.style.display = 'block';
        el.videocallBtn.classList.add('active');
        state.videoCallActive = true;
        state.micMuted = false;
        state.camOff = false;
        el.vcToggleMic.classList.remove('muted');
        el.vcToggleCam.classList.remove('muted');
        el.vcMicIcon.textContent = '🎤';
        el.vcCamIcon.textContent = '📷';

        // Show waiting state
        el.remotePlaceholder.style.display = 'flex';
        updateVCStatus('Connecting...', false);

        // Create peer connection
        createPeerConnection();

        // Create and send offer
        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);
        wsSend({ type: 'webrtc_offer', sdp: state.peerConnection.localDescription });

        showToast('Video call started!', 'success');
        startCallTimer();
        addSystemChat(`${state.username} started a video call 📹`);

    } catch (err) {
        console.error('[VC] Failed to start:', err);
        showToast('Camera access denied or unavailable', 'info');
        cleanupVideoCall();
    }
}

function createPeerConnection() {
    state.peerConnection = new RTCPeerConnection(RTC_CONFIG);

    // Add local tracks to connection
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            state.peerConnection.addTrack(track, state.localStream);
        });
    }

    // Handle incoming remote tracks
    state.peerConnection.ontrack = (event) => {
        state.remoteStream = event.streams[0];
        el.remoteVideo.srcObject = state.remoteStream;
        el.remotePlaceholder.style.display = 'none';
        updateVCStatus('Connected', true);
    };

    // Handle ICE candidates
    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            wsSend({ type: 'webrtc_ice', candidate: event.candidate });
        }
    };

    // Connection state changes
    state.peerConnection.onconnectionstatechange = () => {
        const cs = state.peerConnection.connectionState;
        if (cs === 'connected') {
            updateVCStatus('Connected', true);
        } else if (cs === 'disconnected' || cs === 'failed') {
            updateVCStatus('Disconnected', false);
        }
    };

    state.peerConnection.oniceconnectionstatechange = () => {
        const ics = state.peerConnection.iceConnectionState;
        if (ics === 'disconnected' || ics === 'failed' || ics === 'closed') {
            updateVCStatus('Disconnected', false);
        }
    };
}

async function handleWebRTCOffer(data) {
    // Someone is calling us — auto-answer
    if (!state.videoCallActive) {
        try {
            state.localStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
                audio: true,
            });
            el.localVideo.srcObject = state.localStream;
            el.videocallPanel.style.display = 'block';
            el.videocallBtn.classList.add('active');
            state.videoCallActive = true;
            state.micMuted = false;
            state.camOff = false;
            el.vcToggleMic.classList.remove('muted');
            el.vcToggleCam.classList.remove('muted');
            el.vcMicIcon.textContent = '🎤';
            el.vcCamIcon.textContent = '📷';
            el.remotePlaceholder.style.display = 'flex';
            updateVCStatus('Connecting...', false);
        } catch (err) {
            console.error('[VC] Failed to get media for answer:', err);
            showToast('Camera access denied', 'info');
            return;
        }
        showToast(`${data.from} started a video call! 📹`, 'success');
    }

    createPeerConnection();

    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    wsSend({ type: 'webrtc_answer', sdp: state.peerConnection.localDescription });
}

async function handleWebRTCAnswer(data) {
    if (state.peerConnection && state.peerConnection.signalingState !== 'stable') {
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
}

async function handleWebRTCIce(data) {
    if (state.peerConnection && data.candidate) {
        try {
            await state.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.warn('[VC] ICE candidate error:', e);
        }
    }
}

function handleRemoteHangup(data) {
    showToast(`${data.from} ended the video call`, 'info');
    cleanupVideoCall();
}

function endVideoCall() {
    wsSend({ type: 'webrtc_hangup' });
    cleanupVideoCall();
    showToast('Video call ended', 'info');
}

function cleanupVideoCall() {
    // Close peer connection
    if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
    }

    // Stop local media tracks
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }

    // Clear video elements
    el.localVideo.srcObject = null;
    el.remoteVideo.srcObject = null;
    state.remoteStream = null;

    // Animate panel out
    if (el.videocallPanel.style.display !== 'none') {
        el.videocallPanel.classList.add('closing');
        setTimeout(() => {
            el.videocallPanel.style.display = 'none';
            el.videocallPanel.classList.remove('closing');
        }, 300);
    }

    // Reset UI
    el.videocallBtn.classList.remove('active');
    state.videoCallActive = false;
    state.micMuted = false;
    state.camOff = false;
    el.remotePlaceholder.style.display = 'flex';
    updateVCStatus('Connecting...', false);
    stopCallTimer();
    // Reset minimized state
    el.videocallPanel.classList.remove('minimized');
    el.vcBody.style.display = 'block';
    el.vcMinimizeIcon.textContent = '─';
    // Reset size presets + drag position
    resetVideoSize();
    el.videocallPanel.style.left = '';
    el.videocallPanel.style.right = '';
    el.videocallPanel.style.top = '';
    el.videocallPanel.style.bottom = '';
}

// ── Mic / Cam Controls ──
function toggleMic() {
    if (!state.localStream) return;
    state.micMuted = !state.micMuted;
    state.localStream.getAudioTracks().forEach(t => t.enabled = !state.micMuted);
    el.vcToggleMic.classList.toggle('muted', state.micMuted);
    el.vcMicIcon.textContent = state.micMuted ? '🔇' : '🎤';
}

function toggleCam() {
    if (!state.localStream) return;
    state.camOff = !state.camOff;
    state.localStream.getVideoTracks().forEach(t => t.enabled = !state.camOff);
    el.vcToggleCam.classList.toggle('muted', state.camOff);
    el.vcCamIcon.textContent = state.camOff ? '🚫' : '📷';
}

function updateVCStatus(text, connected) {
    const statusEl = el.videocallStatus;
    statusEl.classList.toggle('connected', connected);
    statusEl.querySelector('.vc-status-text').textContent = text;
}

// ── Draggable Panel with Snap-to-Edge + Boundary Clamping ──
function initDragPanel() {
    const panel = el.videocallPanel;
    const handle = el.vcDragHandle;
    let isDragging = false, startX, startY, startLeft, startTop;
    const EDGE_SNAP = 20; // px threshold for snapping to edges
    const MARGIN = 12;    // minimum margin from viewport edges

    function clampPosition(left, top) {
        const pw = panel.offsetWidth;
        const ph = panel.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));
        top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));
        return { left, top };
    }

    function snapToEdge(left, top) {
        const pw = panel.offsetWidth;
        const ph = panel.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Snap X
        if (left < EDGE_SNAP + MARGIN) left = MARGIN;
        else if (left > vw - pw - EDGE_SNAP - MARGIN) left = vw - pw - MARGIN;
        // Snap Y
        if (top < EDGE_SNAP + MARGIN) top = MARGIN;
        else if (top > vh - ph - EDGE_SNAP - MARGIN) top = vh - ph - MARGIN;
        return { left, top };
    }

    function applyPosition(left, top, animate = false) {
        const pos = snapToEdge(...Object.values(clampPosition(left, top)));
        panel.style.transition = animate ? '0.35s cubic-bezier(0.25, 1, 0.5, 1)' : 'none';
        panel.style.left = pos.left + 'px';
        panel.style.top = pos.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    // Mouse
    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('.vc-minimize-btn')) return;
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.transition = 'none';
        panel.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const pos = clampPosition(startLeft + dx, startTop + dy);
        panel.style.left = pos.left + 'px';
        panel.style.top = pos.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            panel.style.cursor = '';
            // Snap to nearest edge with animation
            const rect = panel.getBoundingClientRect();
            applyPosition(rect.left, rect.top, true);
        }
    });

    // Touch
    handle.addEventListener('touchstart', (e) => {
        if (e.target.closest('.vc-minimize-btn')) return;
        isDragging = true;
        const touch = e.touches[0];
        const rect = panel.getBoundingClientRect();
        startX = touch.clientX; startY = touch.clientY;
        startLeft = rect.left; startTop = rect.top;
        panel.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        const pos = clampPosition(startLeft + dx, startTop + dy);
        panel.style.left = pos.left + 'px';
        panel.style.top = pos.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (isDragging) {
            isDragging = false;
            const rect = panel.getBoundingClientRect();
            applyPosition(rect.left, rect.top, true);
        }
    });

    // Double-click header to minimize
    handle.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.vc-minimize-btn')) toggleMinimize();
    });
}

// ── Resizable Panel ──
function initResizePanel() {
    const panel = el.videocallPanel;
    const resizeHandle = el.vcResizeHandle;
    let isResizing = false, startW, startH, startX, startY;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startW = panel.offsetWidth;
        startH = panel.offsetHeight;
        startX = e.clientX; startY = e.clientY;
        panel.style.transition = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newW = Math.max(240, Math.min(600, startW + (e.clientX - startX)));
        const newH = Math.max(200, Math.min(500, startH + (e.clientY - startY)));
        panel.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            panel.style.transition = '';
        }
    });
}

// ── Minimize / Expand Toggle ──
function toggleMinimize() {
    const panel = el.videocallPanel;
    const body = el.vcBody;
    const isMinimized = panel.classList.toggle('minimized');
    body.style.display = isMinimized ? 'none' : 'block';
    el.vcMinimizeIcon.textContent = isMinimized ? '□' : '─';
    el.vcMinimize.title = isMinimized ? 'Expand' : 'Minimize';
}

// ── Video Size Presets (mobile) ──
const VC_SIZES = ['vc-size-small', 'vc-size-medium', 'vc-size-large', 'vc-size-full'];
const VC_SIZE_LABELS = ['S', 'M', 'L', '⛶'];

function cycleVideoSize() {
    const panel = el.videocallPanel;
    // Remove current size class
    VC_SIZES.forEach(cls => panel.classList.remove(cls));
    // Advance to next
    state.vcSizeIndex = (state.vcSizeIndex + 1) % VC_SIZES.length;
    panel.classList.add(VC_SIZES[state.vcSizeIndex]);
    el.vcSizeIcon.textContent = VC_SIZE_LABELS[state.vcSizeIndex];
    // Reset manual drag position when switching to full
    if (VC_SIZES[state.vcSizeIndex] === 'vc-size-full') {
        panel.style.left = '';
        panel.style.right = '12px';
        panel.style.top = '';
        panel.style.bottom = '12px';
    }
}

function resetVideoSize() {
    const panel = el.videocallPanel;
    VC_SIZES.forEach(cls => panel.classList.remove(cls));
    state.vcSizeIndex = 0;
    if (el.vcSizeIcon) el.vcSizeIcon.textContent = 'S';
}

// ── Call Timer ──
let vcTimerInterval = null;
let vcCallStartTime = 0;

function startCallTimer() {
    vcCallStartTime = Date.now();
    el.vcTimer.textContent = '00:00';
    vcTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - vcCallStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        el.vcTimer.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopCallTimer() {
    if (vcTimerInterval) {
        clearInterval(vcTimerInterval);
        vcTimerInterval = null;
    }
    el.vcTimer.textContent = '00:00';
}
