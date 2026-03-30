/**
 * Viewer — read-only canvas that receives strokes via WebSocket
 */
(function () {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}?role=viewer`);
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
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    iconExpand.style.display = isFs ? 'none' : '';
    iconCompress.style.display = isFs ? '' : 'none';
    setTimeout(() => wb.resize(), 100);
  });

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
