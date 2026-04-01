/**
 * Viewer — read-only canvas that receives strokes via WebSocket
 */
(function () {
  // --- Session ID ---
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  if (!sessionId) {
    document.body.innerHTML = '<div style="color:#888;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center"><div><h2 style="color:#fff;margin-bottom:8px">No session ID</h2><p>Open a viewer link shared by a presenter.</p></div></div>';
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}?role=viewer&session=${sessionId}`;
  const statusEl = document.getElementById('connection-status');
  const indicatorEl = document.getElementById('board-indicator');
  let ws = null;
  let wsReconnectTimer = null;

  let wsConnectAttempts = 0;

  function connectWebSocket() {
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      showOffline();
      return;
    }

    ws.onopen = () => {
      wsConnectAttempts = 0;
      statusEl.textContent = 'Connected';
      statusEl.className = 'connected';
      setTimeout(() => statusEl.classList.add('fade'), 2000);
      ws.onmessage = handleMessage;
      if (wsReconnectTimer) {
        clearInterval(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    };

    ws.onclose = () => {
      wsConnectAttempts++;
      showOffline();
      if (wsConnectAttempts <= 1) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {};
  }

  function showOffline() {
    statusEl.textContent = 'Waiting for server...';
    statusEl.className = 'disconnected';
    statusEl.classList.remove('fade');
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setInterval(() => {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectWebSocket();
      }
    }, 5000);
  }

  connectWebSocket();

  // Whiteboard (read-only)
  const canvas = document.getElementById('whiteboard');
  const wb = new Whiteboard(canvas, {
    interactive: false,
    theme: 'dark',
  });

  // Track board list for indicator
  let boardIds = [0];

  function updateIndicator(boardId) {
    const idx = boardIds.indexOf(boardId);
    indicatorEl.textContent = `Board ${idx + 1} of ${boardIds.length}`;
    indicatorEl.classList.add('show');
    clearTimeout(updateIndicator._timer);
    updateIndicator._timer = setTimeout(() => {
      indicatorEl.classList.remove('show');
    }, 3000);
  }

  // --- Fullscreen ---
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const iconExpand = btnFullscreen.querySelector('.icon-expand');
  const iconCompress = btnFullscreen.querySelector('.icon-compress');

  btnFullscreen.addEventListener('click', () => {
    const el = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch(() => {});
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  });

  function onFullscreenChange() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    iconExpand.style.display = isFs ? 'none' : '';
    iconCompress.style.display = isFs ? '' : 'none';
    setTimeout(() => wb.resize(), 100);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // Prevent iPad gestures from escaping fullscreen
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
  document.addEventListener('gestureend', (e) => e.preventDefault());

  // --- Download menu ---
  const btnDownload = document.getElementById('btn-download');
  const downloadMenu = document.getElementById('download-menu');
  if (btnDownload && downloadMenu) {
    btnDownload.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadMenu.classList.toggle('show');
    });
    document.addEventListener('click', () => downloadMenu.classList.remove('show'));
    downloadMenu.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        downloadMenu.classList.remove('show');
        if (btn.dataset.format === 'svg') {
          wb.downloadSVG();
        } else if (btn.dataset.format === 'pdf') {
          btn.textContent = 'Generating...';
          await wb.downloadPDF();
          btn.textContent = 'PDF (all boards)';
        }
      });
    });
  }

  function handleMessage(event) {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'fullState':
        wb.loadFullState(msg);
        document.body.classList.remove('theme-dark', 'theme-light', 'theme-green');
        document.body.classList.add('theme-' + (msg.theme || 'dark'));
        boardIds = msg.boards.map((b) => b.id);
        updateIndicator(msg.currentBoardId);
        break;

      case 'draw':
        wb.addRemoteStroke(msg);
        break;

      case 'drawLive':
        wb.setLiveStroke(msg);
        break;

      case 'moveElement':
        wb.applyMove(msg);
        break;

      case 'moveLive':
        wb.applyMoveLive(msg);
        break;

      case 'deleteElement':
        wb.applyDelete(msg);
        break;

      case 'undo':
        wb.remoteUndo(msg.boardId);
        break;

      case 'redo':
        wb.remoteRedo(msg.boardId, msg.stroke);
        break;

      case 'clear':
        if (msg.boardId === wb.currentBoardId) {
          wb.clearBoard();
        } else {
          const board = wb.boards.get(msg.boardId);
          if (board) {
            board.strokes = [];
            board.undone = [];
          }
        }
        break;

      case 'switchBoard':
        wb.switchBoard(msg.boardId);
        updateIndicator(msg.boardId);
        break;

      case 'addBoard':
        wb.addBoard(msg.boardId);
        boardIds.push(msg.boardId);
        break;

      case 'deleteBoard':
        wb.deleteBoard(msg.boardId);
        boardIds = boardIds.filter((id) => id !== msg.boardId);
        if (wb.currentBoardId === msg.boardId) {
          wb.switchBoard(msg.currentBoardId);
          updateIndicator(msg.currentBoardId);
        }
        break;

      case 'themeChange':
        wb.setTheme(msg.theme);
        document.body.classList.remove('theme-dark', 'theme-light', 'theme-green');
        document.body.classList.add('theme-' + (msg.theme || 'dark'));
        break;
    }
  }
})();
