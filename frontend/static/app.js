const state = {
  contacts: [],
  knownContacts: [],
  chats: {},
  openChats: [],
  activeChatId: null,
  eventsSocket: null,
};

const contactListEl = document.getElementById("contact-list");
const tabsEl = document.getElementById("chat-tabs");
const placeholderEl = document.getElementById("chat-placeholder");
const conversationEl = document.getElementById("conversation");
const messageListEl = document.getElementById("message-list");
const formEl = document.getElementById("message-form");
const messageInputEl = document.getElementById("message-input");
const fileInputEl = document.getElementById("file-input");
const conversationNameEl = document.getElementById("conversation-name");
const conversationAddressEl = document.getElementById("conversation-address");
const statusEl = document.getElementById("network-status");

function parseCookies() {
  return document.cookie.split("; ").reduce((acc, pair) => {
    const [key, ...rest] = pair.split("=");
    if (!key) return acc;
    acc[decodeURIComponent(key)] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function saveContactsToCookies(contacts) {
  try {
    const encoded = encodeURIComponent(JSON.stringify(contacts));
    document.cookie = `lantern_contacts=${encoded}; max-age=${60 * 60 * 24 * 14}; path=/; SameSite=Lax`;
  } catch (err) {
    console.warn("Unable to persist contacts", err);
  }
}

function loadContactsFromCookies() {
  const cookies = parseCookies();
  if (cookies.lantern_contacts) {
    try {
      const contacts = JSON.parse(cookies.lantern_contacts);
      state.knownContacts = contacts;
    } catch (err) {
      console.warn("Failed to parse stored contacts", err);
    }
  }
}

function setStatus(text, accent = true) {
  statusEl.textContent = text;
  statusEl.style.color = accent ? "" : "var(--text-secondary)";
  statusEl.style.background = accent ? "rgba(56, 189, 248, 0.1)" : "rgba(148, 163, 184, 0.2)";
}

function formatTimestamp(ts) {
  const date = new Date(ts * 1000);
  return `${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function ensureChat(peerId, contact) {
  if (!state.chats[peerId]) {
    state.chats[peerId] = {
      contact,
      messages: [],
      loaded: false,
      hasUnread: false,
    };
  }
  if (!state.openChats.includes(peerId)) {
    state.openChats.push(peerId);
  }
}

function renderContacts() {
  contactListEl.innerHTML = "";
  const combined = new Map();
  for (const contact of state.knownContacts) {
    combined.set(contact.id, contact);
  }
  for (const contact of state.contacts) {
    combined.set(contact.id, contact);
  }
  const allContacts = Array.from(combined.values()).sort((a, b) => b.last_seen - a.last_seen);
  if (allContacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No devices discovered yet. We'll keep listening.";
    contactListEl.appendChild(empty);
    setStatus("Listening for peers", false);
    return;
  }
  setStatus(`Connected to ${allContacts.length} device${allContacts.length > 1 ? "s" : ""}`);
  allContacts.forEach((contact) => {
    const card = document.createElement("div");
    card.className = "contact-card";
    if (state.activeChatId === contact.id) {
      card.classList.add("active");
    }
    card.innerHTML = `
      <h3 class="contact-name">${contact.name}</h3>
      <p class="contact-meta">${contact.host}:${contact.port}</p>
    `;
    card.addEventListener("click", () => openChat(contact));
    contactListEl.appendChild(card);
  });
}

function renderTabs() {
  tabsEl.innerHTML = "";
  state.openChats.forEach((peerId) => {
    const chat = state.chats[peerId];
    if (!chat) return;
    const tab = document.createElement("div");
    tab.className = "chat-tab";
    if (state.activeChatId === peerId) {
      tab.classList.add("active");
      chat.hasUnread = false;
    }
    if (chat.hasUnread) {
      tab.classList.add("unread");
    }
    tab.innerHTML = `
      <span>${chat.contact.name}</span>
      <button class="close" title="Close chat">×</button>
    `;
    tab.addEventListener("click", (event) => {
      if (event.target instanceof HTMLElement && event.target.classList.contains("close")) {
        closeChat(peerId);
        event.stopPropagation();
      } else {
        activateChat(peerId);
      }
    });
    tabsEl.appendChild(tab);
  });
}

function activateChat(peerId) {
  if (!state.chats[peerId]) return;
  state.activeChatId = peerId;
  renderTabs();
  renderConversation();
}

function closeChat(peerId) {
  const idx = state.openChats.indexOf(peerId);
  if (idx >= 0) {
    state.openChats.splice(idx, 1);
  }
  if (state.activeChatId === peerId) {
    state.activeChatId = state.openChats[state.openChats.length - 1] || null;
  }
  renderTabs();
  renderConversation();
}

function renderConversation() {
  if (!state.activeChatId || !state.chats[state.activeChatId]) {
    conversationEl.hidden = true;
    placeholderEl.hidden = false;
    return;
  }
  const chat = state.chats[state.activeChatId];
  placeholderEl.hidden = true;
  conversationEl.hidden = false;
  conversationNameEl.textContent = chat.contact.name;
  conversationAddressEl.textContent = `${chat.contact.host}:${chat.contact.port}`;
  messageListEl.innerHTML = "";
  chat.messages.forEach((message) => appendMessageElement(message));
  messageListEl.scrollTop = messageListEl.scrollHeight;
  if (!chat.loaded) {
    loadHistory(chat.contact.id);
  }
}

function appendMessageElement(message) {
  const node = document.createElement("div");
  node.className = `message ${message.direction}`;
  if (message.type === "text") {
    node.textContent = message.content.text;
  } else if (message.type === "file") {
    const link = document.createElement("a");
    link.href = `data:${message.content.content_type};base64,${message.content.data}`;
    link.download = message.content.filename;
    link.textContent = `Download ${message.content.filename}`;
    link.className = "download";
    node.innerHTML = `<div>${message.direction === "outgoing" ? "You sent" : "Received"} a file:</div>`;
    node.appendChild(link);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${message.direction === "outgoing" ? "You" : "Peer"} · ${formatTimestamp(message.timestamp)}`;
  node.appendChild(meta);
  messageListEl.appendChild(node);
}

async function loadHistory(peerId) {
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(peerId)}/history`);
    if (!response.ok) throw new Error("Unable to fetch history");
    const data = await response.json();
    const chat = state.chats[peerId];
    if (!chat) return;
    chat.messages = data.messages;
    chat.loaded = true;
    if (state.activeChatId === peerId) {
      messageListEl.innerHTML = "";
      chat.messages.forEach((message) => appendMessageElement(message));
      messageListEl.scrollTop = messageListEl.scrollHeight;
    }
  } catch (err) {
    console.error(err);
  }
}

async function fetchContacts() {
  try {
    const response = await fetch("/api/contacts");
    const data = await response.json();
    state.contacts = data.contacts || [];
    if (state.contacts.length) {
      saveContactsToCookies(state.contacts);
    }
    renderContacts();
  } catch (err) {
    console.error("Unable to fetch contacts", err);
  }
}

function openChat(contact) {
  ensureChat(contact.id, contact);
  renderTabs();
  activateChat(contact.id);
}

function handleIncomingEvent(event) {
  try {
    const payload = JSON.parse(event.data);
    if (payload.type === "message") {
      const peerId = payload.peer_id;
      const message = payload.message;
      const contact = state.contacts.find((c) => c.id === peerId) || state.knownContacts.find((c) => c.id === peerId);
      if (contact) {
        ensureChat(peerId, contact);
      }
      const chat = state.chats[peerId];
      if (!chat) {
        return;
      }
      chat.messages.push(message);
      if (state.activeChatId === peerId) {
        appendMessageElement(message);
        messageListEl.scrollTop = messageListEl.scrollHeight;
      } else {
        chat.hasUnread = true;
      }
      renderTabs();
    }
  } catch (err) {
    console.error("Failed to parse event", err);
  }
}

function setupEventsSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/events`);
  state.eventsSocket = socket;
  socket.addEventListener("message", handleIncomingEvent);
  socket.addEventListener("open", () => {
    setStatus("Event stream active");
  });
  socket.addEventListener("close", () => {
    setStatus("Reconnecting…", false);
    setTimeout(setupEventsSocket, 2000);
  });
}

function autoSizeTextarea() {
  messageInputEl.style.height = "auto";
  messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
}

async function sendMessage(text) {
  if (!state.activeChatId) return;
  await fetch(`/api/chats/${encodeURIComponent(state.activeChatId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function sendFile(file) {
  if (!state.activeChatId) return;
  const form = new FormData();
  form.append("file", file);
  await fetch(`/api/chats/${encodeURIComponent(state.activeChatId)}/file`, {
    method: "POST",
    body: form,
  });
}

function bindUI() {
  document.getElementById("refresh-contacts").addEventListener("click", () => {
    fetchContacts();
  });

  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = messageInputEl.value.trim();
    if (!text) return;
    messageInputEl.value = "";
    autoSizeTextarea();
    await sendMessage(text);
  });

  messageInputEl.addEventListener("input", autoSizeTextarea);
  autoSizeTextarea();

  fileInputEl.addEventListener("change", async (event) => {
    const target = event.target;
    if (target.files && target.files.length) {
      const file = target.files[0];
      await sendFile(file);
      target.value = "";
    }
  });
}

async function init() {
  loadContactsFromCookies();
  renderContacts();
  bindUI();
  setupEventsSocket();
  await fetchContacts();
  setInterval(fetchContacts, 8000);
}

init();
