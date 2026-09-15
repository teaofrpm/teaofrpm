let ME = null;
let replyingTo = null;
let pendingImageFile = null;
let pendingImagePreviewUrl = null;
let presenceChannel = null;
let onlineMembers = new Map(); // user_id -> {display_name, role}
const profileCache = new Map(); // user_id -> profile (avoids refetching per message)

let STICKER_URLS = [];

let oldestLoadedAt = null;
let hasMoreHistory = true;
let lastRenderedDay = null;
const PAGE_SIZE = 50;

let typingUsers = new Map(); // user_id -> { display_name, timeoutId }
let isTypingBroadcasted = false;
let typingClearTimer = null;
let searchDebounceTimer = null;

async function init() {
  const session = await requireSession("index.html");
  if (!session) return;

  ME = await getMyProfile();
  if (!ME) return;

  if (ME.banned) {
    toast("This account has been banned.");
    await sb.auth.signOut();
    window.location.href = "index.html";
    return;
  }
  if (!ME.is_verified) {
    window.location.href = "verify.html";
    return;
  }

  profileCache.set(ME.id, ME);

  document.getElementById("roomNameLabel").textContent = window.TEAOFRPM_CONFIG.ROOM_NAME;
  document.getElementById("headerRoomName").textContent = window.TEAOFRPM_CONFIG.ROOM_NAME;

  await loadStickers();
  await loadHistory();
  subscribeRealtime();
  subscribePresence();
  wireComposer();
  wireHeader();
  wireScrollTracking();
  wireLightbox();
  wireSearch();
}

async function getProfile(userId) {
  if (profileCache.has(userId)) return profileCache.get(userId);
  const { data } = await sb.from("profiles").select("*").eq("id", userId).single();
  if (data) profileCache.set(userId, data);
  return data;
}

async function loadHistory() {
  const { data: msgs, error } = await sb
    .from("messages")
    .select("*")
    .eq("deleted", false)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    toast("Could not load messages.");
    console.error(error);
    return;
  }

  const ordered = [...msgs].reverse();
  hasMoreHistory = msgs.length === PAGE_SIZE;
  oldestLoadedAt = ordered.length ? ordered[0].created_at : null;

  const ids = [...new Set(ordered.map(m => m.user_id))];
  await Promise.all(ids.map(getProfile));

  const reactionsByMsg = await fetchReactions(ordered.map(m => m.id));

  const container = document.getElementById("messages");
  container.innerHTML = "";
  lastRenderedDay = null;
  await appendMessages(container, ordered, reactionsByMsg, "append");
  updateLoadMoreButton();
  scrollToBottom();
}

async function fetchReactions(ids) {
  if (!ids.length) return {};
  const { data } = await sb.from("message_reactions").select("*").in("message_id", ids);
  return groupReactions(data || []);
}

function groupReactions(rows) {
  const map = {};
  for (const r of rows) {
    (map[r.message_id] = map[r.message_id] || []).push(r);
  }
  return map;
}

async function appendMessages(container, msgs, reactionsByMsg, mode) {
  const frag = document.createDocumentFragment();
  let dayRef = mode === "prepend" ? null : lastRenderedDay;
  for (const m of msgs) {
    const day = new Date(m.created_at).toDateString();
    if (day !== dayRef) {
      frag.appendChild(buildDateDivider(m.created_at));
      dayRef = day;
    }
    frag.appendChild(await renderMessage(m, reactionsByMsg[m.id] || []));
  }
  if (mode === "prepend") {
    container.insertBefore(frag, container.firstChild);
  } else {
    container.appendChild(frag);
    lastRenderedDay = dayRef;
  }
}

function buildDateDivider(ts) {
  const div = document.createElement("div");
  div.className = "date-divider";
  div.innerHTML = `<span>${formatDayLabel(ts)}</span>`;
  return div;
}

function formatDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function updateLoadMoreButton() {
  const btn = document.getElementById("loadMoreBtn");
  btn.classList.toggle("show", hasMoreHistory);
  btn.textContent = "Load older messages";
  btn.disabled = false;
}

