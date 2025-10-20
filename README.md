# Lantern Chat

Lantern Chat is a browser-first peer-to-peer chat for local networks. Each participant opens the same web app, which:

- Discovers online friends instantly through a shared signaling server.
- Establishes encrypted WebRTC data channels between browsers for direct messaging and file sharing.
- Remembers friendly devices with cookie-based contact cards and glowing presence indicators.
- Supports multiple conversations at once with polished, tabbed chat panels.

## Features

- **Zero install** – launch the FastAPI app once and every device connects from a browser.
- **Automatic discovery** – presence updates stream over a lightweight WebSocket signaling hub.
- **Secure transport** – WebRTC data channels provide end-to-end encryption for text and files.
- **Multi-chat workspace** – tabs keep parallel conversations organised, with unread badges.
- **Cookie memories** – returning peers appear instantly from cookies, even before they reconnect.
- **Elegant dark theme** – a gradient-rich interface tuned for desktops and tablets.

## Getting started

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

Visit <http://localhost:8000> from each browser on the same network. Lantern will exchange presence information through the
signaling server and automatically negotiate WebRTC channels when you open a chat.

## Project structure

```
backend/
  app.py          # FastAPI app serving the web UI and WebSocket signaling hub
frontend/
  templates/index.html
  static/
    app.js        # Client-side app logic, WebRTC sessions, cookie persistence
    styles.css    # Gradient dark theme and responsive layout
```

## Notes

- WebRTC requires direct peer reachability. Ensure local firewalls allow peer-to-peer UDP traffic or add TURN servers.
- File transfers are encoded as base64 payloads on the data channel; large files may take additional time.
- Cookies are used to persist identities and known peers for a friendlier reconnect experience.

## License

This project is provided for demonstration purposes. Adapt it to suit your environment.
