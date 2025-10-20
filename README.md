# Lantern Chat

Lantern Chat is a peer-to-peer chat and file sharing experience for local networks. Each device runs the same FastAPI service which:

- Discovers peers automatically using UDP broadcast beacons.
- Exchanges RSA public keys and negotiates AES-GCM session keys for end-to-end encrypted transport.
- Streams text messages and file payloads directly between peers over WebSockets.
- Serves a rich, multi-conversation web UI that remembers devices in browser cookies.

## Features

- **Zero configuration discovery** – devices announce their presence every few seconds and listen for new peers.
- **Secure by design** – 2048-bit RSA handshakes protect a 256-bit AES session per peer.
- **Multiple conversations** – open any number of chats, with tabbed navigation and unread badges.
- **File sharing** – share files of any type; recipients receive a download link in-line.
- **Cookie contact cards** – known peers persist in cookies for quick reconnects and offline awareness.
- **Beautiful interface** – gradient-rich dark UI tuned for desktops and tablets.

## Getting started

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

Open <http://localhost:8000> to access the interface. Repeat the setup on another machine within the same local network to try secure chats and file transfers.

## Project structure

```
backend/
  app.py          # FastAPI application, chat orchestration, WebSocket handling
  discovery.py    # UDP discovery service and identity helpers
  security.py     # RSA keypair helpers and AES-GCM utilities
  storage.py      # Contact and session managers
frontend/
  templates/index.html
  static/
    app.js        # UI logic, state management, cookie storage
    styles.css    # Tailored dark theme styling
```

Runtime identity files are written to `./runtime/identity.json` for convenience.

## Limitations

- LAN broadcast may be blocked on restrictive networks. Ensure UDP broadcast on port 47300 is allowed.
- File payloads are exchanged as base64 WebSocket messages; very large files may impact memory usage.
- Browsers need to reach peers directly (no TURN relays). For remote networks, further work is required.

## License

This project is provided for demonstration purposes. Customize and extend it to suit your environment.
