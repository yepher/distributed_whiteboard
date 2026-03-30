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
    this.selectedElement = null;
    this._isDragging = false;
    this._dragStartNorm = null;
    this._dragOriginal = null;
    this._lastTapTime = 0;
    this._lastTapX = 0;
    this._lastTapY = 0;

    // Callbacks
    this.onStrokeComplete = options.onStrokeComplete || null;
    this.onStrokeLive = options.onStrokeLive || null;
    this.onTextPlacement = options.onTextPlacement || null;
    this.onMoveComplete = options.onMoveComplete || null;
    this.onMoveLive = options.onMoveLive || null;

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

    // Escape to deselect
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.selectedElement) {
        this.deselectElement();
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
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pt = this._getCanvasPoint(e);
    const now = Date.now();

    // --- Double-click detection (any tool) ---
    const timeDelta = now - this._lastTapTime;
    const distDelta = Math.hypot(pt.x - this._lastTapX, pt.y - this._lastTapY);
    this._lastTapTime = now;
    this._lastTapX = pt.x;
    this._lastTapY = pt.y;

    if (timeDelta < 400 && distDelta < 15) {
      const hit = this.hitTest(pt.x, pt.y);
      if (hit) {
        this.selectElement(hit);
        this._lastTapTime = 0; // Reset to prevent triple-click
        return;
      }
    }

    // --- Select tool ---
    if (this.currentTool === 'select') {
      const hit = this.hitTest(pt.x, pt.y);
      if (hit) {
        this.selectElement(hit);
        // Start drag
        this._isDragging = true;
        this._dragStartNorm = this._normalizePoint(pt.x, pt.y);
        // Deep-copy original positions
        if (hit.tool === 'text') {
          this._dragOriginal = { x: hit.x, y: hit.y };
        } else {
          this._dragOriginal = { points: hit.points.map((p) => ({ ...p })) };
        }
        this.canvas.style.cursor = 'grabbing';
      } else {
        this.deselectElement();
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
    this.deselectElement();
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
    // --- Drag move ---
    if (this._isDragging && this.selectedElement) {
      const pt = this._getCanvasPoint(e);
      const current = this._normalizePoint(pt.x, pt.y);
      const dx = current.x - this._dragStartNorm.x;
      const dy = current.y - this._dragStartNorm.y;

      if (this.selectedElement.tool === 'text') {
        this.selectedElement.x = this._dragOriginal.x + dx;
        this.selectedElement.y = this._dragOriginal.y + dy;
      } else if (this.selectedElement.points) {
        for (let i = 0; i < this.selectedElement.points.length; i++) {
          this.selectedElement.points[i] = {
            ...this._dragOriginal.points[i],
            x: this._dragOriginal.points[i].x + dx,
            y: this._dragOriginal.points[i].y + dy,
          };
        }
      }

      this.redraw();

      if (this.onMoveLive) {
        this.onMoveLive({
          boardId: this.currentBoardId,
          elementId: this.selectedElement.id,
          element: this._cloneElement(this.selectedElement),
        });
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
    if (this._isDragging && this.selectedElement) {
      this._isDragging = false;
      this.canvas.style.cursor = this.currentTool === 'select' ? 'default' : 'crosshair';

      if (this.onMoveComplete) {
        this.onMoveComplete({
          boardId: this.currentBoardId,
          elementId: this.selectedElement.id,
          element: this._cloneElement(this.selectedElement),
        });
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
  selectElement(element) {
    this.selectedElement = element;
    this.redraw();
  }

  deselectElement() {
    if (!this.selectedElement) return;
    this.selectedElement = null;
    this._isDragging = false;
    this.redraw();
  }

  _renderSelectionIndicator() {
    if (!this.selectedElement) return;

    const bounds = this._getElementBounds(this.selectedElement);
    const ctx = this.ctx;
    const pad = 8;
    const x = bounds.x - pad;
    const y = bounds.y - pad;
    const w = bounds.width + pad * 2;
    const h = bounds.height + pad * 2;

    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // Corner handles
    const handleSize = 6;
    ctx.fillStyle = '#3b82f6';
    const corners = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ];
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
    }

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
    this.selectedElement = null;
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

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
  }
}
