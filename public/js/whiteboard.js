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
    this.currentColor = '#1FD5F9';
    this.currentWidth = 3;

    // Text state
    this.currentFontSize = 24;

    // Selection & drag state
    this.selectedElements = new Set();
    this._isDragging = false;
    this._dragStartNorm = null;
    this._dragOriginals = null; // Map<element, {original position data}>

    // Callbacks
    this.onStrokeComplete = options.onStrokeComplete || null;
    this.onStrokeLive = options.onStrokeLive || null;
    this.onTextPlacement = options.onTextPlacement || null;
    this.onMoveComplete = options.onMoveComplete || null;
    this.onMoveLive = options.onMoveLive || null;
    this.onDeleteElement = options.onDeleteElement || null;
    this.onReplayStroke = options.onReplayStroke || null;
    this.onReplayLive = options.onReplayLive || null;
    this.onReplayDone = options.onReplayDone || null;
    this.onReplayStart = options.onReplayStart || null;

    // Replay state
    this._isReplaying = false;
    this._replayPaused = false;
    this._replayStrokes = null;
    this._replayStrokeIdx = 0;
    this._replayPointIdx = 0;
    this._replayCharIdx = 0;
    this._replaySpeed = 1;
    this._replayAnimId = null;
    this._replayPauseTimer = null;
    this._replayPointsPerFrame = 2;
    this._replayStepMode = false;

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

  // --- ID generation ---
  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;

    this.logicalWidth = parent.clientWidth;
    this.logicalHeight = parent.clientHeight;

    this.canvas.width = this.logicalWidth * dpr;
    this.canvas.height = this.logicalHeight * dpr;

    this.canvas.style.width = this.logicalWidth + 'px';
    this.canvas.style.height = this.logicalHeight + 'px';

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.redraw();
  }

  // --- Coordinate normalization ---
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
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._onPointerDown(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      e.preventDefault();
      this._onPointerMove(e);
    });
    this.canvas.addEventListener('pointerup', (e) => {
      e.preventDefault();
      this._onPointerUp(e);
    });
    this.canvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    // Prevent touch gestures from being intercepted by the browser
    this.canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    this.canvas.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });

    this.canvas.style.touchAction = 'none';

    // Escape to deselect, Delete/Backspace to remove selected
    document.addEventListener('keydown', (e) => {
      if (this.selectedElements.size === 0) return;
      if (e.key === 'Escape') {
        this.deselectAll();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
        e.preventDefault();
        this.deleteSelected();
      }
    });
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
    if (this._isReplaying) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pt = this._getCanvasPoint(e);

    // --- Delete button click (when something is selected) ---
    if (this.selectedElements.size > 0 && this._deleteButtonPos) {
      const db = this._deleteButtonPos;
      if (Math.hypot(pt.x - db.x, pt.y - db.y) <= db.r + 4) {
        this.deleteSelected();
        return;
      }
    }

    // --- Select tool ---
    if (this.currentTool === 'select') {
      const hit = this.hitTest(pt.x, pt.y);
      if (hit) {
        // If already selected, just start dragging all selected
        if (!this.selectedElements.has(hit)) {
          // Add to selection (additive)
          this.selectedElements.add(hit);
          this.redraw();
        }
        // Start drag for all selected elements
        this._isDragging = true;
        this._dragStartNorm = this._normalizePoint(pt.x, pt.y);
        this._dragOriginals = new Map();
        for (const el of this.selectedElements) {
          if (el.tool === 'text') {
            this._dragOriginals.set(el, { x: el.x, y: el.y });
          } else if (el.points) {
            this._dragOriginals.set(el, { points: el.points.map((p) => ({ ...p })) });
          }
        }
        this.canvas.style.cursor = 'grabbing';
      } else {
        this.deselectAll();
      }
      return;
    }

    // --- Text tool ---
    if (this.currentTool === 'text') {
      if (this.onTextPlacement) {
        this.onTextPlacement(pt.x, pt.y);
      }
      return;
    }

    // --- Drawing tools ---
    this.deselectAll();
    this.isDrawing = true;
    const normalized = this._normalizePoint(pt.x, pt.y, pt.pressure);

    const toolConfig = this._getToolConfig();
    this.currentStroke = {
      id: this._generateId(),
      points: [normalized],
      color: toolConfig.color,
      width: toolConfig.width,
      tool: this.currentTool,
      opacity: toolConfig.opacity,
    };

    this._renderStroke(this.currentStroke);
  }

  _onPointerMove(e) {
    // --- Drag move (all selected elements) ---
    if (this._isDragging && this.selectedElements.size > 0) {
      const pt = this._getCanvasPoint(e);
      const current = this._normalizePoint(pt.x, pt.y);
      const dx = current.x - this._dragStartNorm.x;
      const dy = current.y - this._dragStartNorm.y;

      for (const el of this.selectedElements) {
        const orig = this._dragOriginals.get(el);
        if (!orig) continue;
        if (el.tool === 'text') {
          el.x = orig.x + dx;
          el.y = orig.y + dy;
        } else if (el.points) {
          for (let i = 0; i < el.points.length; i++) {
            el.points[i] = {
              ...orig.points[i],
              x: orig.points[i].x + dx,
              y: orig.points[i].y + dy,
            };
          }
        }
      }

      this.redraw();

      if (this.onMoveLive) {
        const now = Date.now();
        if (!this._lastMoveLiveSend || now - this._lastMoveLiveSend > 33) {
          this._lastMoveLiveSend = now;
          for (const el of this.selectedElements) {
            this.onMoveLive({
              boardId: this.currentBoardId,
              elementId: el.id,
              element: this._cloneElement(el),
            });
          }
        }
      }
      return;
    }

    // --- Drawing ---
    if (!this.isDrawing || !this.currentStroke) return;

    const pt = this._getCanvasPoint(e);
    const normalized = this._normalizePoint(pt.x, pt.y, pt.pressure);
    this.currentStroke.points.push(normalized);

    this.redraw();
    this._renderStroke(this.currentStroke);

    if (this.onStrokeLive) {
      this.onStrokeLive({
        boardId: this.currentBoardId,
        id: this.currentStroke.id,
        points: this.currentStroke.points,
        color: this.currentStroke.color,
        width: this.currentStroke.width,
        tool: this.currentStroke.tool,
        opacity: this.currentStroke.opacity,
      });
    }
  }

  _onPointerUp(e) {
    // --- Drag end ---
    if (this._isDragging && this.selectedElements.size > 0) {
      this._isDragging = false;
      this.canvas.style.cursor = this.currentTool === 'select' ? 'default' : 'crosshair';

      if (this.onMoveComplete) {
        for (const el of this.selectedElements) {
          this.onMoveComplete({
            boardId: this.currentBoardId,
            elementId: el.id,
            element: this._cloneElement(el),
          });
        }
      }

      const board = this.boards.get(this.currentBoardId);
      if (board) board.undone = [];
      return;
    }

    // --- Drawing end ---
    if (!this.isDrawing || !this.currentStroke) return;

    this.isDrawing = false;

    const board = this.boards.get(this.currentBoardId);
    if (board) {
      board.strokes.push(this.currentStroke);
      board.undone = [];
    }

    if (this.onStrokeComplete) {
      this.onStrokeComplete({
        boardId: this.currentBoardId,
        id: this.currentStroke.id,
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

  _cloneElement(el) {
    if (el.tool === 'text') {
      return { id: el.id, tool: 'text', x: el.x, y: el.y, text: el.text, color: el.color, fontSize: el.fontSize, opacity: el.opacity };
    }
    return { id: el.id, points: el.points.map((p) => ({ ...p })), color: el.color, width: el.width, tool: el.tool, opacity: el.opacity };
  }

  _getToolConfig() {
    const baseWidth = this.currentWidth;
    switch (this.currentTool) {
      case 'pen':
        return { color: this.currentColor, width: baseWidth, opacity: 1 };
      case 'marker':
        return { color: this.currentColor, width: baseWidth * 3, opacity: 1 };
      case 'highlighter':
        return { color: this.currentColor, width: baseWidth * 5, opacity: 0.3 };
      case 'eraser':
        return { color: this.theme === 'dark' ? '#000000' : '#ffffff', width: baseWidth * 4, opacity: 1 };
      default:
        return { color: this.currentColor, width: baseWidth, opacity: 1 };
    }
  }

  // --- Hit Testing ---
  _pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  _hitTestStroke(element, cx, cy) {
    if (!element.points || element.points.length === 0) return false;
    const points = element.points.map((p) => this._denormalizePoint(p));
    const threshold = Math.max(element.width * 2, 12);

    if (points.length === 1) {
      return Math.hypot(cx - points[0].x, cy - points[0].y) <= threshold;
    }

    for (let i = 1; i < points.length; i++) {
      const dist = this._pointToSegmentDist(cx, cy, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
      if (dist <= threshold) return true;
    }
    return false;
  }

  _hitTestText(element, cx, cy) {
    const x = element.x * this.logicalWidth;
    const y = element.y * this.logicalHeight;
    const fontSize = element.fontSize || 24;
    const lines = (element.text || '').split('\n');
    const lineHeight = fontSize * 1.3;

    // Measure text width
    this.ctx.save();
    this.ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    let maxWidth = 0;
    for (const line of lines) {
      maxWidth = Math.max(maxWidth, this.ctx.measureText(line).width);
    }
    this.ctx.restore();

    const height = lines.length * lineHeight;
    const pad = 6;

    return cx >= x - pad && cx <= x + maxWidth + pad && cy >= y - pad && cy <= y + height + pad;
  }

  hitTest(cx, cy) {
    const board = this.boards.get(this.currentBoardId);
    if (!board) return null;

    // Iterate reverse (topmost first)
    for (let i = board.strokes.length - 1; i >= 0; i--) {
      const el = board.strokes[i];
      if (el.tool === 'eraser') continue;

      if (el.tool === 'text') {
        if (this._hitTestText(el, cx, cy)) return el;
      } else {
        if (this._hitTestStroke(el, cx, cy)) return el;
      }
    }
    return null;
  }

  _getElementBounds(element) {
    if (element.tool === 'text') {
      const x = element.x * this.logicalWidth;
      const y = element.y * this.logicalHeight;
      const fontSize = element.fontSize || 24;
      const lines = (element.text || '').split('\n');
      const lineHeight = fontSize * 1.3;

      this.ctx.save();
      this.ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      let maxWidth = 0;
      for (const line of lines) {
        maxWidth = Math.max(maxWidth, this.ctx.measureText(line).width);
      }
      this.ctx.restore();

      return { x, y, width: maxWidth, height: lines.length * lineHeight };
    }

    // Stroke bounds
    if (!element.points || element.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const points = element.points.map((p) => this._denormalizePoint(p));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const pad = (element.width || 2) / 2;
    return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
  }

  // --- Selection ---
  deselectAll() {
    if (this.selectedElements.size === 0) return;
    this.selectedElements.clear();
    this._isDragging = false;
    this.redraw();
  }

  // Legacy alias used by presenter.js tool switching
  deselectElement() { this.deselectAll(); }

  deleteSelected() {
    if (this.selectedElements.size === 0) return;
    const board = this.boards.get(this.currentBoardId);
    if (!board) return;
    for (const el of this.selectedElements) {
      const idx = board.strokes.findIndex((s) => s.id === el.id);
      if (idx !== -1) {
        board.strokes.splice(idx, 1);
        if (this.onDeleteElement) {
          this.onDeleteElement({ boardId: this.currentBoardId, elementId: el.id });
        }
      }
    }
    board.undone = [];
    this.selectedElements.clear();
    this._isDragging = false;
    this.redraw();
  }

  recolorSelected(newColor) {
    if (this.selectedElements.size === 0) return;
    for (const el of this.selectedElements) {
      el.color = newColor;
      if (this.onMoveComplete) {
        this.onMoveComplete({
          boardId: this.currentBoardId,
          elementId: el.id,
          element: this._cloneElement(el),
        });
      }
    }
    this.redraw();
  }

  _renderSelectionIndicator() {
    if (this.selectedElements.size === 0) return;

    const ctx = this.ctx;
    const pad = 8;

    // Track combined bounds for the delete button
    let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;

    ctx.save();
    for (const el of this.selectedElements) {
      const bounds = this._getElementBounds(el);
      const x = bounds.x - pad;
      const y = bounds.y - pad;
      const w = bounds.width + pad * 2;
      const h = bounds.height + pad * 2;

      allMinX = Math.min(allMinX, x);
      allMinY = Math.min(allMinY, y);
      allMaxX = Math.max(allMaxX, x + w);
      allMaxY = Math.max(allMaxY, y + h);

      // Dashed box per element
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // Corner handles
      const hs = 6;
      ctx.fillStyle = '#3b82f6';
      for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      }
    }

    // One delete button at the top-right of the combined selection
    const btnR = 10;
    const btnX = allMaxX + 4;
    const btnY = allMinY - 4;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(btnX - 4, btnY - 4);
    ctx.lineTo(btnX + 4, btnY + 4);
    ctx.moveTo(btnX + 4, btnY - 4);
    ctx.lineTo(btnX - 4, btnY + 4);
    ctx.stroke();
    this._deleteButtonPos = { x: btnX, y: btnY, r: btnR };

    ctx.restore();
  }

  // --- Rendering ---
  _renderElement(element) {
    if (element.tool === 'text') {
      return this._renderText(element);
    }
    return this._renderStroke(element);
  }

  _renderText(element) {
    const ctx = this.ctx;
    const x = element.x * this.logicalWidth;
    const y = element.y * this.logicalHeight;
    const fontSize = element.fontSize || 24;

    ctx.save();
    ctx.globalAlpha = element.opacity || 1;
    ctx.fillStyle = element.color;
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'top';

    const lines = (element.text || '').split('\n');
    const lineHeight = fontSize * 1.3;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }

    ctx.restore();
  }

  _renderStroke(stroke) {
    const ctx = this.ctx;
    if (!stroke.points || stroke.points.length === 0) return;
    const points = stroke.points.map((p) => this._denormalizePoint(p));

    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      const p = points[0];
      const radius = Math.max((stroke.width * (p.pressure || 0.5)) / 2, 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const avgPressure = ((prev.pressure || 0.5) + (curr.pressure || 0.5)) / 2;
        ctx.lineWidth = Math.max(stroke.width * avgPressure, 0.5);

        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);

        if (i < points.length - 1) {
          const next = points[i + 1];
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
        } else {
          ctx.lineTo(curr.x, curr.y);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  redraw() {
    const ctx = this.ctx;
    ctx.fillStyle = this.theme === 'dark' ? '#000000' : '#ffffff';
    ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);

    const board = this.boards.get(this.currentBoardId);
    if (board) {
      for (const element of board.strokes) {
        this._renderElement(element);
      }
    }

    if (this.liveStroke) {
      this._renderElement(this.liveStroke);
    }

    // Selection indicator (presenter only)
    this._renderSelectionIndicator();
  }

  // --- Board management ---
  switchBoard(boardId) {
    if (!this.boards.has(boardId)) {
      this.boards.set(boardId, { strokes: [], undone: [] });
    }
    this.currentBoardId = boardId;
    this.liveStroke = null;
    this.selectedElements.clear();
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
    this.deselectElement();
    const board = this.boards.get(this.currentBoardId);
    if (board && board.strokes.length > 0) {
      board.undone.push(board.strokes.pop());
      this.redraw();
      return true;
    }
    return false;
  }

  redo() {
    this.deselectElement();
    const board = this.boards.get(this.currentBoardId);
    if (board && board.undone.length > 0) {
      board.strokes.push(board.undone.pop());
      this.redraw();
      return true;
    }
    return false;
  }

  clearBoard() {
    this.deselectElement();
    const board = this.boards.get(this.currentBoardId);
    if (board) {
      board.strokes = [];
      board.undone = [];
      this.redraw();
    }
  }

  // --- Text handling ---
  addText(textElement) {
    const board = this.boards.get(this.currentBoardId);
    if (!board) return;
    board.strokes.push(textElement);
    board.undone = [];
    this.redraw();
  }

  // --- Remote stroke handling (viewer) ---
  addRemoteStroke(stroke) {
    const board = this.boards.get(stroke.boardId || this.currentBoardId);
    if (!board) return;
    if (stroke.tool === 'text') {
      board.strokes.push({
        id: stroke.id,
        tool: 'text',
        x: stroke.x,
        y: stroke.y,
        text: stroke.text,
        color: stroke.color,
        fontSize: stroke.fontSize,
        opacity: stroke.opacity || 1,
      });
    } else {
      board.strokes.push({
        id: stroke.id,
        points: stroke.points,
        color: stroke.color,
        width: stroke.width,
        tool: stroke.tool,
        opacity: stroke.opacity,
      });
    }
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

  // --- Remote move handling (viewer) ---
  applyMove(msg) {
    const board = this.boards.get(msg.boardId);
    if (!board) return;
    const idx = board.strokes.findIndex((s) => s.id === msg.elementId);
    if (idx !== -1) {
      board.strokes[idx] = msg.element;
      board.undone = [];
      if (msg.boardId === this.currentBoardId) this.redraw();
    }
  }

  applyMoveLive(msg) {
    const board = this.boards.get(msg.boardId);
    if (!board) return;
    const idx = board.strokes.findIndex((s) => s.id === msg.elementId);
    if (idx !== -1) {
      board.strokes[idx] = msg.element;
      if (msg.boardId === this.currentBoardId) this.redraw();
    }
  }

  applyDelete(msg) {
    const board = this.boards.get(msg.boardId);
    if (!board) return;
    const idx = board.strokes.findIndex((s) => s.id === msg.elementId);
    if (idx !== -1) {
      board.strokes.splice(idx, 1);
      board.undone = [];
      if (msg.boardId === this.currentBoardId) this.redraw();
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

    tmpCtx.fillStyle = this.theme === 'dark' ? '#000000' : '#ffffff';
    tmpCtx.fillRect(0, 0, width, height);

    const board = this.boards.get(boardId);
    if (!board) return tmpCanvas.toDataURL();

    const scaleX = width / this.logicalWidth;

    tmpCtx.save();
    for (const element of board.strokes) {
      if (element.tool === 'text') {
        const fontSize = Math.max((element.fontSize || 24) * scaleX, 4);
        tmpCtx.fillStyle = element.color;
        tmpCtx.font = `${fontSize}px sans-serif`;
        tmpCtx.textBaseline = 'top';
        tmpCtx.fillText(element.text || '', element.x * width, element.y * height);
        continue;
      }

      if (!element.points || element.points.length === 0) continue;
      const points = element.points.map((p) => ({
        x: p.x * width,
        y: p.y * height,
        pressure: p.pressure || 0.5,
      }));

      tmpCtx.globalAlpha = element.opacity;
      tmpCtx.strokeStyle = element.color;
      tmpCtx.fillStyle = element.color;
      tmpCtx.lineCap = 'round';
      tmpCtx.lineJoin = 'round';

      if (points.length === 1) {
        tmpCtx.beginPath();
        tmpCtx.arc(points[0].x, points[0].y, 1, 0, Math.PI * 2);
        tmpCtx.fill();
      } else {
        tmpCtx.lineWidth = Math.max(element.width * scaleX * 0.5, 0.5);
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

  // --- Export: SVG (current board) ---
  toSVG() {
    const w = this.logicalWidth;
    const h = this.logicalHeight;
    const bg = this.theme === 'dark' ? '#000000' : '#ffffff';
    const board = this.boards.get(this.currentBoardId);
    if (!board) return '';

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`;
    svg += `<rect width="${w}" height="${h}" fill="${bg}"/>\n`;

    for (const el of board.strokes) {
      if (el.tool === 'text') {
        svg += this._textToSVG(el, w, h);
      } else if (el.points && el.points.length > 0) {
        svg += this._strokeToSVG(el, w, h);
      }
    }

    svg += '</svg>';
    return svg;
  }

  _strokeToSVG(stroke, w, h) {
    const points = stroke.points.map((p) => ({ x: p.x * w, y: p.y * h }));
    if (points.length === 0) return '';

    if (points.length === 1) {
      const p = points[0];
      const r = Math.max(stroke.width / 2, 1);
      return `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${stroke.color}" opacity="${stroke.opacity}"/>\n`;
    }

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const curr = points[i];
      if (i < points.length - 1) {
        const next = points[i + 1];
        const midX = (curr.x + next.x) / 2;
        const midY = (curr.y + next.y) / 2;
        d += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`;
      } else {
        d += ` L ${curr.x} ${curr.y}`;
      }
    }

    return `<path d="${d}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${stroke.opacity}"/>\n`;
  }

  _textToSVG(element, w, h) {
    const x = element.x * w;
    const y = element.y * h;
    const fontSize = element.fontSize || 24;
    const lines = (element.text || '').split('\n');
    const lineHeight = fontSize * 1.3;

    let svg = '';
    for (let i = 0; i < lines.length; i++) {
      const escaped = lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      svg += `<text x="${x}" y="${y + i * lineHeight + fontSize}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${fontSize}" fill="${element.color}" opacity="${element.opacity || 1}">${escaped}</text>\n`;
    }
    return svg;
  }

  // --- Export: PDF (all boards, one page per board) ---
  async toPDF() {
    // Dynamically load jsPDF
    if (!window.jspdf) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/js/jspdf.umd.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    const { jsPDF } = window.jspdf;
    const ratio = this.logicalWidth / this.logicalHeight;
    const pdf = new jsPDF({ orientation: ratio > 1 ? 'landscape' : 'portrait' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    const savedBoard = this.currentBoardId;
    const sortedIds = [...this.boards.keys()].sort((a, b) => a - b);

    for (let i = 0; i < sortedIds.length; i++) {
      if (i > 0) pdf.addPage();
      const boardId = sortedIds[i];

      // Temporarily switch to this board and render to canvas
      this.selectedElements.clear();
      this.currentBoardId = boardId;
      this.redraw();

      // Convert canvas to image data
      const imgData = this.canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', 0, 0, pageW, pageH);
    }

    // Restore original board
    this.currentBoardId = savedBoard;
    this.redraw();

    // Embed board data in PDF for save/load round-trip
    try {
      await this._loadPako();
      const data = this.toJSON();
      const json = JSON.stringify(data);
      const compressed = window.pako.deflate(json);
      const b64 = btoa(String.fromCharCode.apply(null, compressed));
      pdf.setProperties({
        title: 'Whiteboard Export',
        subject: 'WB1:' + b64,
        creator: 'Distributed Whiteboard',
      });
    } catch (e) {
      console.warn('Could not embed whiteboard data in PDF:', e);
    }

    return pdf;
  }

  // --- Save/Load ---
  toJSON() {
    const boards = [];
    const sortedIds = [...this.boards.keys()].sort((a, b) => a - b);
    for (const id of sortedIds) {
      const board = this.boards.get(id);
      boards.push({
        id,
        strokes: board.strokes.map((el) => this._cloneElement(el)),
      });
    }
    return {
      v: 1,
      boards,
      currentBoardId: this.currentBoardId,
      theme: this.theme,
    };
  }

  loadFromJSON(data) {
    if (!data || !data.boards || !Array.isArray(data.boards)) {
      throw new Error('Invalid whiteboard data');
    }
    this.loadFullState(data);
  }

  downloadJSON(filename = 'whiteboard.json') {
    const json = JSON.stringify(this.toJSON(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async _loadPako() {
    if (window.pako) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/pako.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async loadFromPDF(file) {
    await this._loadPako();

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Search for the embedded data marker in the PDF binary
    // PDF properties are stored as text — look for 'WB1:' prefix
    const text = new TextDecoder('latin1').decode(bytes);
    const marker = 'WB1:';
    const idx = text.indexOf(marker);
    if (idx === -1) {
      throw new Error('No whiteboard data found in this PDF');
    }

    // Extract the Base64 data (runs until the next PDF delimiter)
    let end = idx + marker.length;
    while (end < text.length && text[end] !== ')' && text[end] !== '<' && text[end] !== '\n' && text[end] !== '\r') {
      end++;
    }
    const b64 = text.substring(idx + marker.length, end);

    // Decode and decompress
    const compressed = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const json = window.pako.inflate(compressed, { to: 'string' });
    const data = JSON.parse(json);

    if (data.v !== 1) {
      throw new Error('Unsupported whiteboard data version');
    }

    this.loadFromJSON(data);
  }

  downloadSVG(filename = 'whiteboard.svg') {
    const svg = this.toSVG();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async downloadPDF(filename = 'whiteboard.pdf') {
    const pdf = await this.toPDF();
    pdf.save(filename);
  }

  // --- Replay engine ---
  startReplay() {
    const board = this.boards.get(this.currentBoardId);
    if (!board || board.strokes.length === 0) return false;

    this._isReplaying = true;
    this._replayPaused = true;
    this._replayStrokes = board.strokes.map((el) => this._cloneElement(el));
    this._replayStrokeIdx = 0;
    this._replayPointIdx = 0;
    this._replayCharIdx = 0;
    this.selectedElements.clear();

    if (this.onReplayStart) {
      this.onReplayStart({ boardId: this.currentBoardId });
    }

    this._replayRedraw();
    // Start paused — user presses play when ready
    return true;
  }

  stopReplay() {
    if (!this._isReplaying) return;
    this._isReplaying = false;
    this._replayPaused = false;
    if (this._replayAnimId) cancelAnimationFrame(this._replayAnimId);
    if (this._replayPauseTimer) clearTimeout(this._replayPauseTimer);
    this._replayAnimId = null;
    this._replayPauseTimer = null;
    this._replayStrokes = null;
    this.redraw();
    if (this.onReplayDone) this.onReplayDone();
  }

  pauseReplay() {
    if (!this._isReplaying) return;
    this._replayPaused = true;
    if (this._replayAnimId) cancelAnimationFrame(this._replayAnimId);
    if (this._replayPauseTimer) clearTimeout(this._replayPauseTimer);
    this._replayAnimId = null;
    this._replayPauseTimer = null;
  }

  resumeReplay() {
    if (!this._isReplaying || !this._replayPaused) return;
    this._replayPaused = false;
    this._replayStepMode = false;
    this._scheduleReplayFrame();
  }

  toggleReplayPause() {
    if (this._replayPaused) this.resumeReplay();
    else this.pauseReplay();
  }

  setReplaySpeed(multiplier) {
    this._replaySpeed = multiplier;
  }

  stepForward() {
    if (!this._isReplaying) return;
    if (this._replayStrokeIdx >= this._replayStrokes.length) return;

    // Animate the current element, then auto-pause when done
    this._replayPaused = false;
    this._replayStepMode = true; // Flag: pause after this element completes
    this._scheduleReplayFrame();
  }

  stepBack() {
    if (!this._isReplaying || !this._replayPaused) return;
    if (this._replayStrokeIdx <= 0) return;

    this._replayStrokeIdx--;
    this._replayPointIdx = 0;
    this._replayCharIdx = 0;
    this._replayRedraw();
  }

  jumpToStart() {
    if (!this._isReplaying) return;
    this.pauseReplay();
    this._replayStrokeIdx = 0;
    this._replayPointIdx = 0;
    this._replayCharIdx = 0;
    this._replayRedraw();
  }

  jumpToEnd() {
    if (!this._isReplaying) return;
    this.pauseReplay();
    this._replayStrokeIdx = this._replayStrokes.length;
    this._replayPointIdx = 0;
    this._replayCharIdx = 0;
    this._replayRedraw();
  }

  _scheduleReplayFrame() {
    if (!this._isReplaying || this._replayPaused) return;
    this._replayAnimId = requestAnimationFrame(() => this._replayFrame());
  }

  _replayFrame() {
    if (!this._isReplaying || this._replayPaused) return;

    // Check if done
    if (this._replayStrokeIdx >= this._replayStrokes.length) {
      this._isReplaying = false;
      this._replayPaused = false;
      this._replayStrokes = null;
      this.redraw();
      if (this.onReplayDone) this.onReplayDone();
      return;
    }

    const el = this._replayStrokes[this._replayStrokeIdx];
    const ppf = Math.max(1, Math.round(this._replayPointsPerFrame * this._replaySpeed));

    if (el.tool === 'text') {
      // Typewriter: advance 1 char every N frames for natural typing speed
      // At 60fps, framesPerChar=8 gives ~7.5 chars/sec (natural feel)
      const framesPerChar = Math.max(1, Math.round(8 / this._replaySpeed));
      if (!this._replayTextFrameCount) this._replayTextFrameCount = 0;
      this._replayTextFrameCount++;
      if (this._replayTextFrameCount < framesPerChar) {
        this._replayRedraw();
        this._scheduleReplayFrame();
        return;
      }
      this._replayTextFrameCount = 0;
      this._replayCharIdx += 1;

      if (this._replayCharIdx >= el.text.length) {
        this._replayCharIdx = el.text.length;
        this._advanceToNextElement(el);
        return;
      }
    } else if (el.points) {
      // Stroke: advance points
      this._replayPointIdx += ppf;

      if (this._replayPointIdx >= el.points.length) {
        this._replayPointIdx = el.points.length;
        this._advanceToNextElement(el);
        return;
      }
    } else {
      // Unknown element type — skip
      this._replayStrokeIdx++;
      this._replayPointIdx = 0;
      this._replayCharIdx = 0;
    }

    // Send live update to viewers
    if (this.onReplayLive) {
      if (el.tool === 'text') {
        this.onReplayLive({
          boardId: this.currentBoardId,
          tool: 'text',
          x: el.x, y: el.y,
          text: el.text.slice(0, this._replayCharIdx),
          color: el.color, fontSize: el.fontSize, opacity: el.opacity,
        });
      } else if (el.points) {
        this.onReplayLive({
          boardId: this.currentBoardId,
          points: el.points.slice(0, this._replayPointIdx),
          color: el.color, width: el.width, tool: el.tool, opacity: el.opacity,
        });
      }
    }

    this._replayRedraw();
    this._scheduleReplayFrame();
  }

  _advanceToNextElement(completedEl) {
    // Notify completed stroke
    if (this.onReplayStroke) {
      this.onReplayStroke({
        boardId: this.currentBoardId,
        ...completedEl,
      });
    }

    this._replayStrokeIdx++;
    this._replayPointIdx = 0;
    this._replayCharIdx = 0;
    this._replayTextFrameCount = 0;

    // If step mode, pause after this element
    if (this._replayStepMode) {
      this._replayStepMode = false;
      this._replayPaused = true;
      this._replayRedraw();
      return;
    }

    // Brief pause between elements
    const pauseMs = Math.max(50, Math.round(200 / this._replaySpeed));
    this._replayPauseTimer = setTimeout(() => {
      this._replayRedraw();
      this._scheduleReplayFrame();
    }, pauseMs);
  }

  _replayRedraw() {
    const ctx = this.ctx;
    ctx.fillStyle = this.theme === 'dark' ? '#000000' : '#ffffff';
    ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);

    if (!this._replayStrokes) return;

    // Render all completed elements
    for (let i = 0; i < this._replayStrokeIdx && i < this._replayStrokes.length; i++) {
      this._renderElement(this._replayStrokes[i]);
    }

    // Render current element partially
    if (this._replayStrokeIdx < this._replayStrokes.length) {
      const el = this._replayStrokes[this._replayStrokeIdx];
      if (el.tool === 'text') {
        // Partial text (typewriter)
        this._renderText({
          ...el,
          text: el.text.slice(0, this._replayCharIdx),
        });
      } else if (el.points && this._replayPointIdx > 0) {
        // Partial stroke
        this._renderStroke({
          ...el,
          points: el.points.slice(0, this._replayPointIdx),
        });
      }
    }
  }

  get isReplaying() {
    return this._isReplaying;
  }

  get isReplayPaused() {
    return this._replayPaused;
  }

  get replayProgress() {
    if (!this._replayStrokes || this._replayStrokes.length === 0) return 0;
    return this._replayStrokeIdx / this._replayStrokes.length;
  }

  destroy() {
    this.stopReplay();
    window.removeEventListener('resize', this._resizeHandler);
  }
}