async function loadOlderMessages() {
  if (!hasMoreHistory || !oldestLoadedAt) return;
  const btn = document.getElementById("loadMoreBtn");
  btn.disabled = true;
  btn.textContent = "Loading…";

  const container = document.getElementById("messages");
  const prevHeight = container.scrollHeight;
  const prevScrollTop = container.scrollTop;

  const { data: msgs, error } = await sb
    .from("messages")
    .select("*")
    .eq("deleted", false)
    .lt("created_at", oldestLoadedAt)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    toast("Could not load older messages.");
    updateLoadMoreButton();
    return;
  }

  const ordered = [...msgs].reverse();
  hasMoreHistory = msgs.length === PAGE_SIZE;
  if (ordered.length) oldestLoadedAt = ordered[0].created_at;

  const ids = [...new Set(ordered.map(m => m.user_id))];
  await Promise.all(ids.map(getProfile));
  const reactionsByMsg = await fetchReactions(ordered.map(m => m.id));

  await appendMessages(container, ordered, reactionsByMsg, "prepend");
  updateLoadMoreButton();

  container.scrollTop = prevScrollTop + (container.scrollHeight - prevHeight);
}

async function renderMessage(m, reactions = []) {
  const author = await getProfile(m.user_id);
  const isOwn = m.user_id === ME.id;
  const isOwnerMsg = author && author.role === "owner";

  const row = document.createElement("div");
  row.className = `msg-row ${isOwn ? "own" : ""} ${isOwnerMsg ? "owner-msg" : ""}`;
  row.dataset.msgId = m.id;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.style.background = colorFromName(author?.display_name || "?");
  avatar.textContent = initials(author?.display_name);
  row.appendChild(avatar);

  const wrap = document.createElement("div");
  wrap.className = "msg-bubble-wrap";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.innerHTML = `
    <span class="msg-name">${escapeHTML(author?.display_name || "Unknown")}</span>
    ${isOwnerMsg ? `<span class="owner-badge">Owner</span>` : ""}
    <span>${formatTime(m.created_at)}</span>
  `;
  wrap.appendChild(meta);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (m.sticker_url && !m.content && !m.image_url) {
    bubble.classList.add("sticker-only");
  }

  if (m.reply_to) {
    const replyPrev = document.createElement("div");
    replyPrev.className = "reply-preview";
    const original = await findMessageById(m.reply_to);
    if (original) {
      const origAuthor = await getProfile(original.user_id);
      replyPrev.innerHTML = `<b>${escapeHTML(origAuthor?.display_name || "…")}</b>: ${escapeHTML(previewText(original))}`;
    } else {
      replyPrev.textContent = "Original message";
    }
    bubble.appendChild(replyPrev);
  }

  if (m.sticker_url) {
    const img = document.createElement("img");
    img.className = "sticker-img";
    img.src = m.sticker_url;
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(m.sticker_url));
    bubble.appendChild(img);
  }

  if (m.image_url) {
    const img = document.createElement("img");
    img.className = "chat-img";
    img.src = m.image_url;
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(m.image_url));
    bubble.appendChild(img);
  }

  if (m.content) {
    const txt = document.createElement("div");
    txt.innerHTML = linkify(escapeHTML(m.content));
    if (m.image_url || m.sticker_url) txt.style.marginTop = "6px";
    bubble.appendChild(txt);
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  actions.innerHTML = `
    <button class="react-btn" title="React">🙂+</button>
    <button class="reply-btn" title="Reply">↩</button>
    ${isOwn ? `<button class="delete-btn" title="Delete">🗑</button>` : ""}
  `;
  bubble.appendChild(actions);

  wrap.appendChild(bubble);

  const reactRow = document.createElement("div");
  reactRow.className = "reactions-row";
  wrap.appendChild(reactRow);
  renderReactions(reactRow, m.id, reactions);

  row.appendChild(wrap);

  actions.querySelector(".reply-btn").addEventListener("click", () => {
    startReply(m, author);
  });
  actions.querySelector(".react-btn").addEventListener("click", () => {
    openEmojiPicker(bubble, m.id);
  });
  if (isOwn) {
    actions.querySelector(".delete-btn").addEventListener("click", () => deleteMessage(m.id, row));
  }

  return row;
}

