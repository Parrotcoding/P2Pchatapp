const SIGNALING_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/signaling`;
const IDENTITY_COOKIE = "lantern_identity";
const CONTACT_COOKIE = "lantern_contacts";

const STUN_CONFIG = [{ urls: "stun:stun.l.google.com:19302" }];

function randomName() {
  const animals = ["Otter", "Fox", "Dolphin", "Panda", "Tiger", "Falcon", "Koala", "Lynx", "Heron", "Orca"];
  const colors = ["Amber", "Cobalt", "Emerald", "Indigo", "Scarlet", "Violet", "Saffron", "Ivory", "Slate", "Coral"];
  return `${colors[Math.floor(Math.random() * colors.length)]} ${animals[Math.floor(Math.random() * animals.length)]}`;
}

function randomColor() {
  const palette = ["#FF6B6B", "#F7B267", "#FFD166", "#06D6A0", "#4ECDC4", "#1A8FE3", "#A363D9", "#F46036"];
  return palette[Math.floor(Math.random() * palette.length)];
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function arrayBufferFromBase64(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

class LanternApp {
  constructor() {
    this.identity = this.loadIdentity();
    this.socket = null;
    this.clientId = null;
    this.contacts = new Map();
    this.sessions = new Map();
    this.activeChat = null;

    this.contactList = document.querySelector("#contact-list");
    this.tabContainer = document.querySelector("#chat-tabs");
    this.messageList = document.querySelector("#message-list");
    this.placeholder = document.querySelector("#chat-placeholder");
    this.conversation = document.querySelector("#conversation");
    this.conversationName = document.querySelector("#conversation-name");
    this.conversationNote = document.querySelector("#conversation-note");

    this.identityName = document.querySelector("#identity-name");
    this.identityAvatar = document.querySelector("#identity-avatar");
    this.networkStatus = document.querySelector("#network-status");

    this.messageForm = document.querySelector("#message-form");
    this.messageInput = document.querySelector("#message-input");
    this.fileInput = document.querySelector("#file-input");

    this.bindEvents();
    this.renderIdentity();
    this.restoreContactsFromCookie();
    this.connect();
  }

  loadIdentity() {
    try {
      const cookie = readCookie(IDENTITY_COOKIE);
      if (cookie) {
        const value = JSON.parse(cookie);
        if (value && value.name && value.color) {
          return value;
        }
      }
    } catch (err) {
      console.warn("Failed to parse identity cookie", err);
    }
    const identity = { name: randomName(), color: randomColor() };
    writeCookie(IDENTITY_COOKIE, JSON.stringify(identity));
    return identity;
  }

  renderIdentity() {
    this.identityName.textContent = this.identity.name;
    this.identityAvatar.style.setProperty("--avatar-color", this.identity.color);
  }

  bindEvents() {
    document.querySelector("#edit-identity").addEventListener("click", () => {
      const newName = prompt("Choose a display name", this.identity.name);
      if (!newName) {
        return;
      }
      this.identity.name = newName.trim().slice(0, 40) || this.identity.name;
      writeCookie(IDENTITY_COOKIE, JSON.stringify(this.identity));
      this.renderIdentity();
      this.sendProfile();
    });

    document.querySelector("#refresh-contacts").addEventListener("click", () => {
      this.pingPresence();
    });

    this.messageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = this.messageInput.value.trim();
      if (!value) {
        return;
      }
      if (this.activeChat) {
        this.sendText(this.activeChat, value);
      }
      this.messageInput.value = "";
      this.messageInput.style.height = "auto";
    });

    this.messageInput.addEventListener("input", () => {
      this.messageInput.style.height = "auto";
      this.messageInput.style.height = `${Math.min(this.messageInput.scrollHeight, 160)}px`;
    });

    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      if (file && this.activeChat) {
        this.sendFile(this.activeChat, file);
      }
      this.fileInput.value = "";
    });
  }

  restoreContactsFromCookie() {
    const cookie = readCookie(CONTACT_COOKIE);
    if (!cookie) return;
    try {
      const contacts = JSON.parse(cookie);
      if (Array.isArray(contacts)) {
        contacts.forEach((entry) => {
          if (entry.peerId && entry.profile) {
            this.addOrUpdateContact(entry.peerId, entry.profile, { persist: false, online: false });
          }
        });
      }
    } catch (err) {
      console.warn("Unable to parse contact cookie", err);
    }
  }

  persistContacts() {
    const records = Array.from(this.contacts.values()).map((entry) => ({
      peerId: entry.peerId,
      profile: entry.profile,
    }));
    writeCookie(CONTACT_COOKIE, JSON.stringify(records));
  }

  connect() {
    this.networkStatus.textContent = "Connecting…";
    this.networkStatus.classList.remove("online");
    const socket = new WebSocket(SIGNALING_URL);
    socket.addEventListener("open", () => {
      this.networkStatus.textContent = "Online";
      this.networkStatus.classList.add("online");
      this.sendProfile();
    });
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      this.handleSignal(payload);
    });
    socket.addEventListener("close", () => {
      this.networkStatus.textContent = "Offline";
      this.networkStatus.classList.remove("online");
      this.clientId = null;
      setTimeout(() => this.connect(), 2000);
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
    this.socket = socket;
  }

  sendProfile() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.clientId) {
      return;
    }
    this.socket.send(
      JSON.stringify({
        type: "profile",
        profile: {
          name: this.identity.name,
          color: this.identity.color,
        },
      })
    );
  }

  pingPresence() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "ping" }));
    }
  }

  handleSignal(message) {
    const { type } = message;
    switch (type) {
      case "welcome":
        this.clientId = message.clientId;
        message.peers.forEach((entry) => {
          this.addOrUpdateContact(entry.peerId, entry.profile ?? null, { online: true });
        });
        this.sendProfile();
        break;
      case "peer-status":
        this.onPeerStatus(message);
        break;
      case "offer":
        this.onOffer(message);
        break;
      case "answer":
        this.onAnswer(message);
        break;
      case "candidate":
        this.onCandidate(message);
        break;
      case "hangup":
        this.onHangup(message);
        break;
      default:
        break;
    }
  }

  onPeerStatus({ event, peerId, profile }) {
    if (peerId === this.clientId) return;
    if (event === "left") {
      const contact = this.contacts.get(peerId);
      if (contact) {
        contact.online = false;
        contact.element.classList.remove("online");
        contact.element.classList.add("offline");
      }
      const session = this.sessions.get(peerId);
      if (session) {
        session.online = false;
        if (session.connection) {
          session.connection.close();
          session.connection = null;
        }
        if (session.channel) {
          session.channel.close();
          session.channel = null;
        }
        this.appendSystemMessage(session, "Peer disconnected");
        if (this.activeChat === peerId) {
          this.conversationNote.textContent = "Offline";
        }
      }
      return;
    }

    if (profile) {
      this.addOrUpdateContact(peerId, profile, { online: true });
      const session = this.sessions.get(peerId);
      if (session) {
        session.profile = profile;
        this.updateTab(session);
        if (this.activeChat === peerId) {
          this.conversationName.textContent = profile.name;
        }
      }
    } else if (event === "joined") {
      this.addOrUpdateContact(peerId, null, { online: true });
    }
  }

  addOrUpdateContact(peerId, profile, { persist = true, online = true } = {}) {
    let entry = this.contacts.get(peerId);
    if (!entry) {
      const template = document.querySelector("#contact-template");
      const element = template.content.firstElementChild.cloneNode(true);
      element.dataset.peerId = peerId;
      element.addEventListener("click", () => {
        this.openChat(peerId);
      });
      this.contactList.appendChild(element);
      entry = {
        peerId,
        profile: profile ?? { name: `Unknown ${peerId.slice(0, 4)}`, color: "#777" },
        element,
        online,
      };
      this.contacts.set(peerId, entry);
    }
    if (profile) {
      entry.profile = profile;
    }
    entry.online = online;
    const nameEl = entry.element.querySelector(".contact-name");
    const presenceEl = entry.element.querySelector(".presence-indicator");
    nameEl.textContent = entry.profile.name;
    entry.element.style.setProperty("--avatar-color", entry.profile.color || "#777");
    entry.element.classList.toggle("online", online);
    entry.element.classList.toggle("offline", !online);
    presenceEl.title = online ? "Online" : "Offline";
    const session = this.sessions.get(peerId);
    if (session) {
      session.profile = entry.profile;
      session.online = online;
      this.updateTab(session);
      if (this.activeChat === peerId) {
        this.conversationName.textContent = session.profile.name;
        this.conversationNote.textContent = online ? "Connected" : "Offline";
      }
    }
    if (persist) {
      this.persistContacts();
    }
  }

  ensureSession(peerId) {
    let session = this.sessions.get(peerId);
    if (!session) {
      const contact = this.contacts.get(peerId);
      session = {
        peerId,
        profile: contact?.profile || { name: `Guest ${peerId.slice(0, 4)}`, color: "#888" },
        connection: null,
        channel: null,
        messages: [],
        tab: this.createTab(peerId, contact?.profile),
        unread: 0,
        online: contact?.online ?? false,
      };
      this.sessions.set(peerId, session);
    }
    return session;
  }

  createTab(peerId, profile) {
    const template = document.querySelector("#tab-template");
    const tab = template.content.firstElementChild.cloneNode(true);
    const avatar = tab.querySelector(".tab-avatar");
    const name = tab.querySelector(".tab-name");
    const unread = tab.querySelector(".tab-unread");
    avatar.style.background = profile?.color || "#666";
    avatar.textContent = profile?.name?.[0] ?? "?";
    name.textContent = profile?.name || `Guest ${peerId.slice(0, 4)}`;
    tab.dataset.peerId = peerId;
    tab.addEventListener("click", (event) => {
      if (event.target.classList.contains("tab-close")) {
        this.closeSession(peerId, true);
        return;
      }
      this.selectChat(peerId);
    });
    tab.dataset.unread = "0";
    unread.hidden = true;
    this.tabContainer.appendChild(tab);
    return tab;
  }

  updateTab(session) {
    const avatar = session.tab.querySelector(".tab-avatar");
    const name = session.tab.querySelector(".tab-name");
    avatar.style.background = session.profile.color || "#666";
    avatar.textContent = session.profile.name?.[0] ?? "?";
    name.textContent = session.profile.name || name.textContent;
  }

  selectChat(peerId) {
    const session = this.ensureSession(peerId);
    this.activeChat = peerId;
    this.placeholder.hidden = true;
    this.conversation.hidden = false;
    this.conversationName.textContent = session.profile.name;
    this.conversationNote.textContent = session.online ? "Connected" : "Connecting…";
    this.tabContainer.querySelectorAll(".chat-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.peerId === peerId);
    });
    this.renderMessages(session);
    this.resetUnread(session);
    if (!session.connection) {
      this.establishConnection(peerId, true);
    }
  }

  renderMessages(session) {
    this.messageList.innerHTML = "";
    session.messages.forEach((entry) => this.renderMessage(entry));
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  renderMessage(entry) {
    let templateId = "message-template";
    if (entry.kind === "file") {
      templateId = "file-template";
    }
    const template = document.querySelector(`#${templateId}`);
    const element = template.content.firstElementChild.cloneNode(true);
    element.classList.add(entry.direction);
    const meta = element.querySelector(".meta");
    const timestamp = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.textContent = `${entry.author} • ${timestamp}`;
    if (entry.kind === "text") {
      element.querySelector(".bubble-content").textContent = entry.text;
    } else if (entry.kind === "file") {
      element.querySelector(".file-name").textContent = entry.file.name;
      element.querySelector(".file-size").textContent = this.formatFileSize(entry.file.size);
      const link = document.createElement("a");
      link.href = entry.file.url;
      link.textContent = "Download";
      link.className = "file-download";
      link.download = entry.file.name;
      element.querySelector(".bubble").appendChild(link);
    } else if (entry.kind === "system") {
      element.classList.add("system");
      element.querySelector(".bubble-content").textContent = entry.text;
      meta.textContent = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    }
    this.messageList.appendChild(element);
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  formatFileSize(size) {
    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  appendMessage(session, entry, { quiet = false } = {}) {
    session.messages.push(entry);
    if (this.activeChat === session.peerId) {
      this.renderMessage(entry);
    } else if (!quiet) {
      session.unread += 1;
      const badge = session.tab.querySelector(".tab-unread");
      badge.textContent = session.unread;
      badge.hidden = false;
      session.tab.classList.add("has-unread");
    }
  }

  appendSystemMessage(session, text) {
    this.appendMessage(
      session,
      {
        direction: "system",
        kind: "system",
        text,
        timestamp: Date.now(),
        author: "System",
      },
      { quiet: this.activeChat === session.peerId }
    );
  }

  resetUnread(session) {
    session.unread = 0;
    const badge = session.tab.querySelector(".tab-unread");
    badge.hidden = true;
    session.tab.classList.remove("has-unread");
  }

  async establishConnection(peerId, initiator) {
    const session = this.ensureSession(peerId);
    if (session.connection) {
      return session.connection;
    }
    const pc = new RTCPeerConnection({ iceServers: STUN_CONFIG });
    session.connection = pc;
    session.online = true;

    pc.onicecandidate = (event) => {
      if (event.candidate && this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: "candidate",
            target: peerId,
            candidate: event.candidate,
          })
        );
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        this.appendSystemMessage(session, "Connection lost");
        this.closeSession(peerId, false);
      }
    };

    if (initiator) {
      const channel = pc.createDataChannel("lantern");
      this.configureChannel(peerId, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.activeChat === peerId) {
        this.conversationNote.textContent = "Connecting…";
      }
      this.socket?.send(
        JSON.stringify({
          type: "offer",
          target: peerId,
          description: offer,
        })
      );
    } else {
      pc.ondatachannel = (event) => {
        this.configureChannel(peerId, event.channel);
      };
    }

    return pc;
  }

  configureChannel(peerId, channel) {
    const session = this.ensureSession(peerId);
    session.channel = channel;
    session.online = true;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      this.appendSystemMessage(session, "Channel ready");
      if (this.activeChat === peerId) {
        this.conversationNote.textContent = "Connected";
      }
    };
    channel.onclose = () => {
      this.appendSystemMessage(session, "Channel closed");
    };
    channel.onmessage = (event) => {
      this.receivePacket(peerId, event.data);
    };
  }

  async onOffer({ from, description }) {
    const session = this.ensureSession(from);
    const pc = await this.establishConnection(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket?.send(
      JSON.stringify({
        type: "answer",
        target: from,
        description: answer,
      })
    );
    if (this.activeChat !== from) {
      this.selectChat(from);
    }
  }

  async onAnswer({ from, description }) {
    const session = this.ensureSession(from);
    if (!session.connection) return;
    await session.connection.setRemoteDescription(new RTCSessionDescription(description));
  }

  async onCandidate({ from, candidate }) {
    const session = this.ensureSession(from);
    if (!session.connection || !candidate) return;
    try {
      await session.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error("Failed to add ICE candidate", err);
    }
  }

  onHangup({ from }) {
    this.closeSession(from, false);
  }

  closeSession(peerId, notify) {
    const session = this.sessions.get(peerId);
    if (!session) return;
    if (session.connection) {
      session.connection.close();
    }
    if (session.channel) {
      session.channel.close();
    }
    session.online = false;
    if (notify && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "hangup", target: peerId }));
    }
    session.tab.remove();
    this.sessions.delete(peerId);
    if (this.activeChat === peerId) {
      this.activeChat = null;
      this.conversation.hidden = true;
      this.placeholder.hidden = false;
      this.messageList.innerHTML = "";
    }
  }

  async sendText(peerId, text) {
    const session = this.ensureSession(peerId);
    if (!session.channel || session.channel.readyState !== "open") {
      await this.establishConnection(peerId, true);
      if (!session.channel || session.channel.readyState !== "open") {
        this.appendSystemMessage(session, "Connecting…");
        return;
      }
    }
    const packet = {
      kind: "text",
      text,
      timestamp: Date.now(),
      author: this.identity.name,
    };
    session.channel.send(JSON.stringify(packet));
    this.appendMessage(session, {
      ...packet,
      direction: "outgoing",
    });
  }

  async sendFile(peerId, file) {
    const session = this.ensureSession(peerId);
    if (!session.channel || session.channel.readyState !== "open") {
      await this.establishConnection(peerId, true);
    }
    if (!session.channel || session.channel.readyState !== "open") {
      this.appendSystemMessage(session, "Waiting for channel before sending file");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = base64FromArrayBuffer(reader.result);
      const packet = {
        kind: "file",
        timestamp: Date.now(),
        author: this.identity.name,
        file: {
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          data: base64,
        },
      };
      session.channel.send(JSON.stringify(packet));
      this.appendMessage(session, {
        direction: "outgoing",
        kind: "file",
        timestamp: packet.timestamp,
        author: this.identity.name,
        file: {
          name: file.name,
          size: file.size,
          url: URL.createObjectURL(file),
        },
      });
    };
    reader.readAsArrayBuffer(file);
  }

  receivePacket(peerId, payload) {
    const session = this.ensureSession(peerId);
    let data = payload;
    if (typeof payload === "string") {
      try {
        data = JSON.parse(payload);
      } catch (err) {
        console.warn("Unable to parse payload", err);
        return;
      }
    }
    if (!data) return;

    if (data.kind === "text") {
      this.appendMessage(session, {
        direction: "incoming",
        kind: "text",
        text: data.text,
        timestamp: data.timestamp || Date.now(),
        author: data.author || session.profile.name,
      });
    } else if (data.kind === "file") {
      const buffer = arrayBufferFromBase64(data.file.data);
      const blob = new Blob([buffer], { type: data.file.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      this.appendMessage(session, {
        direction: "incoming",
        kind: "file",
        timestamp: data.timestamp || Date.now(),
        author: data.author || session.profile.name,
        file: {
          name: data.file.name,
          size: data.file.size,
          url,
        },
      });
    }
    this.addOrUpdateContact(peerId, session.profile, { persist: true, online: true });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new LanternApp();
});
