const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');

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

// Board state (in-memory)
const state = {
  boards: [{ id: 0, strokes: [], undone: [] }],
  currentBoardId: 0,
  theme: 'dark',
};

// Track connected clients
const clients = { presenters: new Set(), viewers: new Set() };

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const viewer of clients.viewers) {
    if (viewer !== exclude && viewer.readyState === 1) {
      viewer.send(msg);
    }
  }
}

function getBoard(id) {
  return state.boards.find((b) => b.id === id);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'viewer';

  if (role === 'presenter') {
    clients.presenters.add(ws);
  } else {
    clients.viewers.add(ws);
    // Send full state to new viewer
    ws.send(
      JSON.stringify({
        type: 'fullState',
        boards: state.boards.map((b) => ({
          id: b.id,
          strokes: b.strokes,
        })),
        currentBoardId: state.currentBoardId,
        theme: state.theme,
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

    switch (msg.type) {
      case 'draw': {
        const board = getBoard(msg.boardId);
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
          broadcast(msg);
        }
        break;
      }

      case 'drawLive': {
        broadcast(msg);
        break;
      }

      case 'moveElement': {
        const board = getBoard(msg.boardId);
        if (board && msg.elementId && msg.element) {
          const idx = board.strokes.findIndex((s) => s.id === msg.elementId);
          if (idx !== -1) {
            board.strokes[idx] = msg.element;
            board.undone = [];
            broadcast(msg);
          }
        }
        break;
      }

      case 'moveLive': {
        broadcast(msg);
        break;
      }

      case 'undo': {
        const board = getBoard(msg.boardId);
        if (board && board.strokes.length > 0) {
          board.undone.push(board.strokes.pop());
          broadcast({
            type: 'undo',
            boardId: msg.boardId,
          });
        }
        break;
      }

      case 'redo': {
        const board = getBoard(msg.boardId);
        if (board && board.undone.length > 0) {
          board.strokes.push(board.undone.pop());
          broadcast({
            type: 'redo',
            boardId: msg.boardId,
            stroke: board.strokes[board.strokes.length - 1],
          });
        }
        break;
      }

      case 'clear': {
        const board = getBoard(msg.boardId);
        if (board) {
          board.strokes = [];
          board.undone = [];
          broadcast({ type: 'clear', boardId: msg.boardId });
        }
        break;
      }

      case 'switchBoard': {
        state.currentBoardId = msg.boardId;
        broadcast({ type: 'switchBoard', boardId: msg.boardId });
        break;
      }

      case 'addBoard': {
        const newId =
          state.boards.length > 0
            ? Math.max(...state.boards.map((b) => b.id)) + 1
            : 0;
        state.boards.push({ id: newId, strokes: [], undone: [] });
        state.currentBoardId = newId;
        broadcast({
          type: 'addBoard',
          boardId: newId,
          totalBoards: state.boards.length,
        });
        // Also tell presenter the new board id
        ws.send(
          JSON.stringify({
            type: 'boardCreated',
            boardId: newId,
            totalBoards: state.boards.length,
          })
        );
        break;
      }

      case 'deleteBoard': {
        if (state.boards.length <= 1) break;
        const idx = state.boards.findIndex((b) => b.id === msg.boardId);
        if (idx === -1) break;
        state.boards.splice(idx, 1);
        if (state.currentBoardId === msg.boardId) {
          state.currentBoardId = state.boards[Math.min(idx, state.boards.length - 1)].id;
        }
        broadcast({
          type: 'deleteBoard',
          boardId: msg.boardId,
          currentBoardId: state.currentBoardId,
        });
        break;
      }

      case 'themeChange': {
        state.theme = msg.theme;
        broadcast({ type: 'themeChange', theme: msg.theme });
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.presenters.delete(ws);
    clients.viewers.delete(ws);
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