function linkify(safeText) {
  return safeText.replace(/(https?:\/\/[^\s]+)/g, (url) => {
    const trimmed = url.replace(/[.,!?)\]]+$/, "");
    const trailing = url.slice(trimmed.length);
    return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${trimmed}</a>${trailing}`;
  });
}

async function deleteMessage(id, row) {
  if (!confirm("Delete this message?")) return;
  const { error } = await sb.from("messages").update({ deleted: true }).eq("id", id).eq("user_id", ME.id);
  if (error) { toast(error.message || "Could not delete message."); return; }
  row.remove();
}

function previewText(m) {
  if (m.content) return m.content.slice(0, 60);
  if (m.image_url) return " Photo";
  if (m.sticker_url) return " Sticker";
  return "message";
}

async function findMessageById(id) {
  const { data } = await sb.from("messages").select("*").eq("id", id).single();
  return data;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderReactions(container, messageId, reactions) {
  container.innerHTML = "";
  const grouped = {};
  for (const r of reactions) {
    grouped[r.emoji] = grouped[r.emoji] || [];
    grouped[r.emoji].push(r);
  }
  for (const [emoji, rows] of Object.entries(grouped)) {
    const mine = rows.some(r => r.user_id === ME.id);
    const chip = document.createElement("span");
    chip.className = `reaction-chip ${mine ? "mine" : ""}`;
    chip.textContent = `${emoji} ${rows.length}`;
    chip.addEventListener("click", () => toggleReaction(messageId, emoji, mine));
    container.appendChild(chip);
  }
}

async function toggleReaction(messageId, emoji, alreadyMine) {
  if (alreadyMine) {
    await sb.from("message_reactions").delete()
      .eq("message_id", messageId).eq("user_id", ME.id).eq("emoji", emoji);
  } else {
    await sb.from("message_reactions").insert({ message_id: messageId, user_id: ME.id, emoji });
  }
}

function openEmojiPicker(bubble, messageId) {
  document.querySelectorAll(".emoji-picker").forEach(e => e.remove());
  const quick = ["❤️", "😂", "👍", "👎", "😮", "😢", "🙏", "🔥", "🎉", "😍", "😡", "👏"];
  const picker = document.createElement("div");
  picker.className = "emoji-picker";
  picker.innerHTML = quick.map(e => `<span>${e}</span>`).join("");
  bubble.appendChild(picker);
  picker.querySelectorAll("span").forEach(span => {
    span.addEventListener("click", async () => {
      await toggleReaction(messageId, span.textContent, false);
      picker.remove();
    });
  });
  setTimeout(() => {
    document.addEventListener("click", function closeOnce(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener("click", closeOnce);
      }
    });
  }, 10);
}

function startReply(message, author) {
  replyingTo = { id: message.id, name: author?.display_name || "Unknown", text: previewText(message) };
  document.getElementById("replyToName").textContent = replyingTo.name;
  document.getElementById("replyToText").textContent = replyingTo.text;
  document.getElementById("replyBar").classList.add("show");
  document.getElementById("msgInput").focus();
}
document.addEventListener("DOMContentLoaded", () => {
  const cancel = document.getElementById("cancelReply");
  if (cancel) cancel.addEventListener("click", clearReply);
});
function clearReply() {
  replyingTo = null;
  document.getElementById("replyBar").classList.remove("show");
}

async function loadStickers() {
  const { data, error } = await sb.from("stickers").select("*").order("created_at", { ascending: false });
  if (error) {
    console.error(error);
    STICKER_URLS = [];
  } else {
    STICKER_URLS = (data || []).map(s => ({
      url: sb.storage.from("stickers").getPublicUrl(s.storage_path).data.publicUrl,
      label: s.label || "sticker",
    }));
  }
  buildStickerPanel();
}

const RECENT_STICKERS_KEY = "teaofrpm_recent_stickers";

function getRecentStickers() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_STICKERS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRecentSticker(sticker) {
  const recents = getRecentStickers().filter(s => s.url !== sticker.url);
  recents.unshift(sticker);
  localStorage.setItem(RECENT_STICKERS_KEY, JSON.stringify(recents.slice(0, 8)));
}

function buildStickerPanel() {
  const panel = document.getElementById("stickerPanel");
  if (!STICKER_URLS.length) {
    panel.innerHTML = `<span style="grid-column:1/-1; font-size:12.5px; color:var(--text-muted); padding:8px;">No stickers yet — the admin can add some via the Telegram bot.</span>`;
    return;
  }

  const recents = getRecentStickers().filter(r => STICKER_URLS.some(s => s.url === r.url));

  let html = "";
  if (recents.length) {
    html += `<span class="sticker-section-label">Recently used</span>`;
    html += recents.map(s => `<img src="${s.url}" alt="${escapeHTML(s.label)}" title="${escapeHTML(s.label)}" />`).join("");
    html += `<span class="sticker-section-label">All stickers</span>`;
  }
  html += STICKER_URLS.map(s => `<img src="${s.url}" alt="${escapeHTML(s.label)}" title="${escapeHTML(s.label)}" />`).join("");

  panel.innerHTML = html;
  panel.querySelectorAll("img").forEach((el) => {
    el.addEventListener("click", () => {
      const sticker = STICKER_URLS.find(s => s.url === el.src) || recents.find(r => r.url === el.src);
      if (!sticker) return;
      saveRecentSticker(sticker);
      buildStickerPanel();
      sendMessage({ sticker: sticker.url });
    });
  });
}

const MAX_IMAGE_DIMENSION = 1600; // longest side, in px
const JPEG_QUALITY = 0.82;

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      let { width, height } = img;
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        if (width >= height) {
          height = Math.round(height * (MAX_IMAGE_DIMENSION / width));
          width = MAX_IMAGE_DIMENSION;
        } else {
          width = Math.round(width * (MAX_IMAGE_DIMENSION / height));
          height = MAX_IMAGE_DIMENSION;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);

      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Could not process this image."));
          resolve(blob);
        },
        "image/jpeg",
        JPEG_QUALITY
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This photo's format isn't supported by your browser."));
    };

    img.src = objectUrl;
  });
}

function wireComposer() {
  const input = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");
  const stickerToggle = document.getElementById("stickerToggle");
  const stickerPanel = document.getElementById("stickerPanel");
  const imageInput = document.getElementById("imageInput");

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    sendBtn.disabled = !(input.value.trim() || pendingImageFile);
  });

  wireTypingBroadcast(input);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage({});
    }
  });

  sendBtn.addEventListener("click", () => sendMessage({}));

  stickerToggle.addEventListener("click", () => stickerPanel.classList.toggle("show"));

  imageInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById("attachName").textContent = "Processing photo…";
    document.getElementById("attachPreview").classList.add("show");

    try {
      const compressed = await compressImageFile(file);
      pendingImageFile = compressed;
      if (pendingImagePreviewUrl) URL.revokeObjectURL(pendingImagePreviewUrl);
      pendingImagePreviewUrl = URL.createObjectURL(compressed);
      document.getElementById("attachImg").src = pendingImagePreviewUrl;
      document.getElementById("attachName").textContent = file.name;
      sendBtn.disabled = false;
    } catch (err) {
      toast(err.message || "Could not process this photo.");
      document.getElementById("attachPreview").classList.remove("show");
      pendingImageFile = null;
      imageInput.value = "";
    }
  });

  document.getElementById("removeAttach").addEventListener("click", () => {
    pendingImageFile = null;
    if (pendingImagePreviewUrl) { URL.revokeObjectURL(pendingImagePreviewUrl); pendingImagePreviewUrl = null; }
    imageInput.value = "";
    document.getElementById("attachPreview").classList.remove("show");
    sendBtn.disabled = !input.value.trim();
  });
}

async function sendMessage({ sticker }) {
  const input = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");
  const text = input.value.trim();

  if (!text && !pendingImageFile && !sticker) return;

  sendBtn.disabled = true;

  let image_url = null;
  try {
    if (pendingImageFile) {
      const path = `${ME.id}/${Date.now()}.jpg`;
      const { error: upErr } = await sb.storage.from("chat-images").upload(path, pendingImageFile, {
        contentType: "image/jpeg",
      });
      if (upErr) throw upErr;
      const { data: pub } = sb.storage.from("chat-images").getPublicUrl(path);
      image_url = pub.publicUrl;
    }

    const payload = {
      user_id: ME.id,
      content: text || null,
      image_url,
      sticker_url: sticker || null,
      reply_to: replyingTo ? replyingTo.id : null,
    };

    const { error } = await sb.from("messages").insert(payload);
    if (error) throw error;

    input.value = "";
    input.style.height = "auto";
    pendingImageFile = null;
    if (pendingImagePreviewUrl) { URL.revokeObjectURL(pendingImagePreviewUrl); pendingImagePreviewUrl = null; }
    document.getElementById("imageInput").value = "";
    document.getElementById("attachPreview").classList.remove("show");
    document.getElementById("stickerPanel").classList.remove("show");
    clearReply();
    clearTimeout(typingClearTimer);
    sendTypingState(false);
  } catch (e) {
    toast(e.message || "Message failed to send.");
  } finally {
    sendBtn.disabled = !(input.value.trim() || pendingImageFile);
  }
}

function subscribeRealtime() {
  sb.channel("public:messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async (payload) => {
      const m = payload.new;
      await getProfile(m.user_id);
      const { data: reactions } = await sb.from("message_reactions").select("*").eq("message_id", m.id);
      const container = document.getElementById("messages");
      const nearBottom = isNearBottom();

      const day = new Date(m.created_at).toDateString();
      if (day !== lastRenderedDay) {
        container.appendChild(buildDateDivider(m.created_at));
        lastRenderedDay = day;
      }
      container.appendChild(await renderMessage(m, reactions || []));

      if (m.user_id !== ME.id) clearTypingUser(m.user_id);

      if (nearBottom) {
        scrollToBottom();
      } else {
        showJumpToLatest();
      }

      if (m.user_id !== ME.id && document.hidden) {
        notifyNewMessage();
      }
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (payload) => {
      const m = payload.new;
      if (m.deleted) {
        const row = document.querySelector(`[data-msg-id="${m.id}"]`);
        if (row) row.remove();
      }
    })
    .subscribe();

  sb.channel("public:message_reactions")
    .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, async (payload) => {
      const messageId = payload.new?.message_id || payload.old?.message_id;
      if (!messageId) return;
      const row = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (!row) return;
      const { data: reactions } = await sb.from("message_reactions").select("*").eq("message_id", messageId);
      const reactRow = row.querySelector(".reactions-row");
      renderReactions(reactRow, messageId, reactions || []);
    })
    .subscribe();
}

function isNearBottom() {
  const c = document.getElementById("messages");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 160;
}
function scrollToBottom() {
  const c = document.getElementById("messages");
  c.scrollTop = c.scrollHeight;
}

function wireScrollTracking() {
  const container = document.getElementById("messages");
  container.addEventListener("scroll", () => {
    if (isNearBottom()) hideJumpToLatest();
  });
  document.getElementById("jumpToLatest").addEventListener("click", () => {
    scrollToBottom();
    hideJumpToLatest();
  });
}
function showJumpToLatest() {
  document.getElementById("jumpToLatest").classList.add("show");
}
function hideJumpToLatest() {
  document.getElementById("jumpToLatest").classList.remove("show");
}

function wireLightbox() {
  document.getElementById("lightbox").addEventListener("click", closeLightbox);
}
function openLightbox(src) {
  document.getElementById("lightboxImg").src = src;
  document.getElementById("lightbox").classList.add("show");
}
function closeLightbox() {
  document.getElementById("lightbox").classList.remove("show");
}

function notifyNewMessage() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(200);
}

function wireTypingBroadcast(input) {
  input.addEventListener("input", () => {
    if (!input.value.trim()) {
      sendTypingState(false);
      return;
    }
    sendTypingState(true);
    clearTimeout(typingClearTimer);
    typingClearTimer = setTimeout(() => sendTypingState(false), 2000);
  });
}

function sendTypingState(typing) {
  if (typing === isTypingBroadcasted) return;
  isTypingBroadcasted = typing;
  presenceChannel?.send({
    type: "broadcast",
    event: "typing",
    payload: { user_id: ME.id, display_name: ME.display_name, typing },
  });
}

function handleTypingBroadcast(payload) {
  if (payload.user_id === ME.id) return;
  if (payload.typing) {
    const existing = typingUsers.get(payload.user_id);
    if (existing) clearTimeout(existing.timeoutId);
    const timeoutId = setTimeout(() => clearTypingUser(payload.user_id), 4000);
    typingUsers.set(payload.user_id, { display_name: payload.display_name, timeoutId });
  } else {
    clearTypingUser(payload.user_id);
    return;
  }
  renderTypingIndicator();
}

function clearTypingUser(userId) {
  const existing = typingUsers.get(userId);
  if (!existing) return;
  clearTimeout(existing.timeoutId);
  typingUsers.delete(userId);
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  const names = [...typingUsers.values()].map(t => t.display_name);
  if (!names.length) {
    el.textContent = "";
    el.classList.remove("show");
    return;
  }
  const label = names.length === 1
    ? `${names[0]} is typing…`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing…`
      : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others are typing…`;
  el.textContent = label;
  el.classList.add("show");
}

function subscribePresence() {
  presenceChannel = sb.channel("teaofrpm-online", {
    config: { presence: { key: ME.id } },
  });

  presenceChannel
    .on("presence", { event: "sync" }, () => {
      const state = presenceChannel.presenceState();
      onlineMembers = new Map();
      Object.keys(state).forEach((userId) => {
        const info = state[userId][0];
        onlineMembers.set(userId, info);
      });
      renderMemberList();
    })
    .on("broadcast", { event: "typing" }, ({ payload }) => handleTypingBroadcast(payload))
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await presenceChannel.track({
          display_name: ME.display_name,
          role: ME.role,
          online_at: new Date().toISOString(),
        });
      }
    });

  window.addEventListener("beforeunload", () => {
    presenceChannel?.untrack();
  });
}

function renderMemberList() {
  const list = document.getElementById("memberList");
  const count = onlineMembers.size;
  document.getElementById("onlineCountText").textContent = `${count} online`;
  document.getElementById("headerOnlineText").textContent = `${count} online`;

  list.innerHTML = "";
  for (const [userId, info] of onlineMembers.entries()) {
    const row = document.createElement("div");
    row.className = `member-row ${userId === ME.id ? "you" : ""}`;
    const av = document.createElement("div");
    av.className = "avatar";
    av.style.background = colorFromName(info.display_name);
    av.style.width = "24px"; av.style.height = "24px"; av.style.fontSize = "10px";
    av.textContent = initials(info.display_name);
    row.appendChild(av);
    const name = document.createElement("span");
    name.textContent = info.display_name + (userId === ME.id ? " (you)" : "");
    row.appendChild(name);
    if (info.role === "owner") {
      const tag = document.createElement("span");
      tag.className = "owner-tag";
      tag.textContent = "OWNER";
      row.appendChild(tag);
    }
    list.appendChild(row);
  }
}

function wireHeader() {
  document.getElementById("logoutBtn").addEventListener("click", logoutUser);
  document.getElementById("menuToggle").addEventListener("click", () => {
    document.getElementById("membersPanel").classList.toggle("open");
  });
  document.getElementById("closeMembersPanel").addEventListener("click", () => {
    document.getElementById("membersPanel").classList.remove("open");
  });
  document.getElementById("loadMoreBtn").addEventListener("click", loadOlderMessages);
}

function wireSearch() {
  const toggle = document.getElementById("searchToggle");
  const panel = document.getElementById("searchPanel");
  const input = document.getElementById("searchInput");
  const results = document.getElementById("searchResults");

  toggle.addEventListener("click", () => {
    const isOpen = panel.classList.toggle("show");
    if (isOpen) {
      input.focus();
    } else {
      input.value = "";
      results.innerHTML = "";
    }
  });

  input.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    const term = input.value.trim();
    if (!term) { results.innerHTML = ""; return; }
    searchDebounceTimer = setTimeout(() => runMessageSearch(term), 350);
  });
}

async function runMessageSearch(term) {
  const results = document.getElementById("searchResults");
  results.innerHTML = `<div class="search-hint">Searching…</div>`;

  const { data, error } = await sb
    .from("messages")
    .select("*")
    .eq("deleted", false)
    .ilike("content", `%${term}%`)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    results.innerHTML = `<div class="search-hint">Search failed.</div>`;
    return;
  }
  if (!data.length) {
    results.innerHTML = `<div class="search-hint">No messages found.</div>`;
    return;
  }

  const ids = [...new Set(data.map(m => m.user_id))];
  await Promise.all(ids.map(getProfile));

  results.innerHTML = "";
  for (const m of data) {
    const author = await getProfile(m.user_id);
    const row = document.createElement("div");
    row.className = "search-result-row";

    const av = document.createElement("div");
    av.className = "avatar";
    av.style.background = colorFromName(author?.display_name || "?");
    av.style.width = "26px"; av.style.height = "26px"; av.style.fontSize = "10px";
    av.textContent = initials(author?.display_name);
    row.appendChild(av);

    const text = document.createElement("div");
    text.className = "search-result-text";
    text.innerHTML = `<b>${escapeHTML(author?.display_name || "Unknown")}</b> · <span>${formatTime(m.created_at)}</span><br>${escapeHTML(m.content)}`;
    row.appendChild(text);

    results.appendChild(row);
  }
}

init();