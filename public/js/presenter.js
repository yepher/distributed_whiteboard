/**
 * Presenter — handles tools, board management, and WebSocket communication
 */
(function () {
  // --- Session ID ---
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const params = new URLSearchParams(location.search);
  let sessionId = params.get('session');
  if (!sessionId) {
    sessionId = generateUUID();
    params.set('session', sessionId);
    history.replaceState(null, '', '?' + params.toString());
  }

  // --- WebSocket setup ---
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}?role=presenter&session=${sessionId}`);
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
  const canvasArea = document.getElementById('canvas-area');
  let activeTextInput = null;

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
    onTextPlacement: (x, y) => {
      placeTextInput(x, y);
    },
    onMoveComplete: (moveData) => {
      send({ type: 'moveElement', ...moveData });
      updateCurrentThumbnail();
    },
    onMoveLive: (moveData) => {
      const now = Date.now();
      if (now - lastLiveSend > LIVE_INTERVAL) {
        send({ type: 'moveLive', ...moveData });
        lastLiveSend = now;
      }
    },
    onDeleteElement: (data) => {
      send({ type: 'deleteElement', ...data });
      updateCurrentThumbnail();
    },
    onReplayStart: (data) => {
      send({ type: 'replayStart', ...data });
    },
    onReplayStroke: (stroke) => {
      send({ type: 'draw', ...stroke });
    },
    onReplayLive: (stroke) => {
      const now = Date.now();
      if (now - lastLiveSend > LIVE_INTERVAL) {
        send({ type: 'drawLive', ...stroke });
        lastLiveSend = now;
      }
    },
    onReplayDone: () => {
      send({ type: 'resync' });
      showPlaybackBar(false);
      updateCurrentThumbnail();
    },
  });

  // --- Text input handling ---
  function placeTextInput(x, y) {
    // Commit any existing text input first
    commitTextInput();

    const input = document.createElement('textarea');
    input.className = 'canvas-text-input';
    input.style.left = x + 'px';
    input.style.top = y + 'px';
    input.style.color = wb.currentColor;
    input.style.fontSize = wb.currentFontSize + 'px';
    input.rows = 1;

    canvasArea.appendChild(input);
    activeTextInput = { element: input, x, y };

    // Small delay so the tap doesn't immediately blur
    setTimeout(() => {
      input.focus();
    }, 50);

    // Auto-grow textarea as user types
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    });

    // Commit on Enter (without Shift) or blur
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitTextInput();
      }
      if (e.key === 'Escape') {
        cancelTextInput();
      }
      // Stop keyboard shortcuts from firing while typing
      e.stopPropagation();
    });

    input.addEventListener('blur', () => {
      // Delay to check if focus moved to a toolbar button (color, tool, etc.)
      // If so, don't commit — the user is adjusting settings
      setTimeout(() => {
        if (!activeTextInput) return;
        // If focus moved to a color button or toolbar element, refocus the input
        const focused = document.activeElement;
        const inToolbar = focused && (focused.closest('#toolbar') || focused.closest('#colors-group'));
        if (inToolbar) {
          activeTextInput.element.focus();
          return;
        }
        commitTextInput();
      }, 150);
    });
  }

  function commitTextInput() {
    if (!activeTextInput) return;
    const { element, x, y } = activeTextInput;
    const text = element.value.trim();
    activeTextInput = null;

    if (element.parentNode) {
      element.remove();
    }

    if (!text) return;

    // Normalize position to 0-1 range
    const rect = canvas.getBoundingClientRect();
    const nx = x / rect.width;
    const ny = y / rect.height;

    const textElement = {
      id: wb._generateId(),
      tool: 'text',
      x: nx,
      y: ny,
      text: text,
      color: wb.currentColor,
      fontSize: wb.currentFontSize,
      opacity: 1,
    };

    wb.addText(textElement);
    send({ type: 'draw', boardId: currentBoardId, ...textElement });
    updateCurrentThumbnail();
  }

  function cancelTextInput() {
    if (!activeTextInput) return;
    if (activeTextInput.element.parentNode) {
      activeTextInput.element.remove();
    }
    activeTextInput = null;
  }

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
      wb.deselectElement();
      canvas.classList.toggle('tool-select', btn.dataset.tool === 'select');
    });
  });

  // --- Color picker ---
  const colorCurrentBtn = document.getElementById('color-current');
  const colorPalette = document.getElementById('color-palette');
  const colorButtons = document.querySelectorAll('.color-btn');

  colorCurrentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colorPalette.classList.toggle('show');
  });

  // Close palette when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.color-picker')) {
      colorPalette.classList.remove('show');
    }
  });

  colorButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      colorButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      wb.currentColor = btn.dataset.color;
      colorCurrentBtn.style.background = btn.dataset.color;
      colorPalette.classList.remove('show');
      // Update active text input color
      if (activeTextInput) {
        activeTextInput.element.style.color = btn.dataset.color;
        activeTextInput.element.focus();
      }
      // Recolor selected element
      if (wb.selectedElements.size > 0) {
        wb.recolorSelected(btn.dataset.color);
        updateCurrentThumbnail();
      }
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
    // Resize canvas after fullscreen transition
    setTimeout(() => wb.resize(), 100);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // Prevent iPad gestures from escaping fullscreen
  // Block pinch-to-zoom (gesturestart/gesturechange are Safari-specific)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
  document.addEventListener('gestureend', (e) => e.preventDefault());

  // --- Replay / Playback controls ---
  const toolbarEl = document.getElementById('toolbar');
  const playbackBarEl = document.getElementById('playback-bar');
  const pbPauseBtn = document.getElementById('pb-pause');
  const pbIconPause = pbPauseBtn.querySelector('.icon-pause');
  const pbIconPlay = pbPauseBtn.querySelector('.icon-play');

  function showPlaybackBar(show) {
    toolbarEl.classList.toggle('hidden', show);
    playbackBarEl.classList.toggle('hidden', !show);
    if (!show) {
      pbIconPause.style.display = '';
      pbIconPlay.style.display = 'none';
    }
  }

  function updatePauseButton() {
    const paused = wb.isReplayPaused;
    pbIconPause.style.display = paused ? 'none' : '';
    pbIconPlay.style.display = paused ? '' : 'none';
  }

  document.getElementById('btn-replay').addEventListener('click', () => {
    if (wb.startReplay()) {
      showPlaybackBar(true);
    }
  });

  pbPauseBtn.addEventListener('click', () => {
    wb.toggleReplayPause();
    updatePauseButton();
  });

  document.getElementById('pb-step-fwd').addEventListener('click', () => {
    wb.stepForward();
  });

  document.getElementById('pb-step-back').addEventListener('click', () => {
    wb.stepBack();
  });

  document.getElementById('pb-start').addEventListener('click', () => {
    wb.jumpToStart();
    updatePauseButton();
  });

  document.getElementById('pb-end').addEventListener('click', () => {
    wb.jumpToEnd();
    updatePauseButton();
  });

  document.getElementById('pb-cancel').addEventListener('click', () => {
    wb.stopReplay();
    showPlaybackBar(false);
  });

  document.querySelectorAll('.pb-speed-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pb-speed-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      wb.setReplaySpeed(parseFloat(btn.dataset.speed));
    });
  });

  // --- Download menu ---
  const btnDownload = document.getElementById('btn-download');
  const downloadMenu = document.getElementById('download-menu');

  btnDownload.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadMenu.classList.toggle('show');
  });

  document.addEventListener('click', () => {
    downloadMenu.classList.remove('show');
  });

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

  // --- Sync button ---
  document.getElementById('btn-sync').addEventListener('click', () => {
    send({ type: 'resync' });
    const toastEl = document.getElementById('share-toast');
    toastEl.textContent = 'Viewers synced';
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2000);
  });

  // --- Share button ---
  const btnShare = document.getElementById('btn-share');
  const toastEl = document.getElementById('share-toast');

  function getViewerURL() {
    return `${location.protocol}//${location.host}/viewer?session=${sessionId}`;
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  function copyToClipboard(text) {
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    // Fallback: temporary textarea + execCommand
    return new Promise((resolve) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        resolve(document.execCommand('copy'));
      } catch {
        resolve(false);
      }
      document.body.removeChild(ta);
    });
  }

  btnShare.addEventListener('click', async () => {
    const url = getViewerURL();

    // Use native share sheet on iPad/mobile if available
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Whiteboard Viewer', url });
        return;
      } catch {
        // User cancelled or share failed — fall through to copy
      }
    }

    const copied = await copyToClipboard(url);
    if (copied) {
      showToast('Viewer link copied!');
    } else {
      // Last resort
      prompt('Share this viewer link:', url);
    }
  });

  // Show session ID in the session indicator
  const sessionIndicator = document.getElementById('session-id');
  if (sessionIndicator) {
    sessionIndicator.textContent = sessionId.slice(0, 8);
    sessionIndicator.title = sessionId;
  }

  // Initial render
  renderBoardList();
})();
