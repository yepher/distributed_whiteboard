# Distributed Whiteboard

A real-time collaborative whiteboard for creating training videos. Draw on your iPad (presenter) and have it appear instantly on any viewer's screen — perfect for screen recording with tools like Screen Studio.

![presenter](screens/demo.gif)

## Quick Start

```bash
npm install
npm start
```

The server prints your local network URLs:

```
Presenter: http://192.168.x.x:3000/presenter
Viewer:    http://192.168.x.x:3000/viewer
```

1. Open the **presenter** URL on your iPad
2. Open the **viewer** URL on your Mac (or any browser)
3. Draw on the iPad — it appears on the viewer in real-time
4. Record the viewer window with Screen Studio

## Features

### Presenter (`/presenter`)
- **Drawing tools** — Pen, marker, highlighter, eraser
- **8 colors** — White, green, blue, red, yellow, purple, orange, pink
- **Adjustable line width** — Slider control for stroke thickness
- **Apple Pencil support** — Pressure sensitivity for natural strokes
- **Multiple boards** — Create, switch, and delete boards from the sidebar
- **Undo/redo** — Buttons or keyboard shortcuts (Cmd+Z / Cmd+Shift+Z)
- **Dark/light mode** — Toggle between black and white canvas
- **Board thumbnails** — Visual previews of each board in the sidebar

### Viewer (`/viewer`)
- **Read-only mirror** — Shows exactly what the presenter draws
- **Auto-sync** — Board switches and theme changes propagate automatically
- **Late-join support** — New viewers receive the full board state on connect
- **Board indicator** — Shows which board is currently being viewed
- **Auto-reconnect** — Reconnects if the connection drops

## Architecture

```
distributed_whiteboard/
├── server.js              # Express + WebSocket server
├── public/
│   ├── presenter.html     # Presenter UI
│   ├── viewer.html        # Viewer UI
│   ├── css/
│   │   └── styles.css     # Dark/light themes, responsive layout
│   └── js/
│       ├── whiteboard.js  # Shared canvas drawing engine
│       ├── presenter.js   # Presenter logic (tools, boards, WS send)
│       └── viewer.js      # Viewer logic (WS receive, render)
```

- **Backend:** Node.js, Express, `ws` (WebSocket)
- **Frontend:** Vanilla JS + Canvas API (no frameworks)
- **Sync:** WebSocket for real-time stroke broadcasting
- **State:** In-memory on the server (resets on restart)

## Usage Tips

- **iPad:** Enable Do Not Disturb to keep notifications out of your recording
- **Screen Studio:** Record just the viewer browser window for a clean capture
- **Dark mode** works well for technical diagrams; **light mode** for a traditional whiteboard look
- Points are stored as normalized coordinates (0–1), so presenter and viewer can run at different resolutions
