const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/presenter', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});

app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// --- Session (channel) state ---
// Each session is independent: its own boards, theme, and connected clients
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      boards: [{ id: 0, strokes: [], undone: [] }],
      currentBoardId: 0,
      theme: 'dark',
      clients: { presenters: new Set(), viewers: new Set() },
    });
  }
  return sessions.get(sessionId);
}

function broadcast(sessionId, data, exclude = null) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const msg = JSON.stringify(data);
  for (const viewer of session.clients.viewers) {
    if (viewer !== exclude && viewer.readyState === 1) {
      viewer.send(msg);
    }
  }
}

function getBoard(session, id) {
  return session.boards.find((b) => b.id === id);
}

// Clean up empty sessions after 30 minutes
function scheduleCleanup(sessionId) {
  setTimeout(() => {
    const session = sessions.get(sessionId);
    if (session && session.clients.presenters.size === 0 && session.clients.viewers.size === 0) {
      sessions.delete(sessionId);
    }
  }, 30 * 60 * 1000);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'viewer';
  const sessionId = url.searchParams.get('session');

  if (!sessionId) {
    ws.close(4000, 'session parameter required');
    return;
  }

  const session = getSession(sessionId);
  ws._sessionId = sessionId;

  if (role === 'presenter') {
    session.clients.presenters.add(ws);
  } else {
    session.clients.viewers.add(ws);
    // Send full state to new viewer
    ws.send(
      JSON.stringify({
        type: 'fullState',
        boards: session.boards.map((b) => ({
          id: b.id,
          strokes: b.strokes,
        })),
        currentBoardId: session.currentBoardId,
        theme: session.theme,
      })
    );
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const sess = sessions.get(ws._sessionId);
    if (!sess) return;

    switch (msg.type) {
      case 'draw': {
        const board = getBoard(sess, msg.boardId);
        if (board) {
          let element;
          if (msg.tool === 'text') {
            element = {
              id: msg.id || Date.now().toString(36),
              tool: 'text',
              x: msg.x,
              y: msg.y,
              text: msg.text,
              color: msg.color,
              fontSize: msg.fontSize,
              opacity: msg.opacity || 1,
            };
          } else {
            element = {
              id: msg.id || Date.now().toString(36),
              points: msg.points,
              color: msg.color,
              width: msg.width,
              tool: msg.tool,
              opacity: msg.opacity,
            };
          }
          board.strokes.push(element);
          board.undone = [];
          broadcast(ws._sessionId, msg);
        }
        break;
      }

      case 'drawLive': {
        broadcast(ws._sessionId, msg);
        break;
      }

      case 'moveElement': {
        const board = getBoard(sess, msg.boardId);
        if (board && msg.elementId && msg.element) {
          const idx = board.strokes.findIndex((s) => s.id === msg.elementId);
          if (idx !== -1) {
            board.strokes[idx] = msg.element;
            board.undone = [];
            broadcast(ws._sessionId, msg);
          }
        }
        break;
      }

      case 'moveLive': {
        broadcast(ws._sessionId, msg);
        break;
      }

      case 'deleteElement': {
        const board = getBoard(sess, msg.boardId);
        if (board && msg.elementId) {
          const idx = board.strokes.findIndex((s) => s.id === msg.elementId);
          if (idx !== -1) {
            board.strokes.splice(idx, 1);
            board.undone = [];
            broadcast(ws._sessionId, msg);
          }
        }
        break;
      }

      case 'undo': {
        const board = getBoard(sess, msg.boardId);
        if (board && board.strokes.length > 0) {
          board.undone.push(board.strokes.pop());
          broadcast(ws._sessionId, {
            type: 'undo',
            boardId: msg.boardId,
          });
        }
        break;
      }

      case 'redo': {
        const board = getBoard(sess, msg.boardId);
        if (board && board.undone.length > 0) {
          board.strokes.push(board.undone.pop());
          broadcast(ws._sessionId, {
            type: 'redo',
            boardId: msg.boardId,
            stroke: board.strokes[board.strokes.length - 1],
          });
        }
        break;
      }

      case 'clear': {
        const board = getBoard(sess, msg.boardId);
        if (board) {
          board.strokes = [];
          board.undone = [];
          broadcast(ws._sessionId, { type: 'clear', boardId: msg.boardId });
        }
        break;
      }

      case 'switchBoard': {
        sess.currentBoardId = msg.boardId;
        broadcast(ws._sessionId, { type: 'switchBoard', boardId: msg.boardId });
        break;
      }

      case 'addBoard': {
        const newId =
          sess.boards.length > 0
            ? Math.max(...sess.boards.map((b) => b.id)) + 1
            : 0;
        sess.boards.push({ id: newId, strokes: [], undone: [] });
        sess.currentBoardId = newId;
        broadcast(ws._sessionId, {
          type: 'addBoard',
          boardId: newId,
          totalBoards: sess.boards.length,
        });
        ws.send(
          JSON.stringify({
            type: 'boardCreated',
            boardId: newId,
            totalBoards: sess.boards.length,
          })
        );
        break;
      }

      case 'deleteBoard': {
        if (sess.boards.length <= 1) break;
        const idx = sess.boards.findIndex((b) => b.id === msg.boardId);
        if (idx === -1) break;
        sess.boards.splice(idx, 1);
        if (sess.currentBoardId === msg.boardId) {
          sess.currentBoardId = sess.boards[Math.min(idx, sess.boards.length - 1)].id;
        }
        broadcast(ws._sessionId, {
          type: 'deleteBoard',
          boardId: msg.boardId,
          currentBoardId: sess.currentBoardId,
        });
        break;
      }

      case 'themeChange': {
        sess.theme = msg.theme;
        broadcast(ws._sessionId, { type: 'themeChange', theme: msg.theme });
        break;
      }

      case 'replayStart': {
        // Clear viewer state for replay — broadcast clear for the board
        broadcast(ws._sessionId, { type: 'clear', boardId: msg.boardId });
        break;
      }

      case 'resync': {
        // Send full state to all viewers in this session
        const fullState = JSON.stringify({
          type: 'fullState',
          boards: sess.boards.map((b) => ({ id: b.id, strokes: b.strokes })),
          currentBoardId: sess.currentBoardId,
          theme: sess.theme,
        });
        for (const viewer of sess.clients.viewers) {
          if (viewer.readyState === 1) {
            viewer.send(fullState);
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const sess = sessions.get(ws._sessionId);
    if (sess) {
      sess.clients.presenters.delete(ws);
      sess.clients.viewers.delete(ws);
      if (sess.clients.presenters.size === 0 && sess.clients.viewers.size === 0) {
        scheduleCleanup(ws._sessionId);
      }
    }
  });
});

// Get local network IP for iPad access
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  const ip = getLocalIP();
  const hostname = os.hostname().replace(/\.local$/, '') + '.local';
  console.log(`\n  Distributed Whiteboard Server`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Presenter: http://${hostname}:${PORT}/presenter`);
  console.log(`  Viewer:    http://${hostname}:${PORT}/viewer`);
  console.log(`  IP:        http://${ip}:${PORT}`);
  console.log(`  Local:     http://localhost:${PORT}\n`);
});
