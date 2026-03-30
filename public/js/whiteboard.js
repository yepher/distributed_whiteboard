/**
 * Whiteboard — shared canvas drawing engine
 * Used by both presenter (interactive) and viewer (render-only)
 */
class Whiteboard {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.boards = new Map(); // boardId → { strokes: [], undone: [] }
    this.currentBoardId = 0;
    this.theme = options.theme || 'dark';
    this.interactive = options.interactive || false;

    // Drawing state (only used when interactive)
    this.isDrawing = false;
    this.currentStroke = null;
    this.currentTool = 'pen';
    this.currentColor = '#00ff00';
    this.currentWidth = 3;

    // Callbacks
    this.onStrokeComplete = options.onStrokeComplete || null;
    this.onStrokeLive = options.onStrokeLive || null;

    // Live stroke from remote (for viewer)
    this.liveStroke = null;

    // Initialize first board
    this.boards.set(0, { strokes: [], undone: [] });

    // Setup canvas sizing
    this.resize();
    this._resizeHandler = () => this.resize();
    window.addEventListener('resize', this._resizeHandler);

    // Setup interaction if presenter
    if (this.interactive) {
      this._setupPointerEvents();
    }
  }

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;

    // Store the logical size
    this.logicalWidth = parent.clientWidth;
    this.logicalHeight = parent.clientHeight;

    // Set canvas buffer size
    this.canvas.width = this.logicalWidth * dpr;
    this.canvas.height = this.logicalHeight * dpr;

    // Set CSS size
    this.canvas.style.width = this.logicalWidth + 'px';
    this.canvas.style.height = this.logicalHeight + 'px';

    // Scale context for retina
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.redraw();
  }

  // --- Coordinate normalization ---
  // Store points as ratios (0-1) so they render correctly at any resolution
  _normalizePoint(x, y, pressure) {
    return {
      x: x / this.logicalWidth,
      y: y / this.logicalHeight,
      pressure: pressure || 0.5,
    };
  }

  _denormalizePoint(pt) {
    return {
      x: pt.x * this.logicalWidth,
      y: pt.y * this.logicalHeight,
      pressure: pt.pressure || 0.5,
    };
  }

  // --- Pointer events (presenter only) ---
  _setupPointerEvents() {
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    // Prevent default touch behavior (scrolling, zooming)
    this.canvas.style.touchAction = 'none';
  }

  _getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
    };
  }

  _onPointerDown(e) {
    // Only respond to pen/touch/primary mouse
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    this.isDrawing = true;
    const pt = this._getCanvasPoint(e);
    const normalized = this._normalizePoint(pt.x, pt.y, pt.pressure);

    const toolConfig = this._getToolConfig();
    this.currentStroke = {
      points: [normalized],
      color: toolConfig.color,
      width: toolConfig.width,
      tool: this.currentTool,
      opacity: toolConfig.opacity,
    };

    // Draw initial dot
    this._renderStroke(this.currentStroke);
  }

  _onPointerMove(e) {
    if (!this.isDrawing || !this.currentStroke) return;

    const pt = this._getCanvasPoint(e);
    const normalized = this._normalizePoint(pt.x, pt.y, pt.pressure);
    this.currentStroke.points.push(normalized);

    // Redraw everything + current stroke
    this.redraw();
    this._renderStroke(this.currentStroke);

    // Send live update
    if (this.onStrokeLive) {
      this.onStrokeLive({
        boardId: this.currentBoardId,
        points: this.currentStroke.points,
        color: this.currentStroke.color,
        width: this.currentStroke.width,
        tool: this.currentStroke.tool,
        opacity: this.currentStroke.opacity,
      });
    }
  }

  _onPointerUp(e) {
    if (!this.isDrawing || !this.currentStroke) return;

    this.isDrawing = false;

    // Only save strokes with more than 1 point (or single point as a dot)
    const board = this.boards.get(this.currentBoardId);
    if (board) {
      board.strokes.push(this.currentStroke);
      board.undone = [];
    }

    // Notify
    if (this.onStrokeComplete) {
      this.onStrokeComplete({
        boardId: this.currentBoardId,
        points: this.currentStroke.points,
        color: this.currentStroke.color,
        width: this.currentStroke.width,
        tool: this.currentStroke.tool,
        opacity: this.currentStroke.opacity,
      });
    }

    this.currentStroke = null;
    this.redraw();
  }

  _getToolConfig() {
    const baseWidth = this.currentWidth;
    switch (this.currentTool) {
      case 'pen':
        return {
          color: this.currentColor,
          width: baseWidth,
          opacity: 1,
        };
      case 'marker':
        return {
          color: this.currentColor,
          width: baseWidth * 3,
          opacity: 1,
        };
      case 'highlighter':
        return {
          color: this.currentColor,
          width: baseWidth * 5,
          opacity: 0.3,
        };
      case 'eraser':
        return {
          color: this.theme === 'dark' ? '#000000' : '#ffffff',
          width: baseWidth * 4,
          opacity: 1,
        };
      default:
        return {
          color: this.currentColor,
          width: baseWidth,
          opacity: 1,
        };
    }
  }

  // --- Rendering ---
  _renderStroke(stroke) {
    const ctx = this.ctx;
    const points = stroke.points.map((p) => this._denormalizePoint(p));

    if (points.length === 0) return;

    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      // Single point — draw a dot
      const p = points[0];
      const radius = (stroke.width * (p.pressure || 0.5)) / 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(radius, 1), 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Multi-point — draw smooth line with pressure
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const pressure = curr.pressure || 0.5;

        ctx.lineWidth = stroke.width * pressure;

        // Use quadratic curve for smoothness
        if (i < points.length - 1) {
          const next = points[i + 1];
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
        } else {
          ctx.lineTo(curr.x, curr.y);
        }
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  redraw() {
    const ctx = this.ctx;
    // Clear with theme color
    ctx.fillStyle = this.theme === 'dark' ? '#000000' : '#ffffff';
    ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);

    // Draw all strokes for current board
    const board = this.boards.get(this.currentBoardId);
    if (board) {
      for (const stroke of board.strokes) {
        this._renderStroke(stroke);
      }
    }

    // Draw live stroke from remote (viewer)
    if (this.liveStroke) {
      this._renderStroke(this.liveStroke);
    }
  }

  // --- Board management ---
  switchBoard(boardId) {
    if (!this.boards.has(boardId)) {
      this.boards.set(boardId, { strokes: [], undone: [] });
    }
    this.currentBoardId = boardId;
    this.liveStroke = null;
    this.redraw();
  }

  addBoard(boardId) {
    this.boards.set(boardId, { strokes: [], undone: [] });
  }

  deleteBoard(boardId) {
    this.boards.delete(boardId);
  }

  // --- Undo/Redo ---
  undo() {
    const board = this.boards.get(this.currentBoardId);
    if (board && board.strokes.length > 0) {
      board.undone.push(board.strokes.pop());
      this.redraw();
      return true;
    }
    return false;
  }

  redo() {
    const board = this.boards.get(this.currentBoardId);
    if (board && board.undone.length > 0) {
      board.strokes.push(board.undone.pop());
      this.redraw();
      return true;
    }
    return false;
  }

  clearBoard() {
    const board = this.boards.get(this.currentBoardId);
    if (board) {
      board.strokes = [];
      board.undone = [];
      this.redraw();
    }
  }

  // --- Remote stroke handling (viewer) ---
  addRemoteStroke(stroke) {
    const board = this.boards.get(stroke.boardId || this.currentBoardId);
    if (!board) return;
    board.strokes.push({
      points: stroke.points,
      color: stroke.color,
      width: stroke.width,
      tool: stroke.tool,
      opacity: stroke.opacity,
    });
    board.undone = [];
    this.liveStroke = null;
    if ((stroke.boardId || this.currentBoardId) === this.currentBoardId) {
      this.redraw();
    }
  }

  setLiveStroke(stroke) {
    if ((stroke.boardId || this.currentBoardId) === this.currentBoardId) {
      this.liveStroke = {
        points: stroke.points,
        color: stroke.color,
        width: stroke.width,
        tool: stroke.tool,
        opacity: stroke.opacity,
      };
      this.redraw();
    }
  }

  remoteUndo(boardId) {
    const board = this.boards.get(boardId);
    if (board && board.strokes.length > 0) {
      board.undone.push(board.strokes.pop());
      if (boardId === this.currentBoardId) this.redraw();
    }
  }

  remoteRedo(boardId, stroke) {
    const board = this.boards.get(boardId);
    if (board && stroke) {
      board.strokes.push(stroke);
      if (boardId === this.currentBoardId) this.redraw();
    }
  }

  // --- State loading (for new viewers) ---
  loadFullState(data) {
    this.boards.clear();
    for (const b of data.boards) {
      this.boards.set(b.id, { strokes: b.strokes || [], undone: [] });
    }
    this.currentBoardId = data.currentBoardId;
    this.theme = data.theme || 'dark';
    this.redraw();
  }

  setTheme(theme) {
    this.theme = theme;
    this.redraw();
  }

  // --- Thumbnail generation ---
  generateThumbnail(boardId, width = 120, height = 80) {
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = width;
    tmpCanvas.height = height;
    const tmpCtx = tmpCanvas.getContext('2d');

    // Background
    tmpCtx.fillStyle = this.theme === 'dark' ? '#000000' : '#ffffff';
    tmpCtx.fillRect(0, 0, width, height);

    // Draw strokes scaled to thumbnail
    const board = this.boards.get(boardId);
    if (!board) return tmpCanvas.toDataURL();

    const scaleX = width / this.logicalWidth;
    const scaleY = height / this.logicalHeight;

    tmpCtx.save();
    for (const stroke of board.strokes) {
      const points = stroke.points.map((p) => ({
        x: p.x * width,
        y: p.y * height,
        pressure: p.pressure || 0.5,
      }));

      if (points.length === 0) continue;

      tmpCtx.globalAlpha = stroke.opacity;
      tmpCtx.strokeStyle = stroke.color;
      tmpCtx.fillStyle = stroke.color;
      tmpCtx.lineCap = 'round';
      tmpCtx.lineJoin = 'round';

      if (points.length === 1) {
        tmpCtx.beginPath();
        tmpCtx.arc(points[0].x, points[0].y, 1, 0, Math.PI * 2);
        tmpCtx.fill();
      } else {
        tmpCtx.lineWidth = Math.max(stroke.width * scaleX * 0.5, 0.5);
        tmpCtx.beginPath();
        tmpCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          tmpCtx.lineTo(points[i].x, points[i].y);
        }
        tmpCtx.stroke();
      }
    }
    tmpCtx.restore();

    return tmpCanvas.toDataURL();
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
  }
}
