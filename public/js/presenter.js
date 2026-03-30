/**
 * Presenter — handles tools, board management, and WebSocket communication
 */
(function () {
  // --- WebSocket setup ---
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}?role=presenter`);
  const statusEl = document.getElementById('connection-status');

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    setTimeout(() => statusEl.classList.add('fade'), 2000);
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.className = 'disconnected';
  };

  ws.onerror = () => {
    statusEl.textContent = 'Connection error';
    statusEl.className = 'disconnected';
  };

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // Throttle live stroke updates to ~30fps
  let lastLiveSend = 0;
  const LIVE_INTERVAL = 33;

  // --- Whiteboard setup ---
  const canvas = document.getElementById('whiteboard');
  const wb = new Whiteboard(canvas, {
    interactive: true,
    theme: 'dark',
    onStrokeComplete: (stroke) => {
      send({ type: 'draw', ...stroke });
      updateCurrentThumbnail();
    },
    onStrokeLive: (stroke) => {
      const now = Date.now();
      if (now - lastLiveSend > LIVE_INTERVAL) {
        send({ type: 'drawLive', ...stroke });
        lastLiveSend = now;
      }
    },
  });

  // --- Board management ---
  let boards = [{ id: 0 }];
  let currentBoardId = 0;
  const boardListEl = document.getElementById('board-list');

  function renderBoardList() {
    boardListEl.innerHTML = '';
    boards.forEach((board, index) => {
      const item = document.createElement('div');
      item.className = 'board-item' + (board.id === currentBoardId ? ' active' : '');
      item.dataset.boardId = board.id;

      const thumb = document.createElement('canvas');
      thumb.className = 'board-thumb';
      thumb.width = 120;
      thumb.height = 80;
      item.appendChild(thumb);

      const label = document.createElement('span');
      label.className = 'board-label';
      label.textContent = index + 1;
      item.appendChild(label);

      // Click to switch
      item.addEventListener('click', () => {
        switchToBoard(board.id);
      });

      // Long press / right-click to delete (if more than 1 board)
      if (boards.length > 1) {
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (confirm(`Delete board ${index + 1}?`)) {
            deleteBoard(board.id);
          }
        });
      }

      boardListEl.appendChild(item);
    });

    updateAllThumbnails();
  }

  function updateCurrentThumbnail() {
    const item = boardListEl.querySelector(`[data-board-id="${currentBoardId}"]`);
    if (!item) return;
    const thumbCanvas = item.querySelector('.board-thumb');
    if (!thumbCanvas) return;

    const dataUrl = wb.generateThumbnail(currentBoardId, 120, 80);
    const img = new Image();
    img.onload = () => {
      const ctx = thumbCanvas.getContext('2d');
      ctx.clearRect(0, 0, 120, 80);
      ctx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  }

  function updateAllThumbnails() {
    boards.forEach((board) => {
      const item = boardListEl.querySelector(`[data-board-id="${board.id}"]`);
      if (!item) return;
      const thumbCanvas = item.querySelector('.board-thumb');
      if (!thumbCanvas) return;

      const dataUrl = wb.generateThumbnail(board.id, 120, 80);
      const img = new Image();
      img.onload = () => {
        const ctx = thumbCanvas.getContext('2d');
        ctx.clearRect(0, 0, 120, 80);
        ctx.drawImage(img, 0, 0);
      };
      img.src = dataUrl;
    });
  }

  function switchToBoard(boardId) {
    currentBoardId = boardId;
    wb.switchBoard(boardId);
    send({ type: 'switchBoard', boardId });
    renderBoardList();
  }

  function addBoard() {
    send({ type: 'addBoard' });
  }

  function deleteBoard(boardId) {
    send({ type: 'deleteBoard', boardId });
    const idx = boards.findIndex((b) => b.id === boardId);
    if (idx !== -1) {
      boards.splice(idx, 1);
      wb.deleteBoard(boardId);
      if (currentBoardId === boardId) {
        currentBoardId = boards[Math.min(idx, boards.length - 1)].id;
        wb.switchBoard(currentBoardId);
      }
      renderBoardList();
    }
  }

  // Handle server response for new board
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'boardCreated') {
      boards.push({ id: msg.boardId });
      wb.addBoard(msg.boardId);
      switchToBoard(msg.boardId);
    }
  };

  document.getElementById('add-board').addEventListener('click', addBoard);

  // --- Tool selection ---
  const toolButtons = document.querySelectorAll('#tools-group .tool-btn');
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      toolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      wb.currentTool = btn.dataset.tool;
    });
  });

  // --- Color selection ---
  const colorButtons = document.querySelectorAll('.color-btn');
  colorButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      colorButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      wb.currentColor = btn.dataset.color;
    });
  });

  // --- Line width ---
  const lineWidthEl = document.getElementById('line-width');
  lineWidthEl.addEventListener('input', () => {
    wb.currentWidth = parseInt(lineWidthEl.value, 10);
  });

  // --- Undo / Redo ---
  document.getElementById('btn-undo').addEventListener('click', () => {
    if (wb.undo()) {
      send({ type: 'undo', boardId: currentBoardId });
      updateCurrentThumbnail();
    }
  });

  document.getElementById('btn-redo').addEventListener('click', () => {
    if (wb.redo()) {
      send({ type: 'redo', boardId: currentBoardId });
      updateCurrentThumbnail();
    }
  });

  // --- Clear ---
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Clear this board?')) {
      wb.clearBoard();
      send({ type: 'clear', boardId: currentBoardId });
      updateCurrentThumbnail();
    }
  });

  // --- Theme toggle ---
  document.getElementById('btn-theme').addEventListener('click', () => {
    const newTheme = wb.theme === 'dark' ? 'light' : 'dark';
    wb.setTheme(newTheme);
    document.body.classList.toggle('theme-dark', newTheme === 'dark');
    document.body.classList.toggle('theme-light', newTheme === 'light');
    send({ type: 'themeChange', theme: newTheme });
    updateAllThumbnails();
  });

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (wb.redo()) {
          send({ type: 'redo', boardId: currentBoardId });
          updateCurrentThumbnail();
        }
      } else {
        if (wb.undo()) {
          send({ type: 'undo', boardId: currentBoardId });
          updateCurrentThumbnail();
        }
      }
    }
  });

  // Initial render
  renderBoardList();
})();
