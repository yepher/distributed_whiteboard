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
  const ws = new WebSocket(`${protocol}//${location.host}?role=viewer&session=${sessionId}`);
  const statusEl = document.getElementById('connection-status');
  const indicatorEl = document.getElementById('board-indicator');

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    setTimeout(() => statusEl.classList.add('fade'), 2000);
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected — waiting for reconnect...';
    statusEl.className = 'disconnected';
    // Auto-reconnect after 2s
    setTimeout(() => location.reload(), 2000);
  };

  ws.onerror = () => {
    statusEl.textContent = 'Connection error';
    statusEl.className = 'disconnected';
  };

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

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case 'fullState':
        wb.loadFullState(msg);
        document.body.classList.toggle('theme-dark', msg.theme === 'dark');
        document.body.classList.toggle('theme-light', msg.theme === 'light');
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
        document.body.classList.toggle('theme-dark', msg.theme === 'dark');
        document.body.classList.toggle('theme-light', msg.theme === 'light');
        break;
    }
  };
})();
