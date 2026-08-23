/**
 * Kapruka AI Shopping Assistant — Chat Frontend
 *
 * Connects to POST /chat (LangGraph backend).
 * Parses reply.messages[] to extract AI text and tool artifacts.
 * Renders interactive product cards from structured tool data.
 */

// ── Config ──────────────────────────────────────────────────────────────────
// Toggle between local and production backends by commenting/uncommenting:
// const BACKEND_URL = "http://0.0.0.0:8001"; 
// const BACKEND_URL = "http://localhost:8001"; // ← LOCAL
// const BACKEND_URL = "https://kaprukaaiagent-production.up.railway.app";           // ← PROD
const BACKEND_URL = "";   // ← PROD2
const CHAT_ENDPOINT = `${BACKEND_URL}/chat`;
const HEALTH_ENDPOINT = `${BACKEND_URL}/health`;
const REQUEST_TIMEOUT_MS = 120_000;
// ── State ───────────────────────────────────────────────────────────────────
// Get or create persistent User ID
let userId = localStorage.getItem("kapruka_user_id");

if (!userId) {
  userId = crypto.randomUUID();
  localStorage.setItem("kapruka_user_id", userId);
}

// Get or create session-specific Thread ID
let threadId = sessionStorage.getItem("kapruka_thread_id");
if (!threadId) {
  threadId = crypto.randomUUID();
  sessionStorage.setItem("kapruka_thread_id", threadId);
}

let messages = []; // { role: "user"|"assistant", content: string }
let isStreaming = false;
let abortController = null;

// Floating Cards State (must be at top — used before definition otherwise)
let dynamicFloatingProducts = [];
let floatingCardInterval = null;
const floatingCardTransforms = [
  "translate3d(-400px, -240px, -80px) rotateX(12deg) rotateY(22deg) rotateZ(-8deg)",   // top-left
  "translate3d(400px,  -220px, -30px) rotateX(-8deg) rotateY(-18deg) rotateZ(12deg)",  // top-right
  "translate3d(-420px,  -60px,  30px) rotateX(18deg) rotateY(12deg) rotateZ(-4deg)",   // mid-left
  "translate3d(420px,   -40px,  60px) rotateX(-12deg) rotateY(-8deg) rotateZ(4deg)",   // mid-right
  "translate3d(-360px,  120px, -120px) rotateX(8deg) rotateY(4deg) rotateZ(16deg)",    // bottom-left
  "translate3d(360px,   110px,  -60px) rotateX(-20deg) rotateY(12deg) rotateZ(-8deg)"  // bottom-right
];

// Cart State
let currentCart = null; // Stores the latest cart_summary card

// ── Cart DOM references ─────────────────────────────────────────────────────
const cartDrawer = document.getElementById("cart-drawer");
const cartOverlay = document.getElementById("cart-overlay");
const cartItemsContainer = document.getElementById("cart-items-container");
const cartTotalDisplay = document.getElementById("cart-total-display");
const cartCheckoutBtn = document.getElementById("checkout-btn");

function openCart() {
  if (cartDrawer) cartDrawer.classList.add("open");
  if (cartOverlay) cartOverlay.classList.add("active");
  renderCartDrawer();
}

function closeCart() {
  if (cartDrawer) cartDrawer.classList.remove("open");
  if (cartOverlay) cartOverlay.classList.remove("active");
}

// Ensure overlay clicks close cart
if (cartOverlay) {
  cartOverlay.addEventListener("click", closeCart);
}

// ── DOM references ──────────────────────────────────────────────────────────
const chatContainer = document.getElementById("chat-container");
const chatInput = document.getElementById("chat-input");
const chatForm = document.getElementById("chat-form");
const sendBtn = document.getElementById("send-btn");
const welcomeEl = document.getElementById("welcome");
const sessionIdDisplay = document.getElementById("session-id-display");
const msgCountDisplay = document.getElementById("msg-count");
const healthStatusEl = document.getElementById("health-status");
const topBarStatusEl = document.getElementById("top-bar-status");

const KAVI_SVG_HTML = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="kavi-svg-avatar kavi-state-idle">
  <defs>
    <!-- Deep 3D Purple Sphere Gradient -->
    <radialGradient id="kaviFace" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#805ad5" />
      <stop offset="40%" stop-color="#5b3d99" />
      <stop offset="100%" stop-color="#2d1b5e" />
    </radialGradient>
    
    <!-- Premium Yellow Accent -->
    <linearGradient id="kaviYellow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffe600" />
      <stop offset="100%" stop-color="#f8da08" />
    </linearGradient>
    
    <!-- Dark Headset Plastic -->
    <linearGradient id="kaviHeadset" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4a317a" />
      <stop offset="100%" stop-color="#1f1140" />
    </linearGradient>

    <!-- Glossy Reflection for 3D realism -->
    <linearGradient id="kaviGloss" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.7)" />
      <stop offset="100%" stop-color="rgba(255,255,255,0)" />
    </linearGradient>

    <!-- Base Drop Shadow -->
    <filter id="kaviShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.25"/>
    </filter>
  </defs>

  <!-- Left Earcup -->
  <rect x="6" y="38" width="16" height="34" rx="8" fill="url(#kaviYellow)" filter="url(#kaviShadow)" />
  <rect x="2" y="41" width="14" height="28" rx="7" fill="url(#kaviHeadset)" />

  <!-- Right Earcup -->
  <rect x="78" y="38" width="16" height="34" rx="8" fill="url(#kaviYellow)" filter="url(#kaviShadow)" />
  <rect x="84" y="41" width="14" height="28" rx="7" fill="url(#kaviHeadset)" />

  <!-- Headband Connecting Earcups -->
  <path d="M 10 45 A 40.3 40.3 0 0 1 90 45" fill="none" stroke="url(#kaviHeadset)" stroke-width="6" stroke-linecap="round" />
  
  <!-- Top Headset Nub -->
  <path d="M 40 10 Q 50 6 60 10 L 58 18 L 42 18 Z" fill="url(#kaviYellow)" />
  <path d="M 43 8 Q 50 4 57 8 L 55 16 L 45 16 Z" fill="url(#kaviHeadset)" />

  <!-- Main Face Sphere -->
  <circle cx="50" cy="50" r="38" fill="url(#kaviFace)" filter="url(#kaviShadow)" />
  
  <!-- Glossy 3D Highlight -->
  <ellipse class="kavi-gloss" cx="38" cy="32" rx="22" ry="12" transform="rotate(-35 38 32)" fill="url(#kaviGloss)" />
  
  <!-- Scratch Accents (Top Right & Bottom Left) -->
  <line x1="68" y1="32" x2="78" y2="24" stroke="rgba(255,255,255,0.25)" stroke-width="1.5" stroke-linecap="round" />
  <line x1="71" y1="38" x2="80" y2="31" stroke="rgba(255,255,255,0.25)" stroke-width="1.5" stroke-linecap="round" />
  <line x1="28" y1="72" x2="20" y2="78" stroke="rgba(0,0,0,0.15)" stroke-width="1.5" stroke-linecap="round" />

  <!-- The Signature Smile -->
  <path class="kavi-smile" d="M 30 56 Q 50 78 70 56" fill="none" stroke="url(#kaviYellow)" stroke-width="6.5" stroke-linecap="round" filter="url(#kaviShadow)" />

  <!-- Microphone Boom (Extends from right earcup) -->
  <path d="M 85 65 Q 92 82 74 86" fill="none" stroke="url(#kaviHeadset)" stroke-width="4.5" stroke-linecap="round" filter="url(#kaviShadow)" />
  
  <!-- Mic Capsule & Active LED -->
  <rect class="kavi-mic-capsule" x="66" y="83" width="10" height="6" rx="3" fill="url(#kaviHeadset)" transform="rotate(15 71 86)" />
  <circle class="kavi-mic-led" cx="69" cy="86" r="1.5" fill="#374151" transform="rotate(15 71 86)" />
</svg>
`;

function setAvatarState(state) {
  const avatars = document.querySelectorAll('.kavi-svg-avatar');
  avatars.forEach(avatar => {
    avatar.classList.remove('kavi-state-idle', 'kavi-state-thinking', 'kavi-state-typing');
    if (state === 'thinking') avatar.classList.add('kavi-state-thinking');
    else if (state === 'talking') avatar.classList.add('kavi-state-typing');
    else avatar.classList.add('kavi-state-idle');
  });
}
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");

// ── Init ────────────────────────────────────────────────────────────────────
updateSessionDisplay();
if (typeof renderFloatingCards === 'function') renderFloatingCards();

// Auto-resize textarea
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
});

// Enter to send (Shift+Enter for newline)
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming && chatInput.value.trim()) {
      handleSubmit(e);
    }
  }
});

// ── Placeholder Typing Effect ────────────────────────────────────────────────
const placeholderSuggestions = [
  "Ask about products, delivery, or orders…",
  "Can you find me a birthday cake?",
  "Track my recent order",
  "Show me electronics under 10000 LKR",
  "I want to send a gift to my friend",
  "What's in my cart? Any recommendations?"
];
let phSuggestionIndex = 0;
let phCharIndex = 0;
let phIsDeleting = false;
let phTypingTimeout = null;
let phIsTypingActive = true;
let phHasSentMessage = false;

function typePlaceholder() {
  if (!phIsTypingActive || phHasSentMessage) return;

  const currentSuggestion = placeholderSuggestions[phSuggestionIndex];

  if (phIsDeleting) {
    chatInput.setAttribute("placeholder", currentSuggestion.substring(0, phCharIndex - 1) + "|");
    phCharIndex--;
  } else {
    chatInput.setAttribute("placeholder", currentSuggestion.substring(0, phCharIndex + 1) + "|");
    phCharIndex++;
  }

  let typingSpeed = 60;
  if (phIsDeleting) typingSpeed = 30;

  if (!phIsDeleting && phCharIndex === currentSuggestion.length) {
    typingSpeed = 2500; // pause at the end
    phIsDeleting = true;
  } else if (phIsDeleting && phCharIndex === 0) {
    phIsDeleting = false;
    phSuggestionIndex = (phSuggestionIndex + 1) % placeholderSuggestions.length;
    typingSpeed = 500; // pause before next typing
  }

  phTypingTimeout = setTimeout(typePlaceholder, typingSpeed);
}

chatInput.addEventListener('focus', () => {
  if (phHasSentMessage) return;
  phIsTypingActive = false;
  clearTimeout(phTypingTimeout);
  chatInput.setAttribute("placeholder", "Type your message...");
});

chatInput.addEventListener('blur', () => {
  if (phHasSentMessage) return;
  if (!chatInput.value.trim()) {
    phIsTypingActive = true;
    phIsDeleting = false;
    phCharIndex = 0;
    typePlaceholder();
  }
});

// Start animation initially
typePlaceholder();

// ── Sidebar Toggle ──────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebar.classList.toggle("open");
  sidebarOverlay.classList.toggle("active");
}

// ── Session Management ──────────────────────────────────────────────────────
function updateSessionDisplay() {
  if (sessionIdDisplay) sessionIdDisplay.textContent = `ID: ${threadId.slice(0, 8)}…`;
  if (msgCountDisplay) msgCountDisplay.textContent = `${messages.length} messages`;
}

function clearConversation() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  isStreaming = false;
  updateSendButton();

  phHasSentMessage = false;
  phIsTypingActive = true;
  phIsDeleting = false;
  phCharIndex = 0;
  clearTimeout(phTypingTimeout);
  typePlaceholder();

  messages = [];
  threadId = crypto.randomUUID();
  sessionStorage.setItem("kapruka_thread_id", threadId);

  chatContainer.innerHTML = "";

  // Re-add welcome card
  chatContainer.innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-card">
        <div class="welcome-icon">
          <div class="welcome-icon-ring"></div>
          ${KAVI_SVG_HTML}
        </div>
        <h1 class="welcome-title">
          <span id="typewriter-prefix"></span><span id="typewriter-name" class="gradient-text"></span><span class="typewriter-cursor"></span>
        </h1>
        <p class="welcome-subtitle">Your Kapruka Shopping Assistant</p>
        <p class="welcome-body">
          Your AI shopping assistant for <strong>Kapruka.com</strong>. Ask me to find anything from our entire catalog!
        </p>
        <div class="welcome-chips-container">
          <div class="welcome-chips">
            <button class="welcome-chip" onclick="sendQuickAction('Show me birthday cakes')"><span class="chip-icon">🎂</span> <span class="chip-label">Cakes</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('What flower bouquets do you have?')"><span class="chip-icon">🌸</span> <span class="chip-label">Flowers</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Search for chocolates')"><span class="chip-icon">🍫</span> <span class="chip-label">Chocolates</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Browse gift categories on Kapruka')"><span class="chip-icon">🎁</span> <span class="chip-label">Gifts</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Order fresh groceries')"><span class="chip-icon">🍎</span> <span class="chip-label">Groceries</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Show me some books')"><span class="chip-icon">📚</span> <span class="chip-label">Books</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Look for electronics')"><span class="chip-icon">📱</span> <span class="chip-label">Electronics</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Order food delivery')"><span class="chip-icon">🍔</span> <span class="chip-label">Food</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Which cities does Kapruka deliver to?')"><span class="chip-icon">🚚</span> <span class="chip-label">Delivery</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('I would like to track my order')"><span class="chip-icon">📦</span> <span class="chip-label">Track Order</span></button>

            <button class="welcome-chip" onclick="sendQuickAction('Show me birthday cakes')"><span class="chip-icon">🎂</span> <span class="chip-label">Cakes</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('What flower bouquets do you have?')"><span class="chip-icon">🌸</span> <span class="chip-label">Flowers</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Search for chocolates')"><span class="chip-icon">🍫</span> <span class="chip-label">Chocolates</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Browse gift categories on Kapruka')"><span class="chip-icon">🎁</span> <span class="chip-label">Gifts</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Order fresh groceries')"><span class="chip-icon">🍎</span> <span class="chip-label">Groceries</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Show me some books')"><span class="chip-icon">📚</span> <span class="chip-label">Books</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Look for electronics')"><span class="chip-icon">📱</span> <span class="chip-label">Electronics</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Order food delivery')"><span class="chip-icon">🍔</span> <span class="chip-label">Food</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('Which cities does Kapruka deliver to?')"><span class="chip-icon">🚚</span> <span class="chip-label">Delivery</span></button>
            <button class="welcome-chip" onclick="sendQuickAction('I would like to track my order')"><span class="chip-icon">📦</span> <span class="chip-label">Track Order</span></button>
          </div>
        </div>
      </div>
    </div>
  `;
  typeWelcomeTitle();
  updateSessionDisplay();
  if (typeof resetFloatingCards === 'function') resetFloatingCards();
}

// ── Health Check ────────────────────────────────────────────────────────────
async function checkHealth() {
  const btn = document.getElementById("btn-health");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin-icon"><circle cx="12" cy="12" r="10" stroke-dasharray="30" stroke-dashoffset="10"/></svg></span> Checking…';
  }

  try {
    const res = await fetch(HEALTH_ENDPOINT, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (healthStatusEl) {
        healthStatusEl.innerHTML = `
          <span class="status-badge status-ok">● Online — ${data.model || ""}</span>
          <span class="status-caption">Sessions: ${data.active_sessions || 0}</span>
        `;
      }
      if (topBarStatusEl) topBarStatusEl.innerHTML = '<span class="status-dot status-dot-online"></span><span class="status-text">Online</span>';
    } else {
      throw new Error("Non-200 response");
    }
  } catch {
    if (healthStatusEl) {
      healthStatusEl.innerHTML =
        '<span class="status-badge status-err">● Backend unreachable</span>';
    }
    if (topBarStatusEl) topBarStatusEl.innerHTML = '<span class="status-dot status-dot-offline"></span><span class="status-text">Offline</span>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span> Check Backend';
    }
  }
}

// ── Quick Actions ───────────────────────────────────────────────────────────
function sendQuickAction(prompt, hiddenPayload) {
  if (isStreaming) return;
  if (window.isKiteAnimating) return;

  if (hiddenPayload) {
    if (typeof closeReorderPopup === 'function') closeReorderPopup();

    phHasSentMessage = true;
    clearTimeout(phTypingTimeout);
    chatInput.setAttribute("placeholder", "Ask about products, delivery, or orders…");
    chatInput.value = "";
    chatInput.style.height = "auto";

    const welcome = document.getElementById("welcome");
    if (welcome) welcome.remove();

    if (typeof clearFloatingCards === 'function') clearFloatingCards();

    addUserMessage(prompt);

    const svg = sendBtn.querySelector("svg");
    if (svg && !sendBtn.classList.contains("streaming")) {
      window.isKiteAnimating = true;
      svg.classList.add("fly-kite-anim");
      setTimeout(() => {
        window.isKiteAnimating = false;
        sendRequest(hiddenPayload);
      }, 400);
    } else {
      sendRequest(hiddenPayload);
    }
  } else {
    chatInput.value = prompt;
    handleSubmit(new Event("submit"));
  }

  // Close sidebar on mobile
  if (window.innerWidth <= 768) {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.remove("active");
  }
}

// ── Send Button State ───────────────────────────────────────────────────────
function updateSendButton() {
  if (isStreaming) {
    sendBtn.classList.add("streaming");
    sendBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>
    `;
    sendBtn.title = "Stop generating";
    sendBtn.disabled = false;
  } else {
    sendBtn.classList.remove("streaming");
    sendBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
    `;
    sendBtn.title = "Send";
    sendBtn.disabled = false;
  }
}

// ── Form Submit ─────────────────────────────────────────────────────────────
function handleSubmit(e) {
  e.preventDefault();

  if (window.isKiteAnimating) return;

  if (isStreaming) {
    if (abortController) abortController.abort();
    return;
  }

  const text = chatInput.value.trim();
  if (!text) return;

  // Hide the reorder popup if it's visible when starting to chat
  if (typeof closeReorderPopup === 'function') closeReorderPopup();


  phHasSentMessage = true;
  clearTimeout(phTypingTimeout);
  chatInput.setAttribute("placeholder", "Ask about products, delivery, or orders…");

  chatInput.value = "";
  chatInput.style.height = "auto";

  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();

  if (typeof clearFloatingCards === 'function') clearFloatingCards();

  addUserMessage(text);

  const svg = sendBtn.querySelector("svg");
  if (svg && !sendBtn.classList.contains("streaming")) {
    window.isKiteAnimating = true;
    svg.classList.add("fly-kite-anim");
    setTimeout(() => {
      window.isKiteAnimating = false;
      sendRequest(text);
    }, 400);
  } else {
    sendRequest(text);
  }
}

// ── Add User Message ────────────────────────────────────────────────────────
function addUserMessage(text) {
  messages.push({ role: "user", content: text });
  updateSessionDisplay();

  // Remove sending-active from any previous messages
  document.querySelectorAll(".message-user.sending-active").forEach(el => {
    el.classList.remove("sending-active");
  });

  const msgEl = document.createElement("div");
  msgEl.className = "message message-user message-enter sending-active";

  msgEl.innerHTML = `
    <div class="message-avatar" style="background: #EDE7F6; color: #5B21B6; border-radius: 50%;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
    </div>
    <div class="message-content" style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
      <div class="message-bubble">${escapeHtml(text)}</div>
    </div>
  `;
  chatContainer.appendChild(msgEl);
  scrollToBottom(true);

  // Remove the glowing circle after a couple of seconds
  setTimeout(() => {
    msgEl.classList.remove("sending-active");
  }, 2000);
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING — LangGraph message format
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract text from a message's content field.
 * Content can be either a plain string OR an array of content blocks
 * like [{ type: "text", text: "..." }, ...].
 */
function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text);
    if (textParts.length > 0) return textParts.join("\n");
  }
  return String(content);
}

/**
 * Extract the assistant's text reply from LangGraph messages.
 * Finds the LAST ai message and extracts text content.
 */
function extractAIReply(messagesArr) {
  // Walk backwards to find the last AI message
  for (let i = messagesArr.length - 1; i >= 0; i--) {
    const msg = messagesArr[i];
    if (msg.type !== "ai") continue;

    // Content can be a string or array of content blocks
    if (typeof msg.content === "string" && msg.content) {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text);
      if (textParts.length > 0) return textParts.join("\n");
    }
  }
  return "";
}

/**
 * Extract structured product data from tool message artifacts.
 * Returns an array of product objects found in any tool results.
 */
function extractProducts(messagesArr) {
  const products = [];

  for (const msg of messagesArr) {
    if (msg.type !== "tool") continue;

    // Check artifact.structured_content.result
    const artifact = msg.artifact;
    if (!artifact?.structured_content?.result) continue;

    let resultData = artifact.structured_content.result;

    // result might be a JSON string — try to parse it
    if (typeof resultData === "string") {
      try {
        resultData = JSON.parse(resultData);
      } catch {
        continue;
      }
    }

    // Look for results array (search results format)
    if (resultData.results && Array.isArray(resultData.results)) {
      for (const p of resultData.results) {
        if (p.name && p.price) {
          products.push({
            id: p.id || "",
            name: p.name || "",
            price: p.price?.amount || p.price || 0,
            currency: p.price?.currency || "LKR",
            image: p.image_url || "",
            url: p.url || "",
            inStock: p.in_stock !== false,
            stockLevel: p.stock_level || "",
            category: p.category?.name || "",
            shipsInternationally: p.ships_internationally || false,
          });
        }
      }
    }

    // Single product detail format
    if (resultData.name && resultData.price && !resultData.results) {
      products.push({
        id: resultData.id || "",
        name: resultData.name || "",
        price: resultData.price?.amount || resultData.price || 0,
        currency: resultData.price?.currency || "LKR",
        image: resultData.image_url || "",
        url: resultData.url || "",
        inStock: resultData.in_stock !== false,
        stockLevel: resultData.stock_level || "",
        category: resultData.category?.name || "",
        shipsInternationally: resultData.ships_internationally || false,
      });
    }
  }

  return products;
}

/**
 * Extract which tools were called and their names (for UI indicators).
 */
function extractToolCalls(messagesArr) {
  const calls = [];
  for (const msg of messagesArr) {
    if (msg.type === "ai" && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        calls.push(tc.name);
      }
    }
  }
  return calls;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT RENDERERS — Interactive UI inside chat
// ═══════════════════════════════════════════════════════════════════════════

function formatPrice(amount, currency = "LKR") {
  if (!amount) return "";
  return `${currency} ${Number(amount).toLocaleString()}`;
}

function generateImageCarouselHtml(images, altName) {
  if (!images || images.length === 0) {
    return `<div class="product-image-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg></div>`;
  }

  if (images.length === 1) {
    const displayImage = images[0];
    return `<div class="image-loading-spinner"></div>
            <img src="${escapeHtml(displayImage.startsWith('//') ? 'https:' + displayImage : displayImage)}" alt="${altName}" class="product-image" loading="lazy"
                 onload="this.previousElementSibling.style.display='none';"
                 onerror="this.previousElementSibling.style.display='none'; this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div class="product-image-placeholder" style="display: none;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg></div>`;
  }

  const slides = images.map((img, i) => `
    <div class="carousel-slide">
      <div class="image-loading-spinner"></div>
      <img src="${escapeHtml(img.startsWith('//') ? 'https:' + img : img)}" alt="${altName} ${i + 1}" class="product-image" loading="lazy"
           onload="this.previousElementSibling.style.display='none';"
           onerror="this.previousElementSibling.style.display='none'; this.style.display='none'; this.nextElementSibling.style.display='flex';" />
      <div class="product-image-placeholder" style="display: none;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg></div>
    </div>
  `).join('');

  return `
    <div class="image-carousel-container">
      <div class="image-carousel-track" onscroll="
        const scrollLeft = this.scrollLeft;
        const width = this.clientWidth;
        if(width > 0) {
          const activeIndex = Math.round(scrollLeft / width);
          const dots = this.parentElement.querySelectorAll('.carousel-dot');
          dots.forEach((dot, index) => {
            if (index === activeIndex) {
              dot.classList.add('active');
            } else {
              dot.classList.remove('active');
            }
          });
        }
      ">
        ${slides}
      </div>
      <button class="carousel-arrow left-arrow" onclick="event.stopPropagation(); this.parentElement.querySelector('.image-carousel-track').scrollBy({left: -this.parentElement.clientWidth, behavior: 'smooth'})">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      </button>
      <button class="carousel-arrow right-arrow" onclick="event.stopPropagation(); this.parentElement.querySelector('.image-carousel-track').scrollBy({left: this.parentElement.clientWidth, behavior: 'smooth'})">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </button>
      <div class="carousel-dots">
        ${images.map((_, i) => `<div class="carousel-dot ${i === 0 ? 'active' : ''}"></div>`).join('')}
      </div>
    </div>
  `;
}

/**
 * Render a horizontal carousel of interactive product cards.
 * Each card has: image, badges, price, and 4 action buttons.
 * Field names match the backend's ProductCard schema (snake_case).
 */
function renderProductCards(products) {
  if (!products.length) return "";

  if (typeof updateFindMeContext === 'function') {
    updateFindMeContext(products);
  }

  const cards = products.map((p, idx) => {
    const priceStr = formatPrice(p.price, p.currency);
    const isInStock = p.in_stock !== false; // default true per backend schema
    const stockBadge = isInStock
      ? `<span class="stock-badge in-stock"><span class="stock-dot"></span>In Stock</span>`
      : `<span class="stock-badge out-of-stock"><span class="stock-dot"></span>Out of Stock</span>`;
    const safeId = p.product_id || `prod-${idx}`;
    const escapedName = escapeHtml(p.name || "");
    // safe version for use inside onclick single-quote context
    const safeNameForAttr = (p.name || "").replace(/"/g, '&quot;').replace(/'/g, '\\&#39;');

    const images = (p.images && p.images.length > 0) ? p.images : (p.image_url ? [p.image_url] : []);
    const imagesHtml = generateImageCarouselHtml(images, escapedName);

    return `
      <div class="product-card ${products.length === 1 ? 'single-product-card' : ''}" id="card-${safeId}">
        <div class="product-image-wrap" onclick="viewProductDetails('${safeId}', this)" style="cursor: pointer;">
          ${imagesHtml}
          ${stockBadge}
        </div>
        <div class="product-info">
          <h4 class="product-name">${escapedName}</h4>
          <div class="product-price-row">
            <div class="product-price">${priceStr}</div>
            ${p.compare_at_price ? `<div class="product-compare-price">${formatPrice(p.compare_at_price, p.currency)}</div>` : ""}
          </div>
          <div class="product-actions">
            <button class="pcard-btn pcard-btn-ghost"
              onclick="viewProductDetails('${safeId}', this)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
              Choose this
            </button>
            <button class="pcard-btn pcard-btn-ghost pcard-btn-share"
              onclick="shareProduct('${escapedName}', '${p.url ? escapeHtml(p.url) : ''}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>
              Share
            </button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  const count = products.length;
  return `
    <div class="product-cards-container" style="position: relative;">
      <div class="product-cards-header">
        <span class="product-cards-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: middle; position: relative; top: -1px;"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>${count} product${count !== 1 ? "s" : ""} suggested</span>
      </div>
      <div class="product-carousel" onscroll="const hint = this.parentNode.querySelector('.carousel-scroll-hint'); if(hint && this.scrollLeft > 40) { hint.style.opacity = '0'; }">${cards}</div>
      ${count > 1 ? `
      <div class="carousel-scroll-hint" style="position: absolute; right: 8px; top: 55%; transform: translateY(-50%); width: 36px; height: 36px; background: white; border: 1px solid rgba(139, 92, 246, 0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(64, 41, 112, 0.15); z-index: 10; pointer-events: none; transition: opacity 0.3s ease; animation: bounceHorizontal 1.5s infinite;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="margin-left: 2px;"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </div>` : ''}
    </div>
  `;
}

/**
 * Share a product URL using the Web Share API or fallback to clipboard.
 */
// Helpers removed; detail cards now render direct add-to-cart buttons per variant

function renderProductDetailCards(cards) {
  if (!cards || !cards.length) return "";

  const cardsHtml = cards.map(c => {
    const safeId = c.product_id;
    const escapedName = escapeHtml(c.name || "");
    const basePrice = c.price || 0;
    const currency = escapeHtml(c.currency || "LKR");

    // Images
    const images = c.images && c.images.length > 0 ? c.images : (c.image_url ? [c.image_url] : []);
    const imagesHtml = generateImageCarouselHtml(images, escapedName);

    // Variants
    let variantsHtml = '';
    let defaultVariantId = safeId;
    let defaultPrice = basePrice;
    let hasVariants = c.variants && c.variants.length > 0;

    const safeBaseNameForAttr = escapedName.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    if (hasVariants) {
      const optionsHtml = c.variants.map((v) => {
        const vId = escapeHtml(v.id);
        const vName = escapeHtml(v.name);
        const vPrice = v.price || basePrice;
        const synName = `${escapedName} (${vName})`;
        const safeSynName = synName.replace(/"/g, '&quot;').replace(/'/g, '\\&#39;');
        const isVariantInStock = v.in_stock !== false;
        const qtyId = `qty-${safeId}-${v.id.replace(/[^a-zA-Z0-9]/g, '_')}`;

        let displayVName = vName;
        if (v.attributes && v.attributes.color) {
          const colorHex = escapeHtml(v.attributes.color);
          // Strip the exact hex code from the display string if it's there
          let cleanedName = displayVName.replace(new RegExp(colorHex, 'i'), '').trim();
          // Remove any dangling slashes, dashes, or spaces left behind (e.g. " / XL" -> "XL")
          cleanedName = cleanedName.replace(/^[ \/\-]+|[ \/\-]+$/g, '').trim();

          const dotHtml = `<span style="display:inline-block; width:14px; height:14px; border-radius:50%; background-color:${colorHex}; border:1px solid rgba(0,0,0,0.15); flex-shrink:0;"></span>`;
          displayVName = cleanedName ? `${dotHtml} <span style="margin-left:4px;">${cleanedName}</span>` : dotHtml;
        } else {
          // Fallback if the color attribute isn't present but it still has a hex string
          displayVName = displayVName.replace(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/i, (match) => {
            return `<span style="display:inline-block; width:14px; height:14px; border-radius:50%; background-color:${match}; border:1px solid rgba(0,0,0,0.15); flex-shrink:0;"></span>`;
          });
        }

        const btnHtml = isVariantInStock
          ? `<div style="display: flex; align-items: stretch; gap: 8px;">
               <div style="display: flex; align-items: center; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; background: #fff;">
                 <button onclick="const i=document.getElementById('${qtyId}'); i.value=Math.max(1, parseInt(i.value)-1)" style="width: 28px; background: #f5f5f5; border: none; border-right: 1px solid #ddd; cursor: pointer; color: #333; font-weight: bold;">-</button>
                 <input type="text" id="${qtyId}" value="1" readonly style="width: 30px; text-align: center; border: none; font-size: 0.85rem; padding: 0; outline: none; background: #fff; color: #333;">
                 <button onclick="const i=document.getElementById('${qtyId}'); i.value=parseInt(i.value)+1" style="width: 28px; background: #f5f5f5; border: none; border-left: 1px solid #ddd; cursor: pointer; color: #333; font-weight: bold;">+</button>
               </div>
               <button class="pcard-btn pcard-btn-primary" onclick="addToCartDirect('${vId}', '${safeSynName}', parseInt(document.getElementById('${qtyId}').value), ${vPrice}, '${currency}', '${escapeHtml(images[0] || "")}')" style="padding: 6px 14px; font-size: 0.85rem; height: auto;">
                 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>
                 Add
               </button>
             </div>`
          : `<button class="pcard-btn" disabled style="padding: 6px 14px; font-size: 0.85rem; height: auto; background: #e0e0e0; color: #888; border: none; cursor: not-allowed;">
              Out of Stock
            </button>`;

        return `
          <div class="variant-row" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border: 1px solid #eee; border-radius: 8px; margin-bottom: 8px; background: #fafafa; ${!isVariantInStock ? 'opacity: 0.6;' : ''}">
            <div class="variant-info" style="flex: 1; text-align: left;">
              <div class="variant-name" style="font-weight: 600; font-size: 0.9rem; color: #333; display: flex; align-items: center; gap: 4px;">${displayVName}</div>
              <div class="variant-price" style="color: var(--accent-dark, #8a7a00); font-size: 0.85rem;">${formatPrice(vPrice, currency)}</div>
            </div>
            ${btnHtml}
          </div>
        `;
      }).join('');

      variantsHtml = `
        <div class="product-variants-list" style="margin-top: 16px;">
          <h5 style="margin-bottom: 10px; font-size: 0.9rem; color: #555; text-align: left;">Select an Option</h5>
          ${optionsHtml}
        </div>
      `;
    } else {
      const isBaseInStock = c.in_stock !== false;
      const baseQtyId = `qty-base-${safeId}`;
      const baseBtnHtml = isBaseInStock
        ? `<div style="display: flex; align-items: stretch; gap: 8px; width: 100%;">
             <div style="display: flex; align-items: center; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; background: #fff;">
               <button onclick="const i=document.getElementById('${baseQtyId}'); i.value=Math.max(1, parseInt(i.value)-1)" style="width: 36px; background: #f5f5f5; border: none; border-right: 1px solid #ddd; cursor: pointer; color: #333; font-weight: bold; font-size: 0.95rem;">-</button>
               <input type="text" id="${baseQtyId}" value="1" readonly style="width: 40px; text-align: center; border: none; font-size: 1rem; padding: 0; outline: none; background: #fff; color: #333;">
               <button onclick="const i=document.getElementById('${baseQtyId}'); i.value=parseInt(i.value)+1" style="width: 36px; background: #f5f5f5; border: none; border-left: 1px solid #ddd; cursor: pointer; color: #333; font-weight: bold; font-size: 0.95rem;">+</button>
             </div>
             <button class="pcard-btn pcard-btn-primary" onclick="addToCartDirect('${safeId}', '${safeBaseNameForAttr}', parseInt(document.getElementById('${baseQtyId}').value), ${basePrice}, '${currency}', '${escapeHtml(images[0] || "")}')" style="flex: 1; justify-content:center;">
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>
               Add to Cart
             </button>
           </div>`
        : `<button class="pcard-btn" disabled style="width:100%; justify-content:center; background: #e0e0e0; color: #888; border: none; cursor: not-allowed;">
            Out of Stock
          </button>`;

      variantsHtml = `
        <div class="product-price-row">
          <div class="product-price">${formatPrice(basePrice, currency)}</div>
        </div>
        <div class="product-actions" style="margin-top: 12px;">
          ${baseBtnHtml}
        </div>
      `;
    }

    return `
      <div class="product-card product-detail-card single-product-card" id="detail-card-${safeId}" data-base-id="${safeId}">
        <div class="product-image-wrap" style="overflow:hidden;">
          ${imagesHtml}
        </div>
        <div class="product-info">
          <h4 class="product-name">${escapedName}</h4>
          ${c.summary ? `<p class="product-summary" style="font-size:0.85em; color:#666; margin-bottom:8px;">${escapeHtml(c.summary)}</p>` : ''}
          ${variantsHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="product-cards-container">
      <div class="product-carousel" style="flex-direction: column;">${cardsHtml}</div>
    </div>
  `;
}
function shareProduct(name, url) {
  const shareData = {
    title: name,
    text: `Check out ${name} on Kapruka.com`,
    url: url || "https://kapruka.com",
  };
  if (navigator.share) {
    navigator.share(shareData).catch(() => { });
  } else {
    navigator.clipboard.writeText(shareData.url || shareData.text).then(() => {
      showToast("Link copied to clipboard!");
    }).catch(() => {
      showToast("Share: " + (url || "https://kapruka.com"));
    });
  }
}

/**
 * Show a brief toast notification.
 * @param {string} message - The message to display
 * @param {'success'|'error'|'info'} type - Visual type
 * @param {string} icon - Optional emoji icon
 */
function showToast(message, type = "success", icon = "") {
  // Remove any existing toast
  const existing = document.getElementById("kavi-toast");
  if (existing) {
    existing.classList.remove("kavi-toast-visible");
    setTimeout(() => existing.remove(), 150);
  }

  const toast = document.createElement("div");
  toast.id = "kavi-toast";
  toast.className = `kavi-toast kavi-toast-${type}`;
  if (icon === "✅") {
    icon = `<img src="icons8-tick-100.gif?t=${Date.now()}" style="width: 24px; height: 24px; vertical-align: middle; margin-top: -2px;" alt="Success" />`;
  }

  toast.innerHTML = icon
    ? `<span class="kavi-toast-icon" style="display: flex; align-items: center;">${icon}</span><span>${message}</span>`
    : `<span>${message}</span>`;

  document.body.appendChild(toast);
  // Double rAF ensures transition fires after paint
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("kavi-toast-visible")));
  setTimeout(() => {
    toast.classList.remove("kavi-toast-visible");
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
// SEND REQUEST
// ═══════════════════════════════════════════════════════════════════════════

async function sendRequest(userMessage) {
  isStreaming = true;
  updateSendButton();

  const msgEl = document.createElement("div");
  msgEl.className = "message message-assistant message-enter";
  msgEl.innerHTML = `
    <div class="message-avatar">${KAVI_SVG_HTML}</div>
    <div class="message-content" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
      <div class="status-bubble-container">
        <div class="status-bubble">
          <div class="status-icon-wrapper">
            <svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
          </div>
          <span class="status-text"><i>Kaví is Thinking...</i></span>
        </div>
      </div>
      <div class="message-bubble" style="display: none;"></div>
    </div>
  `;
  chatContainer.appendChild(msgEl);
  scrollToBottom(true);

  const bubbleEl = msgEl.querySelector(".message-bubble");
  let fullResponse = "";
  // Track if we need a markdown re-render scheduled
  let renderPending = false;
  let productCardsHtml = "";

  // ── Fake status cycler in case backend is quiet ─────────────────────────
  const STATUS_ICONS = {
    search: `<svg viewBox="0 0 24 24" class="status-icon anim-search" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    lock: `<svg viewBox="-2 -4 28 30" class="status-icon anim-lock" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path class="lock-shackle" d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
    book: `<svg viewBox="0 0 24 24" class="status-icon anim-book" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`,
    brain: `<svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`,
    sync: `<svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`
  };

  const fakeStatuses = [
    { text: "Analyzing your request...", icon: STATUS_ICONS.brain },
    { text: "Kaví is thinking...", icon: STATUS_ICONS.brain },
    { text: "Understanding shopping intent...", icon: STATUS_ICONS.brain },
    { text: "Connecting to Kapruka...", icon: STATUS_ICONS.sync },
    { text: "Searching Kapruka Catalog...", icon: STATUS_ICONS.search },
    { text: "Scanning categories...", icon: STATUS_ICONS.search },
    { text: "Kaví is retrieving Products...", icon: STATUS_ICONS.sync },
    { text: "Filtering for best matches...", icon: STATUS_ICONS.search },
    { text: "Checking stock availability...", icon: STATUS_ICONS.search },
    { text: "Cross-referencing prices...", icon: STATUS_ICONS.sync },
    { text: "Fetching high-res imagery...", icon: STATUS_ICONS.search },
    { text: "Reading product details...", icon: STATUS_ICONS.book },
    { text: "Kaví is formulating options...", icon: STATUS_ICONS.brain },
    { text: "Preparing recommendations...", icon: STATUS_ICONS.brain },
    { text: "Finalizing responses...", icon: STATUS_ICONS.brain }
  ];
  let fakeStatusIndex = 0;
  let fakeStatusInterval = setInterval(() => {
    const statusTextEl = msgEl.querySelector(".status-text");
    const statusIconEl = msgEl.querySelector(".status-icon-wrapper");
    if (statusTextEl && statusIconEl && !fullResponse && !productCardsHtml) {
      statusTextEl.innerHTML = `<i>${fakeStatuses[fakeStatusIndex].text}</i>`;
      statusIconEl.innerHTML = fakeStatuses[fakeStatusIndex].icon;
      fakeStatusIndex = (fakeStatusIndex + 1) % fakeStatuses.length;
    }
  }, 3000);

  // ── Debug state ─────────────────────────────────────────────────────────
  const requestPayload = { message: userMessage, thread_id: threadId, user_id: userId };

  // Efficient render: batch all token updates into one rAF per frame
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      bubbleEl.innerHTML = renderMarkdown(fullResponse) + productCardsHtml;
      scrollToBottom();
    });
  }

  abortController = new AbortController();
  const { signal } = abortController;
  const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${BACKEND_URL}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
      signal,
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the last incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (!dataStr) continue;

          try {
            const event = JSON.parse(dataStr);

            if (event.event === "status") {
              setAvatarState("thinking");
              // Clear the fake status cycler so the real backend status stays visible
              // naturally instead of being erratically overwritten.
              if (fakeStatusInterval) {
                clearInterval(fakeStatusInterval);
                fakeStatusInterval = null;
              }

              // Immediately show status in the status bubble
              if (!fullResponse && !productCardsHtml) {
                const statusTextEl = msgEl.querySelector(".status-text");
                const statusIconEl = msgEl.querySelector(".status-icon-wrapper");
                if (statusTextEl && statusIconEl) {
                  const statusMap = {
                    "received": { text: "Kaví is Thinking...", icon: STATUS_ICONS.brain },
                    "thinking": { text: "Kaví is thinking", icon: STATUS_ICONS.brain },
                    "browsing_products": { text: "Searching Kapruka Catalog", icon: STATUS_ICONS.search },
                    "working_on_checkout": { text: "Finalizing responses", icon: STATUS_ICONS.lock },
                    "checking_order": { text: "Checking order status...", icon: STATUS_ICONS.search },
                    "writing_reply": { text: "Finalizing responses", icon: STATUS_ICONS.brain }
                  };
                  const rawStatus = event.status || "";
                  const mapped = statusMap[rawStatus] || { text: rawStatus || "Thinking...", icon: STATUS_ICONS.brain };
                  statusTextEl.innerHTML = `<i>${escapeHtml(mapped.text)}</i>`;
                  statusIconEl.innerHTML = mapped.icon;
                }
              }
            } else if (event.event === "token") {
              setAvatarState("talking");
              // Hide the status bubble container once the response starts streaming
              const statusContainer = msgEl.querySelector(".status-bubble-container");
              if (statusContainer) {
                statusContainer.style.display = "none";
              }

              // Show the message bubble if hidden
              if (bubbleEl && bubbleEl.style.display === "none") {
                bubbleEl.style.display = "block";
              }

              if (!fullResponse) bubbleEl.innerHTML = "";
              fullResponse += event.text;
              scheduleRender();
            } else if (event.event === "final") {
              setAvatarState("idle");
              // Update Debug Panel
              const debugEl = document.getElementById("debug-json-content");
              if (debugEl) {
                debugEl.textContent = JSON.stringify(event, null, 2);
              }

              // Hide the status bubble container
              const statusContainer = msgEl.querySelector(".status-bubble-container");
              if (statusContainer) {
                statusContainer.style.display = "none";
              }

              // Process cart
              if (event.cart !== undefined) {
                setCart(event.cart);
              }

              const hasTracking = (event.cards || []).some(c => c.type === "track_order_form" || c.type === "order_tracking");
              const cartSummaryCard = (event.cards || []).find(c => c.type === "cart_summary");
              if (cartSummaryCard && cartSummaryCard.items && cartSummaryCard.items.length > 0 && !hasTracking) {
                productCardsHtml += `<div style="margin-top: 12px;"><button class="checkout-btn" style="padding: 10px 16px; font-size: 0.9rem; width: auto;" onclick="openCart()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: middle; position: relative; top: -1px;"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>View Cart</button></div>`;
              }

              // Process cards
              let filteredCards = event.cards || [];
              if (filteredCards.length > 0) {
                if (filteredCards.some(c => c.type === "track_order_form" || c.type === "order_tracking")) {
                  filteredCards = filteredCards.filter(c => c.type !== "checkout_form");
                }

                const productCards = filteredCards.filter(c => c.type === "product");
                if (productCards.length > 0) productCardsHtml += renderProductCards(productCards);

                const detailCards = filteredCards.filter(c => c.type === "product_detail");
                if (detailCards.length > 0) productCardsHtml += renderProductDetailCards(detailCards);

                const checkoutFormCard = filteredCards.find(c => c.type === "checkout_form");
                if (checkoutFormCard) productCardsHtml += renderCheckoutForm(checkoutFormCard);

                const confCard = filteredCards.find(c => c.type === "checkout_confirmation");
                if (confCard) {
                  productCardsHtml += renderConfirmation(confCard);
                  // Clear the cart — order is placed, items no longer relevant
                  currentCart = null;
                  updateCartBadge(null);
                  renderCartDrawer();
                }

                const trackFormCard = filteredCards.find(c => c.type === "track_order_form");
                if (trackFormCard) productCardsHtml += renderTrackOrderForm(trackFormCard);

                const trackCard = filteredCards.find(c => c.type === "order_tracking");
                if (trackCard) productCardsHtml += renderTracking(trackCard);

                if (confCard && typeof triggerConfetti === "function") triggerConfetti();
              }

              const hasCheckoutForm = filteredCards.some(c => c.type === "checkout_form");
              const hasProductCards = filteredCards.some(c => c.type === "product");

              let stepsToRender = [];
              if (event.suggested_next_step && !(hasCheckoutForm && (event.suggested_next_step === "continue_checkout" || event.suggested_next_step === "proceed_to_checkout"))) {
                stepsToRender.push(event.suggested_next_step);
              }
              if (hasProductCards && event.suggested_next_step !== "add_more") {
                stepsToRender.push("add_more");
              }

              if (stepsToRender.length > 0) {
                productCardsHtml += renderSuggestedSteps(stepsToRender);
              }

              if (bubbleEl) {
                bubbleEl.style.display = "block";
                bubbleEl.innerHTML = renderMarkdown(fullResponse) + productCardsHtml;
              }
              scrollToBottom();
            } else if (event.event === "error") {
              const statusContainer = msgEl.querySelector(".status-bubble-container");
              if (statusContainer) statusContainer.style.display = "none";

              if (bubbleEl) {
                bubbleEl.style.display = "block";
              }
              fullResponse = event.text;
              bubbleEl.innerHTML = `<div class="error-content">${renderMarkdown(fullResponse)}</div>`;
              scrollToBottom();
            }
          } catch (e) {
            console.error("SSE parse error", e, dataStr);
          }
        }
      }
    }

  } catch (err) {
    if (err.name === "AbortError") {
      fullResponse = "⏱️ **Request timed out.** The server took too long to respond.";
    } else if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError")) {
      fullResponse =
        "❌ **Cannot reach the backend.**\\n\\nMake sure the server is running at:\\n`" + BACKEND_URL + "`";
    } else {
      fullResponse = `❌ **Error:** ${err.message}`;
    }

    const statusContainer = msgEl.querySelector(".status-bubble-container");
    if (statusContainer) {
      statusContainer.style.display = "none";
    }
    if (bubbleEl) {
      bubbleEl.style.display = "block";
      bubbleEl.innerHTML = `<div class="error-content">${renderMarkdown(fullResponse)}</div>`;
    }

  } finally {
    if (fakeStatusInterval) clearInterval(fakeStatusInterval);
    clearTimeout(timeoutId);
    isStreaming = false;
    abortController = null;
    updateSendButton();

    if (fullResponse) {
      messages.push({ role: "assistant", content: fullResponse });
      updateSessionDisplay();
    }

    // Hide status bubble container
    const statusContainer = msgEl.querySelector(".status-bubble-container");
    if (statusContainer) {
      statusContainer.style.display = "none";
    }

    scrollToBottom();
  }
}

// ── Scroll helpers ──────────────────────────────────────────────────────────
let isUserScrolledUp = false;

function scrollToBottom(force = true) {
  requestAnimationFrame(() => {
    // Determine if the user has manually scrolled up significantly
    const threshold = 150;
    const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;

    // Only auto-scroll if forced, or if the user is near the bottom
    if (force || distanceFromBottom <= threshold) {
      const lastChild = chatContainer.lastElementChild;
      if (lastChild) {
        const childRect = lastChild.getBoundingClientRect();
        const containerRect = chatContainer.getBoundingClientRect();
        const childCenterY = childRect.top + (childRect.height / 2);
        const containerCenterY = containerRect.top + (containerRect.height / 2);
        chatContainer.scrollBy({ top: childCenterY - containerCenterY, behavior: 'instant' });
      } else {
        // Fallback if no children
        chatContainer.scrollTo({
          top: chatContainer.scrollHeight,
          behavior: 'instant'
        });
      }
    }
  });
}

// ── HTML escaping ───────────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Lightweight Markdown Renderer ───────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";

  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Horizontal rule
  html = html.replace(/^---$/gm, "<hr>");

  // Unordered lists (support -, *, and literal bullet •, with optional leading space)
  html = html.replace(/^\s*[*\-•] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  // Notice we use a different placeholder for ordered list items to avoid mixing them with unordered
  html = html.replace(/^\s*\d+\. (.+)$/gm, "<li class='ol-item'>$1</li>");
  html = html.replace(/((?:<li class='ol-item'>.*<\/li>\n?)+)/g, "<ol>$1</ol>");
  html = html.replace(/<li class='ol-item'>/g, "<li>");

  // Merge adjacent lists that were separated by excessive newlines
  html = html.replace(/<\/ul>\s*<ul>/g, "\n");
  html = html.replace(/<\/ol>\s*<ol>/g, "\n");

  // Force block boundaries so split(/\n\n+/) correctly isolates block-level elements
  // This prevents <br> from being injected inside <ul> and prevents <p> wrapping around <ul>
  html = html.replace(/(<\/ul>|<\/ol>|<\/pre>|<\/blockquote>|<\/table>)\s*/gi, "$1\n\n");
  html = html.replace(/\s*(<ul|<ol|<pre|<blockquote|<table)/gi, "\n\n$1");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Line breaks → paragraphs
  html = html
    .split(/\n\n+/)
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      if (
        block.startsWith("<h") ||
        block.startsWith("<pre") ||
        block.startsWith("<ul") ||
        block.startsWith("<ol") ||
        block.startsWith("<blockquote") ||
        block.startsWith("<hr") ||
        block.startsWith("<table")
      ) {
        return block;
      }
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}

// ═══════════════════════════════════════════════════════════════════════════
// UI ACTIONS & CART DRAWER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Submit a UI action (cart add/remove/update/clear) using the same SSE stream
 * as regular chat — this ensures a seamless, streamed response for every action.
 * The instant toast feedback is shown BEFORE this is called, giving the user
 * immediate visual confirmation while the backend processes.
 */
async function submitUiAction(endpoint, payload) {
  // ── Call the dedicated backend endpoint (NOT the chat/stream pipeline) ──
  // These endpoints mutate state deterministically and return the universal
  // response shape (text + cards + suggested_next_step) in one JSON response.

  // Build the assistant message bubble with a loading spinner
  const msgEl = document.createElement("div");
  msgEl.className = "message message-assistant message-enter";
  msgEl.innerHTML = `
    <div class="message-avatar">${KAVI_SVG_HTML}</div>
    <div class="message-content" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
      <div class="status-bubble-container">
        <div class="status-bubble">
          <div class="status-icon-wrapper">
            <svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
          </div>
          <span class="status-text"><i>Kaví is Thinking...</i></span>
        </div>
      </div>
      <div class="message-bubble" style="display: none;"></div>
    </div>
  `;
  chatContainer.appendChild(msgEl);
  scrollToBottom();
  setAvatarState("thinking");

  const bubbleEl = msgEl.querySelector(".message-bubble");
  const requestPayload = { user_id: userId, thread_id: threadId, ...payload };

  const STATUS_ICONS = {
    search: `<svg viewBox="0 0 24 24" class="status-icon anim-search" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    lock: `<svg viewBox="-2 -4 28 30" class="status-icon anim-lock" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path class="lock-shackle" d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
    book: `<svg viewBox="0 0 24 24" class="status-icon anim-book" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`,
    brain: `<svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`,
    sync: `<svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`
  };

  const fakeStatuses = [
    { text: "Authenticating secure session...", icon: STATUS_ICONS.lock },
    { text: "Kaví is processing action...", icon: STATUS_ICONS.brain },
    { text: "Updating cart ledger...", icon: STATUS_ICONS.book },
    { text: "Verifying stock levels...", icon: STATUS_ICONS.search },
    { text: "Recalculating Kapruka totals...", icon: STATUS_ICONS.sync },
    { text: "Applying valid promotions...", icon: STATUS_ICONS.sync },
    { text: "Syncing with backend servers...", icon: STATUS_ICONS.sync },
    { text: "Kaví is validating state...", icon: STATUS_ICONS.search },
    { text: "Finalizing UI updates...", icon: STATUS_ICONS.brain }
  ];
  let fakeStatusIndex = 0;
  let fakeStatusInterval = setInterval(() => {
    const statusTextEl = msgEl.querySelector(".status-text");
    const statusIconEl = msgEl.querySelector(".status-icon-wrapper");
    if (statusTextEl && statusIconEl) {
      statusTextEl.innerHTML = `<i>${fakeStatuses[fakeStatusIndex].text}</i>`;
      statusIconEl.innerHTML = fakeStatuses[fakeStatusIndex].icon;
      fakeStatusIndex = (fakeStatusIndex + 1) % fakeStatuses.length;
    }
  }, 3000);

  try {
    const res = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (!res.ok) {
      throw new Error(`Server error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // Update Debug Panel
    const debugEl = document.getElementById("debug-json-content");
    if (debugEl) {
      debugEl.textContent = JSON.stringify(data, null, 2);
    }

    // ── Hide loader ───────────────────────────────────────────────────────
    const statusContainer = msgEl.querySelector(".status-bubble-container");
    if (statusContainer) statusContainer.style.display = "none";

    // ── Render text ───────────────────────────────────────────────────────
    let productCardsHtml = "";

    // ── Process cards (same logic as the SSE "final" event) ───────────────
    // Process cart
    if (data.cart !== undefined) {
      setCart(data.cart);
    }

    const hasTracking = (data.cards || []).some(c => c.type === "track_order_form" || c.type === "order_tracking");
    const cartSummaryCard = (data.cards || []).find(c => c.type === "cart_summary");
    if (cartSummaryCard && cartSummaryCard.items && cartSummaryCard.items.length > 0 && !hasTracking) {
      productCardsHtml += `<div style="margin-top: 12px;"><button class="checkout-btn" style="padding: 10px 16px; font-size: 0.9rem; width: auto;" onclick="openCart()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: middle; position: relative; top: -1px;"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>View Cart</button></div>`;
    }

    let filteredCards = data.cards || [];
    if (filteredCards.length > 0) {
      if (filteredCards.some(c => c.type === "track_order_form" || c.type === "order_tracking")) {
        filteredCards = filteredCards.filter(c => c.type !== "checkout_form");
      }

      const productCards = filteredCards.filter(c => c.type === "product");
      if (productCards.length > 0) productCardsHtml += renderProductCards(productCards);

      const detailCards = filteredCards.filter(c => c.type === "product_detail");
      if (detailCards.length > 0) productCardsHtml += renderProductDetailCards(detailCards);

      const checkoutFormCard = filteredCards.find(c => c.type === "checkout_form");
      if (checkoutFormCard) productCardsHtml += renderCheckoutForm(checkoutFormCard);

      const confCard = filteredCards.find(c => c.type === "checkout_confirmation");
      if (confCard) {
        productCardsHtml += renderConfirmation(confCard);
        // Clear the cart — order is placed, items no longer relevant
        currentCart = null;
        updateCartBadge(null);
        renderCartDrawer();
      }

      const trackFormCard = filteredCards.find(c => c.type === "track_order_form");
      if (trackFormCard) productCardsHtml += renderTrackOrderForm(trackFormCard);

      const trackCard = filteredCards.find(c => c.type === "order_tracking");
      if (trackCard) productCardsHtml += renderTracking(trackCard);

      if (confCard && typeof triggerConfetti === "function") triggerConfetti();
    }

    const hasCheckoutForm = filteredCards.some(c => c.type === "checkout_form");
    const hasProductCards = filteredCards.some(c => c.type === "product");

    let stepsToRender = [];
    if (data.suggested_next_step && !(hasCheckoutForm && (data.suggested_next_step === "continue_checkout" || data.suggested_next_step === "proceed_to_checkout"))) {
      stepsToRender.push(data.suggested_next_step);
    }
    if (hasProductCards && data.suggested_next_step !== "add_more") {
      stepsToRender.push("add_more");
    }

    if (stepsToRender.length > 0) {
      productCardsHtml += renderSuggestedSteps(stepsToRender);
    }

    // ── Show the response bubble ──────────────────────────────────────────
    const responseText = data.text || "";
    if (bubbleEl) {
      bubbleEl.style.display = "block";
      bubbleEl.innerHTML = renderMarkdown(responseText) + productCardsHtml;
    }

    if (responseText) {
      messages.push({ role: "assistant", content: responseText });
      updateSessionDisplay();
    }

    return true;
  } catch (err) {
    const statusContainer = msgEl.querySelector(".status-bubble-container");
    if (statusContainer) statusContainer.style.display = "none";

    const errorMsg = `❌ **Error:** ${err.message}`;
    if (bubbleEl) {
      bubbleEl.style.display = "block";
      bubbleEl.innerHTML = `<div class="error-content">${renderMarkdown(errorMsg)}</div>`;
    }
    return false;
  } finally {
    if (fakeStatusInterval) clearInterval(fakeStatusInterval);
    setAvatarState("idle");
  }

  scrollToBottom();
}

function optimisticCartUpdate(action, payload) {
  if (action === "clear") {
    currentCart = { type: "cart_summary", items: [], items_total: 0, currency: "LKR" };
  } else {
    if (!currentCart) {
      currentCart = { type: "cart_summary", items: [], items_total: 0, currency: payload.currency || "LKR" };
    }
    const existingIdx = currentCart.items.findIndex(i => i.product_id === payload.product_id);

    if (action === "remove") {
      if (existingIdx >= 0) currentCart.items.splice(existingIdx, 1);
    } else if (action === "add" || action === "update_qty") {
      if (existingIdx >= 0) {
        if (action === "update_qty") {
          currentCart.items[existingIdx].quantity = payload.quantity;
        } else {
          currentCart.items[existingIdx].quantity += payload.quantity;
        }
      } else if (action === "add") {
        currentCart.items.push({
          product_id: payload.product_id,
          name: payload.name,
          quantity: payload.quantity,
          unit_price: payload.unit_price || 0,
          image_url: payload.image_url || "",
        });
      }
    }

    // Recalculate total
    currentCart.items_total = currentCart.items.reduce((sum, item) => sum + ((item.unit_price || 0) * item.quantity), 0);
  }

  updateCartBadge(currentCart);
  renderCartDrawer();
}

function setCart(cartArray) {
  if (!cartArray || !Array.isArray(cartArray)) {
    currentCart = { type: "cart_summary", items: [], items_total: 0, currency: "LKR" };
  } else {
    const items_total = cartArray.reduce((sum, item) => sum + ((item.unit_price || 0) * item.quantity), 0);
    const currency = cartArray.length > 0 && cartArray[0].currency ? cartArray[0].currency : "LKR";
    currentCart = { type: "cart_summary", items: cartArray, items_total: items_total, currency: currency };
  }
  updateCartBadge(currentCart);
  renderCartDrawer();
}

function updateCartQty(productId, qty) {
  if (qty < 1) {
    removeFromCart(productId);
    return;
  }
  // Find the item name for a friendly toast
  const item = currentCart?.items?.find(i => i.product_id === productId);
  const name = item?.name || "item";
  const payload = { product_id: productId, quantity: qty, name };
  optimisticCartUpdate("update_qty", payload);
  showToast(`Updated quantity to ${qty}`, "success", "🛒");
  submitUiAction("/cart/update_qty", payload);
}

function removeFromCart(productId) {
  const item = currentCart?.items?.find(i => i.product_id === productId);
  const name = item?.name || "item";
  const payload = { product_id: productId, name };
  optimisticCartUpdate("remove", payload);
  showToast(`Removed "${name}" from cart`, "error", "🗑️");
  submitUiAction("/cart/remove", payload);
}

function viewProductDetails(productId, btn) {
  let isButton = btn && btn.tagName === 'BUTTON';
  if (btn) {
    if (btn.disabled || btn.style.pointerEvents === 'none') return;
    if (isButton) {
      btn.disabled = true;
      btn.dataset.originalHtml = btn.innerHTML;
      btn.innerHTML = `<span class="status-spinner" style="width: 12px; height: 12px; border-width: 2px; border-top-color: currentColor; margin-right: 6px;"></span>Loading...`;
    } else {
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
    }
  }

  submitUiAction("/product/details", { product_id: productId }).then((success) => {
    if (btn) {
      const reenable = () => {
        if (isButton) {
          btn.disabled = false;
          if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
        } else {
          btn.style.pointerEvents = '';
          btn.style.opacity = '';
        }
      };

      if (success !== false) {
        reenable();
      } else {
        setTimeout(reenable, 3000);
      }
    }
  });
}

function addToCartDirect(productId, name, quantity, unitPrice, currency, imageUrl) {
  const payload = {
    product_id: productId,
    name: name,
    quantity: quantity || 1,
    unit_price: unitPrice || null,
    currency: currency || "LKR",
    image_url: imageUrl || null,
    in_stock: true,
  };
  optimisticCartUpdate("add", payload);
  const tickSvg = `<svg class="kavi-toast-tick" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 22px; height: 22px; margin-right: 4px;"><circle cx="12" cy="12" r="10" class="tick-circle"></circle><polyline points="8 12 11 15 16 9" class="tick-check"></polyline></svg>`;
  showToast(`Added "${name}" to cart`, "success", tickSvg);
  submitUiAction("/cart/add", payload);
}

function clearCartAction() {
  optimisticCartUpdate("clear", {});
  showToast("Cart cleared", "info", "🗑️");
  submitUiAction("/cart/clear", {});
}

function startCheckout() {
  closeCart();
  sendQuickAction("Proceed to checkout");
}

function updateCartBadge(cartCard) {
  const badgeEl = document.getElementById("cart-badge");
  if (!badgeEl) return;
  if (!cartCard || !cartCard.items) {
    badgeEl.style.display = "none";
    badgeEl.textContent = "0";
    return;
  }
  const qty = cartCard.items.reduce((sum, item) => sum + item.quantity, 0);
  badgeEl.textContent = qty;
  badgeEl.style.display = qty > 0 ? "flex" : "none";
}

function renderCartDrawer() {
  if (!cartItemsContainer || !cartTotalDisplay || !cartCheckoutBtn) return;

  const clearBtn = document.getElementById("clear-cart-btn");

  if (!currentCart || !currentCart.items || currentCart.items.length === 0) {
    cartItemsContainer.innerHTML = `<div class="cart-empty">Your cart is empty</div>`;
    cartTotalDisplay.textContent = "0 LKR";
    cartCheckoutBtn.disabled = true;
    if (clearBtn) clearBtn.style.display = "none";
    return;
  }

  cartTotalDisplay.textContent = formatPrice(currentCart.items_total, currentCart.currency);
  cartCheckoutBtn.disabled = false;
  if (clearBtn) clearBtn.style.display = "";

  cartItemsContainer.innerHTML = currentCart.items.map(item => `
    <div class="cart-item">
      <img src="${escapeHtml(item.image_url || '')}" class="cart-item-img" onerror="this.src=''" alt="${escapeHtml(item.name)}"/>
      <div class="cart-item-info">
        <h4 class="cart-item-name">${escapeHtml(item.name)}</h4>
        <div class="cart-item-price">${formatPrice(item.unit_price, currentCart.currency)}</div>
        <div class="cart-item-actions">
          <div class="cart-qty-controls">
            <button class="qty-btn" onclick="updateCartQty('${item.product_id}', ${item.quantity - 1})">−</button>
            <span class="qty-val">${item.quantity}</span>
            <button class="qty-btn" onclick="updateCartQty('${item.product_id}', ${item.quantity + 1})">+</button>
          </div>
          <button class="cart-remove-btn" onclick="removeFromCart('${item.product_id}')">Remove</button>
        </div>
      </div>
    </div>
  `).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// INLINE COMPONENT RENDERERS
// ═══════════════════════════════════════════════════════════════════════════

function renderCheckoutForm(card) {
  if (!card) return "";

  // Gap 4: When all fields are filled, show a "ready" state instead of nothing
  if (!card.missing_fields || card.missing_fields.length === 0) {
    return `
      <div class="inline-checkout-form checkout-ready" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding: 16px 20px; margin-top: 16px; background: linear-gradient(145deg, #ffffff, #fcfaff); border: 1px solid rgba(139, 92, 246, 0.15); border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(64, 41, 112, 0.08), 0 8px 10px -6px rgba(64, 41, 112, 0.04); position: relative; overflow: hidden; animation: popInAction 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) backwards;">
        <div style="position: absolute; top: -20px; left: -20px; width: 80px; height: 80px; background: rgba(16, 185, 129, 0.15); border-radius: 50%; filter: blur(20px);"></div>
        <div style="display: flex; align-items: center; gap: 14px; z-index: 1; flex: 1; min-width: 200px;">
          <div style="width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3); color: white;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="animation: popInAction 0.5s ease-out forwards;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
          <div>
            <h4 style="margin: 0; color: #1f2937; font-size: 0.95rem; font-weight: 700; letter-spacing: -0.01em;">Ready to Checkout</h4>
            <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 0.8rem; line-height: 1.3;">All details collected securely.</p>
          </div>
        </div>
        <button class="checkout-submit-btn" style="z-index: 1; flex-shrink: 0; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; padding: 10px 20px; border-radius: 10px; border: none; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 4px 15px var(--primary-glow); display: flex; align-items: center; gap: 6px;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px var(--primary-glow)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 15px var(--primary-glow)';" onclick="const btn = this; btn.disabled=true; btn.innerHTML='<span class=\\'status-spinner\\' style=\\'width: 14px; height: 14px; border-width: 2px; border-top-color: white; margin-right: 6px;\\'></span> Placing...'; submitUiAction('/checkout/place_order', {}).then(() => { btn.innerHTML='Order Placed <svg width=\\'16\\' height=\\'16\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2.5\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><polyline points=\\'20 6 9 17 4 12\\'></polyline></svg>'; btn.style.background='linear-gradient(135deg, #10b981, #059669)'; btn.style.boxShadow='0 4px 15px rgba(16, 185, 129, 0.4)'; setTimeout(() => scrollToBottom(), 100); });">
          Place Order
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path></svg>
        </button>
      </div>
    `;
  }

  // Gap 2: Map dotted backend field paths to the flat field names CheckoutSubmitRequest expects
  const FIELD_TO_FLAT = {
    "recipient.name": "recipient_name",
    "recipient.phone": "recipient_phone",
    "delivery.address": "delivery_address",
    "delivery.city": "delivery_city",
    "delivery.date": "delivery_date",
    "sender.name": "sender_name",
    "sender.anonymous": "sender_anonymous",
  };

  const FIELD_LABELS = {
    "recipient.name": "Recipient Name",
    "recipient.phone": "Recipient Phone",
    "delivery.address": "Delivery Address",
    "delivery.city": "Delivery City",
    "delivery.date": "Delivery Date",
    "sender.name": "Your Name (Sender)",
    "sender.anonymous": "Send Anonymously?",
  };

  const FIELD_PLACEHOLDERS = {
    "recipient.name": "e.g. Sanduni Perera",
    "recipient.phone": "e.g. 0712345678",
    "delivery.address": "e.g. 123 Galle Road, Colombo 03",
    "delivery.city": "e.g. Colombo 03",
    "sender.name": "e.g. Chamaka",
  };

  const fields = card.fields || {};
  let html = `<form class="inline-checkout-form" onsubmit="handleCheckoutSubmit(event)">`;
  html += `<h4>Please provide delivery details</h4>`;

  const uniqueSuffix = Math.random().toString(36).substring(2, 9);

  Object.keys(FIELD_TO_FLAT).forEach(fieldPath => {
    const flatName = FIELD_TO_FLAT[fieldPath];
    const label = FIELD_LABELS[fieldPath] || fieldPath.split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    const id = `chk-${flatName}-${uniqueSuffix}`;

    // Read pre-filled value from nested fields object
    const parts = fieldPath.split('.');
    let val = fields;
    for (const p of parts) { if (val !== undefined && val !== null) val = val[p]; else val = ""; }
    val = val || "";

    const isOptional = false;
    const requiredAttr = isOptional ? "" : "required";

    let inputHtml = '';

    if (fieldPath === 'sender.anonymous') {
      // Render as a toggle switch
      const isChecked = val === true || val === 'true' ? 'checked' : '';
      inputHtml = `
        <label class="toggle-switch">
          <input type="checkbox" id="${id}" name="${escapeHtml(flatName)}" ${isChecked}>
          <span class="slider round"></span>
        </label>
      `;
      html += `
        <div class="form-group toggle-group">
          <label for="${id}">${escapeHtml(label)}</label>
          ${inputHtml}
        </div>
      `;
    } else {
      let inputType = "text";
      let extraAttrs = "";

      if (fieldPath === "delivery.date") {
        inputType = "date";
        // Calculate today's date in Sri Lanka time (Asia/Colombo)
        const today = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' });
        const parts = formatter.formatToParts(today);
        const y = parts.find(p => p.type === 'year').value;
        const m = parts.find(p => p.type === 'month').value;
        const d = parts.find(p => p.type === 'day').value;
        const todayStr = `${y}-${m}-${d}`;

        extraAttrs = `min="${todayStr}" title="Delivery is only available for today or a future date."`;
      } else if (fieldPath === "recipient.phone") {
        inputType = "tel";
        // Max 12 chars, exactly 10 digits starting with 0, or +94 followed by 9 digits
        extraAttrs = `maxlength="12" pattern="0[0-9]{9}|\\+94[0-9]{9}" title="Valid Sri Lankan number required: 10 digits (e.g. 0712345678) or +94 format (e.g. +94712345678)"`;
      }

      const placeholder = FIELD_PLACEHOLDERS[fieldPath] || `Enter ${label.toLowerCase()}`;

      if (fieldPath === "delivery.date") {
        const formattedVal = val ? val.split('-').reverse().join('/') : '';
        inputHtml = `
          <div style="position: relative; display: flex; align-items: center;">
            <input type="text" id="${id}-display" value="${escapeHtml(formattedVal)}" placeholder="DD/MM/YYYY" readonly style="width: 100%; background: #fff; cursor: pointer;" />
            <input type="date" id="${id}" name="${escapeHtml(flatName)}" value="${escapeHtml(val)}" ${requiredAttr} ${extraAttrs} style="opacity: 0; position: absolute; inset: 0; width: 100%; height: 100%; cursor: pointer;" onchange="document.getElementById('${id}-display').value = this.value ? this.value.split('-').reverse().join('/') : ''; validateCheckoutForm(this.form);" onclick="if(this.showPicker) this.showPicker();" />
            <svg style="position: absolute; right: 12px; pointer-events: none; opacity: 0.5;" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
          </div>
        `;
      } else {
        inputHtml = `<input type="${inputType}" id="${id}" name="${escapeHtml(flatName)}" value="${escapeHtml(val)}" ${requiredAttr} ${extraAttrs} placeholder="${escapeHtml(placeholder)}" oninput="validateCheckoutForm(this.form)"/>`;
      }

      html += `
        <div class="form-group">
          <label for="${id}">${escapeHtml(label)}</label>
          ${inputHtml}
          <div id="err-${id}" style="display:none; color:#ef4444; font-size:0.8rem; margin-top:4px; font-weight: 500;"></div>
        </div>
      `;
    }
  });

  html += `<button type="submit" class="checkout-submit-btn" disabled>Continue</button>`;
  html += `</form>`;
  return html;
}

function handleCheckoutSubmit(e) {
  e.preventDefault();
  const form = e.target;

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const formData = new FormData(form);

  // Gap 2: Build a flat payload matching CheckoutSubmitRequest exactly
  const payload = {};
  for (let [key, val] of formData.entries()) {
    if (val) payload[key] = val;
  }

  // Handle checkboxes explicitly since FormData only includes them if checked
  const checkboxes = form.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => {
    payload[cb.name] = cb.checked;
  });

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = "Processing...";
  submitUiAction("/checkout/submit", payload);
}

function validateCheckoutForm(form) {
  const inputs = form.querySelectorAll('input[required]');
  const submitBtn = form.querySelector('.checkout-submit-btn');
  let isValid = true;

  inputs.forEach(input => {
    if (!input.value.trim() || !input.checkValidity()) {
      isValid = false;
    }

    const errEl = document.getElementById(`err-${input.id}`);
    if (errEl) {
      const displayEl = document.getElementById(`${input.id}-display`) || input;
      if (input.value.trim() && !input.checkValidity()) {
        errEl.textContent = input.title || "Invalid input format";
        errEl.style.display = 'block';
        displayEl.style.borderColor = '#ef4444';
        displayEl.style.backgroundColor = '#fef2f2';
      } else {
        errEl.style.display = 'none';
        displayEl.style.borderColor = '';
        displayEl.style.backgroundColor = '';
      }
    }
  });

  submitBtn.disabled = !isValid;
}

function renderConfirmation(card) {
  if (!card) return "";

  // Preconnect to the payment gateway as soon as the card renders,
  // so DNS + TLS handshake complete before the user clicks "Pay Now"
  if (card.checkout_url) {
    try {
      const gatewayOrigin = new URL(card.checkout_url).origin;
      if (!document.querySelector(`link[rel="preconnect"][href="${gatewayOrigin}"]`)) {
        const preconnect = document.createElement("link");
        preconnect.rel = "preconnect";
        preconnect.href = gatewayOrigin;
        document.head.appendChild(preconnect);

        const dnsPrefetch = document.createElement("link");
        dnsPrefetch.rel = "dns-prefetch";
        dnsPrefetch.href = gatewayOrigin;
        document.head.appendChild(dnsPrefetch);
      }
    } catch (_) { /* invalid URL — skip */ }
  }

  // Gap 7: Show full fee breakdown and expiry
  const expiryNote = card.expires_at
    ? `<div class="conf-expiry">⏰ Pay before ${escapeHtml(card.expires_at)}</div>`
    : "";
  return `
    <div class="confirmation-card">
      <div class="conf-header">
        <div class="conf-icon">🎉</div>
        <h3 class="conf-title">Order Placed!</h3>
      </div>
      <div class="conf-details">
        <div class="conf-row"><span>Order Ref:</span> <strong>${escapeHtml(card.order_ref || '')}</strong></div>
        <div class="conf-row"><span>Items Total:</span> <strong>${formatPrice(card.items_total, card.currency)}</strong></div>
        <div class="conf-row"><span>Delivery Fee:</span> <strong>${formatPrice(card.delivery_fee, card.currency)}</strong></div>
        ${card.addons_total ? `<div class="conf-row"><span>Add-ons:</span> <strong>${formatPrice(card.addons_total, card.currency)}</strong></div>` : ""}
        <div class="conf-row conf-row-total"><span>Grand Total:</span> <strong>${formatPrice(card.grand_total, card.currency)}</strong></div>
      </div>
      ${expiryNote}
      <button onclick="openCheckoutModal('${escapeHtml(card.checkout_url || '#')}')" class="pay-now-btn" style="width:100%; border:none; cursor:pointer;">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="pay-icon"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        Pay Now Securely
      </button>
    </div>
  `;
}
function renderTrackOrderForm(card) {
  if (!card) return "";
  return `
    <div class="checkout-card track-order-form" style="padding: 16px; margin-top: 12px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span style="font-size: 1.2rem;">📦</span>
        <h3 style="margin: 0; font-size: 0.95rem; color: #1a0f30;">Track Your Order</h3>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 0.85rem; color: #555;">Enter your Kapruka order number below to get real-time tracking updates.</p>
      <form onsubmit="event.preventDefault(); submitOrderTracking(this);" style="display: flex; flex-direction: column; gap: 12px;">
        <div class="checkout-field" style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 0.8rem; font-weight: 600; color: #333;">Order Number</label>
          <input type="text" name="order_id" placeholder="e.g. KAP12345678" required style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95rem; font-family: inherit; box-sizing: border-box;"/>
        </div>
        <button type="submit" class="checkout-submit-btn">Track Order</button>
      </form>
    </div>
  `;
}

function submitOrderTracking(form) {
  const input = form.querySelector('input[name="order_id"]');
  if (!input || !input.value.trim()) return;
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = "Tracking...";
  submitUiAction("/support/track", { order_id: input.value.trim() });
}

const STATUS_PROGRESS = {
  processing: 10,
  confirmed: 25,
  preparing: 45,
  shipped: 60,
  out_for_delivery: 80,
  delivered: 100,
  cancelled: 0,
};

const STATUS_BADGE_COLOR = {
  processing: "#3B82F6",
  confirmed: "#14B8A6",
  preparing: "#F59E0B",
  shipped: "#8B5CF6",
  out_for_delivery: "#F97316",
  delivered: "#22C55E",
  cancelled: "#EF4444"
};

function inferStepIcon(stepText) {
  const t = (stepText || "").toLowerCase();
  if (t.includes("delivered") && !t.includes("out for")) return "🎉";
  if (t.includes("out for delivery")) return "🚚";
  if (t.includes("dispatch")) return "🚀";
  if (t.includes("rider") || t.includes("assigned")) return "🛵";
  if (t.includes("picked up") || t.includes("collect")) return "📦";
  if (t.includes("flower") || t.includes("arrangement")) return "💐";
  if (t.includes("cake") || t.includes("bakery")) return "🎂";
  if (t.includes("preparing") || t.includes("warehouse")) return "🏭";
  if (t.includes("prepared")) return "✅";
  if (t.includes("confirmed") || t.includes("awaiting")) return "📋";
  if (t.includes("paid") || t.includes("payment")) return "💳";
  if (t.includes("cancel")) return "❌";
  return "📍";
}

function cleanDate(raw) {
  if (!raw) return null;
  return raw
    .replace(/\b(EDT|EST|GMT|UTC|IST)\b/g, "")
    .replace(/\s*\/\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function renderTracking(card) {
  if (!card) return "";

  const pct = STATUS_PROGRESS[card.status] ?? 50;
  const badgeColor = STATUS_BADGE_COLOR[card.status] ?? "#6B7280";

  const headerHtml = `
    <div class="tracking-header">
      <div class="tracking-order-number">Order #${escapeHtml(card.order_number)}</div>
      <span class="tracking-badge" style="background:${badgeColor}">
        ${escapeHtml(card.status_display)}
      </span>
    </div>
    <div class="tracking-progress-bar">
      <div class="tracking-progress-fill" style="width:${pct}%"></div>
    </div>
    <div class="tracking-progress-label">${pct}% complete</div>
  `;

  const metaItems = [
    card.order_date ? { label: "Ordered", value: cleanDate(card.order_date) } : null,
    card.delivery_date ? { label: "Delivery", value: cleanDate(card.delivery_date) } : null,
    card.shipped_date ? { label: "Shipped", value: cleanDate(card.shipped_date) } : null,
    card.order_total != null ? { label: "Total", value: `${card.order_currency || "LKR"} ${card.order_total.toLocaleString()}` } : null,
  ].filter(Boolean);

  const metaHtml = metaItems.length > 0
    ? `<div class="tracking-meta">
        ${metaItems.map(m => `
          <div class="tracking-meta-item">
            <span class="meta-label">${m.label}</span>
            <span class="meta-value">${escapeHtml(m.value)}</span>
          </div>`).join("")}
       </div>`
    : "";

  const commentHtml = card.comments
    ? `<div class="tracking-comment">💬 ${escapeHtml(card.comments)}</div>`
    : "";

  const itemsHtml = (card.items && card.items.length > 0)
    ? `<div class="tracking-items">
         <div class="tracking-items-title">Items Ordered</div>
         ${card.items.map(item => `
           <div class="tracking-item-row">
             <div class="tracking-item-qty">${item.quantity}x</div>
             <div class="tracking-item-name">${escapeHtml(item.name)}</div>
             <div class="tracking-item-price">${formatPrice(item.selling_price * item.quantity, card.order_currency || "LKR")}</div>
           </div>
         `).join("")}
       </div>`
    : "";

  const stepsHtml = (card.progress && card.progress.length > 0)
    ? `<div class="tracking-timeline">
        ${card.progress.map((step, i, all) => {
      const isCompleted = !!step.timestamp;
      const isCurrent = isCompleted && i === all.length - 1;
      const cls = isCurrent ? "step-current" : isCompleted ? "step-complete" : "step-pending";
      const icon = inferStepIcon(step.step);

      return `
            <div class="timeline-item ${cls}">
              <div class="timeline-left">
                <div class="timeline-icon-wrap">${icon}</div>
                ${i < all.length - 1 ? '<div class="timeline-connector"></div>' : ""}
              </div>
              <div class="timeline-right">
                <div class="timeline-step-label">${escapeHtml(step.step)}</div>
                ${step.timestamp
          ? `<div class="timeline-step-time">${escapeHtml(step.timestamp)}</div>`
          : ""}
              </div>
            </div>
          `;
    }).join("")}
      </div>`
    : `<p class="tracking-no-steps">No progress updates yet.</p>`;

  const mediaBanner = (card.has_delivery_photo || card.has_delivery_video)
    ? `<div class="tracking-media-banner">
        ${card.has_delivery_photo ? "📸 Delivery photo" : ""}
        ${card.has_delivery_photo && card.has_delivery_video ? " & " : ""}
        ${card.has_delivery_video ? "🎥 Delivery video" : ""}
        available on Kapruka.com
       </div>`
    : "";

  return `
    <div class="tracking-card">
      ${headerHtml}
      ${metaHtml}
      ${itemsHtml}
      ${commentHtml}
      ${stepsHtml}
      ${mediaBanner}
    </div>
  `;
}

function renderSuggestedSteps(steps) {
  if (!steps || steps.length === 0) return "";

  // Deduplicate to ensure no 2 buttons of the same type
  const uniqueSteps = [...new Set(steps)];

  const buttonsHtml = uniqueSteps.map(text => {
    if (!text) return "";
    let displayLabel = text.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    if (text === "add_more") {
      displayLabel = "Show more products";
    }

    const iconSvg = text === "add_more" ? `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
        <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
        <rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
        <rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
        <path d="M3 17.5h7"></path>
        <path d="M6.5 14v7"></path>
      </svg>
    ` : `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="flex-shrink: 0;">
        <path d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z"></path>
        <path d="M19 4L19.8 5.8L21.5 6.5L19.8 7.2L19 9L18.2 7.2L16.5 6.5L18.2 5.8L19 4Z"></path>
        <path d="M5 18L5.5 19.5L7 20L5.5 20.5L5 22L4.5 20.5L3 20L4.5 19.5L5 18Z"></path>
      </svg>
    `;

    return `
      <button class="suggested-step-btn" onclick="sendQuickAction('${escapeHtml(displayLabel)}')">
        ${iconSvg}
        ${escapeHtml(displayLabel)}
      </button>
    `;
  }).join('');

  if (!buttonsHtml) return "";

  return `
    <div class="suggested-step-wrapper">
      ${buttonsHtml}
    </div>
  `;
}

function triggerConfetti() {
  if (typeof confetti !== "undefined") {
    const duration = 3000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 10000 };

    const interval = setInterval(function () {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);
      confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } }));
      confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } }));
    }, 250);
  }
}

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

// ── Typewriter Animation ───────────────────────────────────────────────────
function typeWelcomeTitle() {
  const prefix = "Hi! I'm ";
  const name = "Kaví";
  const prefixEl = document.getElementById("typewriter-prefix");
  const nameEl = document.getElementById("typewriter-name");
  const cursorEl = document.querySelector(".typewriter-cursor");

  if (!prefixEl || !nameEl) return;

  prefixEl.textContent = "";
  nameEl.textContent = "";
  if (cursorEl) {
    cursorEl.style.display = "inline-block";
    cursorEl.style.opacity = "1";
  }

  let i = 0;
  function typePrefix() {
    if (i < prefix.length) {
      prefixEl.textContent += prefix.charAt(i);
      i++;
      setTimeout(typePrefix, 80);
    } else {
      let j = 0;
      function typeName() {
        if (j < name.length) {
          nameEl.textContent += name.charAt(j);
          j++;
          setTimeout(typeName, 120);
        } else {
          // Fade out the blinking cursor after finished typing
          setTimeout(() => {
            if (cursorEl) {
              cursorEl.style.transition = "opacity 0.5s ease";
              cursorEl.style.opacity = "0";
              setTimeout(() => {
                cursorEl.style.display = "none";
              }, 500);
            }
          }, 2000);
        }
      }
      typeName();
    }
  }
  typePrefix();
}

// Trigger typewriter animation on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", typeWelcomeTitle);
} else {
  typeWelcomeTitle();
}

/**
 * Toggle Debug Panel
 */
window.toggleDebugMode = function toggleDebugMode() {
  const panel = document.getElementById("debug-panel");
  if (!panel) return;
  const isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "block" : "none";
}

let lastLocalTrackTime = 0;
function showLocalTrackingForm() {
  if (isStreaming) return;

  const now = Date.now();
  if (now - lastLocalTrackTime < 3000) return; // 3s silent debounce
  lastLocalTrackTime = now;

  phHasSentMessage = true;
  clearTimeout(phTypingTimeout);
  chatInput.setAttribute("placeholder", "Ask about products, delivery, or orders…");
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();
  if (typeof clearFloatingCards === 'function') clearFloatingCards();

  const msgEl = document.createElement("div");
  msgEl.className = "message message-assistant message-enter";
  msgEl.innerHTML = `
    <div class="message-avatar">${KAVI_SVG_HTML}</div>
    <div class="message-content" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
      <div class="message-bubble">
        ${renderMarkdown("Please enter your order number below to track its status.")}
        ${renderTrackOrderForm({ type: "track_order_form" })}
      </div>
    </div>
  `;
  chatContainer.appendChild(msgEl);
  scrollToBottom();
}

// ── Global Keyboard Listener for Chat Input ──────────────────────────────────
// Automatically focus the chat input when the user starts typing on desktop/laptop.
document.addEventListener("keydown", (e) => {
  // Only apply on larger screens (desktop/laptop) to avoid virtual keyboard issues on mobile
  if (window.innerWidth < 768) return;

  // Ignore if the user is already typing in an input, textarea, or contenteditable
  const activeEl = document.activeElement;
  const isInputActive = activeEl && (
    activeEl.tagName === 'INPUT' ||
    activeEl.tagName === 'TEXTAREA' ||
    activeEl.isContentEditable
  );
  if (isInputActive) return;

  // Ignore modifier keys and special commands
  if (e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;

  // Focus the chat input
  const chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.focus();
  }
});

// ── Alternate Kavi's Picks in Sidebar ─────────────────────────────────────────
window.kavisPicksHovered = false;
window.kavisPicksLoading = false;
let kavisPicksProgress = 0;
let lastKaviPickTime = performance.now();
const pickDuration = 5000;
let kaviPicksData = [];
let currentPickIndex = 0;

async function loadKaviPicks() {
  const FALLBACK_PICKS = [
    { product_id: "cake001", name: "Blueberry Cheesecake", image_url: "https://www.kapruka.com/shops/cakes/productImages/zoom/1730193349184_blueberry.jpg", price: 8500 },
    { product_id: "flow001", name: "5 Red Roses Bouquet", image_url: "https://www.kapruka.com/shops/flowershop/flowerImages/zooms/1768475653238_dsc03002.jpg", price: 6880 },
    { product_id: "gift001", name: "Java Cinnamon Chocolates", image_url: "https://www.kapruka.com/shops/specialGifts/productImages/1761117551714_dsc01173.jpg", price: 3500 },
  ];

  try {
    const res = await fetch(`${BACKEND_URL}/products/picks`);
    if (!res.ok) throw new Error("picks endpoint failed");
    const data = await res.json();
    if (data.picks && data.picks.length > 0) {
      kaviPicksData = data.picks;
      renderKaviPicks();
      requestAnimationFrame(updateKavisPicks);
    } else {
      // Use fallback picks instead of hiding the section
      kaviPicksData = FALLBACK_PICKS;
      renderKaviPicks();
      requestAnimationFrame(updateKavisPicks);
    }
  } catch (err) {
    console.warn("Kavi picks unavailable, using fallback", err);
    // Show fallback picks so section is never blank
    kaviPicksData = FALLBACK_PICKS;
    renderKaviPicks();
    requestAnimationFrame(updateKavisPicks);
  }
}

function renderKaviPicks() {
  const container = document.getElementById('kavis-picks-container');
  if (!container) return;

  let html = '';
  kaviPicksData.forEach((pick, i) => {
    const isFirst = i === 0;
    const safeNameForAttr = (pick.name || "").replace(/"/g, '&quot;').replace(/'/g, '\\&#39;');
    html += `
      <div id="kavis-pick-${i}" class="kavi-pick-slide ${isFirst ? 'active' : ''}" 
           onclick="handlePickClick('${pick.product_id}', '${safeNameForAttr}', this)"
           style="display: flex; gap: 16px; padding: 22px 16px; align-items: center; cursor: pointer; transition: opacity 0.5s ease; opacity: ${isFirst ? '1' : '0'}; ${isFirst ? 'position: relative;' : 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;'}">
        <div style="position: relative; width: 70px; height: 70px; flex-shrink: 0;">
          <div class="image-loading-spinner" style="width: 20px; height: 20px;"></div>
          <img src="${escapeHtml(pick.image_url)}" style="position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 8px; object-fit: cover;" alt="${escapeHtml(pick.name)}" onload="this.previousElementSibling.style.display='none';" onerror="this.previousElementSibling.style.display='none';" />
        </div>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span style="font-size: 0.95rem; font-weight: 600; color: #fff; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${escapeHtml(pick.name)}</span>
          <span style="font-size: 0.8rem; color: #f8da08; font-weight: 500;">★ LKR ${pick.price.toLocaleString()}</span>
        </div>
      </div>
    `;
  });
  html += `<div style="position: absolute; bottom: 0; left: 0; width: 100%; height: 3px; background: rgba(255,255,255,0.1);"><div id="kavis-picks-progress" style="height: 100%; width: 0%; background: #f8da08; box-shadow: 0 0 8px rgba(248, 218, 8, 0.6); transition: width 0.1s linear;"></div></div>`;
  container.innerHTML = html;
}

async function handlePickClick(productId, name, elem) {
  if (elem) {
    if (elem.style.pointerEvents === 'none') return;
    elem.style.pointerEvents = 'none';
    elem.style.opacity = '0.5';
  }
  window.kavisPicksLoading = true;

  // Mobile: close sidebar if open
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  if (sidebar && sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("active");
  }

  phHasSentMessage = true;
  clearTimeout(phTypingTimeout);
  chatInput.setAttribute("placeholder", "Ask about products, delivery, or orders…");
  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();
  if (typeof clearFloatingCards === 'function') clearFloatingCards();

  // Synthesize message in UI
  const msgText = `Tell me more about ${name}.`;
  addUserMessage(msgText);

  // Build standard chat container
  if (!threadId) {
    threadId = crypto.randomUUID();
    sessionStorage.setItem("kapruka_thread_id", threadId);
  }
  const typingId = "msg-" + Date.now();
  const responseBubbleHtml = `
    <div class="message message-assistant fade-in" id="${typingId}">
      <div class="message-avatar">${KAVI_SVG_HTML}</div>
      <div class="message-content" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
        <div class="status-bubble-container">
          <div class="status-bubble">
            <div class="status-icon-wrapper">
              <svg viewBox="0 0 24 24" class="status-icon anim-spin" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
            </div>
            <span class="status-text"><i>Fetching details...</i></span>
          </div>
        </div>
        <div class="message-bubble markdown-content" style="display: none;"></div>
      </div>
    </div>
  `;
  const chatContainer = document.getElementById("chat-container");
  chatContainer.insertAdjacentHTML("beforeend", responseBubbleHtml);
  scrollToBottom();

  try {
    const res = await fetch(`${BACKEND_URL}/products/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        thread_id: threadId,
        product_id: productId,
        name: name,
      }),
    });
    const data = await res.json();

    const bubbleEl = document.getElementById(typingId)?.querySelector(".markdown-content");
    const statusContainer = document.getElementById(typingId)?.querySelector(".status-bubble-container");
    if (statusContainer) statusContainer.style.display = "none";



    let productCardsHtml = "";
    if (data.cards && data.cards.length > 0) {
      let filteredCards = data.cards;
      const inTrackingContext = filteredCards.some(c => c.type === "track_order_form" || c.type === "order_tracking");
      if (inTrackingContext) {
        filteredCards = filteredCards.filter(c => c.type !== "checkout_form");
      }

      const pCards = filteredCards.filter(c => c.type === "product");
      if (pCards.length > 0) productCardsHtml += renderProductCards(pCards);
      const detailCards = filteredCards.filter(c => c.type === "product_detail");
      if (detailCards.length > 0) productCardsHtml += renderProductDetailCards(detailCards);

      const cartSummaryCard = filteredCards.find(c => c.type === "cart_summary");
      if (cartSummaryCard && cartSummaryCard.items && cartSummaryCard.items.length > 0 && !inTrackingContext) {
        productCardsHtml += `<div style="margin-top: 12px;"><button class="checkout-btn" style="padding: 10px 16px; font-size: 0.9rem; width: auto;" onclick="openCart()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: middle; position: relative; top: -1px;"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>View Cart</button></div>`;
      }
    }

    if (bubbleEl) {
      bubbleEl.style.display = "block";
      bubbleEl.innerHTML = renderMarkdown(data.text || "") + productCardsHtml;
    }
    scrollToBottom();

    if (data.cart) {
      setCart(data.cart);
    }
    if (elem) {
      elem.style.pointerEvents = '';
      elem.style.opacity = elem.classList.contains('active') ? '1' : '0';
    }
    window.kavisPicksLoading = false;
    kavisPicksProgress = 0;
  } catch (err) {
    console.error("Error fetching product details", err);
    if (document.getElementById(typingId)) {
      const bubbleEl = document.getElementById(typingId).querySelector(".markdown-content");
      const statusContainer = document.getElementById(typingId).querySelector(".status-bubble-container");
      if (statusContainer) statusContainer.style.display = "none";
      if (bubbleEl) {
        bubbleEl.innerHTML = "Sorry, I couldn't fetch the details for that product right now.";
        bubbleEl.style.display = "block";
      }
    }
    if (elem) {
      setTimeout(() => {
        elem.style.pointerEvents = '';
        elem.style.opacity = elem.classList.contains('active') ? '1' : '0';
      }, 3000);
    }
    window.kavisPicksLoading = false;
    kavisPicksProgress = 0;
  }
}

function updateKavisPicks(time) {
  if (kaviPicksData.length === 0) return;

  const dt = time - lastKaviPickTime;
  lastKaviPickTime = time;

  if (!window.kavisPicksHovered && !window.kavisPicksLoading) {
    kavisPicksProgress += dt;

    if (kavisPicksProgress >= pickDuration) {
      kavisPicksProgress = 0;

      const oldPick = document.getElementById(`kavis-pick-${currentPickIndex}`);
      currentPickIndex = (currentPickIndex + 1) % kaviPicksData.length;
      const newPick = document.getElementById(`kavis-pick-${currentPickIndex}`);

      if (oldPick && newPick) {
        oldPick.style.opacity = '0';
        oldPick.style.pointerEvents = 'none';
        oldPick.classList.remove('active');
        newPick.style.opacity = '1';
        newPick.style.pointerEvents = 'auto';
        newPick.classList.add('active');
      }
    }

    const bar = document.getElementById('kavis-picks-progress');
    if (bar) {
      const pct = (kavisPicksProgress / pickDuration) * 100;
      bar.style.width = pct + '%';
    }
  }

  requestAnimationFrame(updateKavisPicks);
}

// Initialize Kavi's Picks
loadKaviPicks();

// Add scroll event listener to chat container for "scroll to bottom" button
document.addEventListener("DOMContentLoaded", () => {
  const chatContainer = document.getElementById("chat-container");
  const scrollBtn = document.getElementById("scroll-to-bottom-btn");

  if (chatContainer && scrollBtn) {
    chatContainer.addEventListener("scroll", () => {
      // If we are scrolled up more than 300px from the bottom, show the button
      const distanceFromBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
      if (distanceFromBottom > 300) {
        scrollBtn.classList.add("visible");
      } else {
        scrollBtn.classList.remove("visible");
      }
    });
  }
});

const DEFAULT_FIND_ME_PRODUCTS = [
  { icon: '<i class="fa-solid fa-cake-candles" style="color: #ff9cf9;"></i>', text: 'Birthday Cakes', query: 'Show me birthday cakes' },
  { icon: '<i class="fa-solid fa-pizza-slice" style="color: #ffb84d;"></i>', text: 'Pizzas', query: 'Show me pizzas' },
  { icon: '<i class="fa-solid fa-cookie-bite" style="color: #d2691e;"></i>', text: 'Chocolates', query: 'Show me chocolate boxes' },
  { icon: '<i class="fa-solid fa-paw" style="color: #deb887;"></i>', text: 'Teddy Bears', query: 'Show me big teddy bears' },
  { icon: '<i class="fa-solid fa-stopwatch" style="color: #c0c0c0;"></i>', text: 'Men\'s Watches', query: 'Show me men\'s watches' },
  { icon: '<i class="fa-solid fa-person-dress" style="color: #ff69b4;"></i>', text: 'Ladies Dresses', query: 'Show me ladies dresses' },
  { icon: '<i class="fa-solid fa-shirt" style="color: #87ceeb;"></i>', text: 'Men\'s Shirts', query: 'Show me men\'s shirts' },
  { icon: '<i class="fa-solid fa-mobile-screen-button" style="color: #b0c4de;"></i>', text: 'Smartphones', query: 'Show me latest smartphones' },
  { icon: '<i class="fa-solid fa-cake-candles" style="color: #ffa07a;"></i>', text: 'Cupcakes', query: 'Show me assorted cupcakes' },
  { icon: '<i class="fa-solid fa-burger" style="color: #d2b48c;"></i>', text: 'Burgers', query: 'Show me burgers' },
  { icon: '<i class="fa-solid fa-headphones" style="color: #20b2aa;"></i>', text: 'Headphones', query: 'Show me wireless headphones' },
  { icon: '<i class="fa-solid fa-cake-candles" style="color: #8b4513;"></i>', text: 'Chocolate Cakes', query: 'Show me chocolate cakes' },
  { icon: '<i class="fa-solid fa-spa" style="color: #ff69b4;"></i>', text: 'Flower Bouquets', query: 'Show me beautiful flower bouquets' },
  { icon: '<i class="fa-solid fa-bag-shopping" style="color: #db7093;"></i>', text: 'Handbags', query: 'Show me ladies handbags' },
  { icon: '<i class="fa-solid fa-spray-can-sparkles" style="color: rgb(255, 212, 59);"></i>', text: 'Perfumes', query: 'Show me branded perfumes' },
  { icon: '<i class="fa-solid fa-apple-whole" style="color: #ff6347;"></i>', text: 'Fresh Fruits', query: 'Show me fresh fruit baskets' },
  { icon: '<i class="fa-solid fa-gem" style="color: #9370db;"></i>', text: 'Jewellery', query: 'Search for jewellery and pendants' },
  { icon: '<i class="fa-solid fa-basket-shopping" style="color: #d2691e;"></i>', text: 'Chocolate Hampers', query: 'Search for chocolate hampers' },
  { icon: '<i class="fa-solid fa-kitchen-set" style="color: #a9a9a9;"></i>', text: 'Ovens', query: 'Search for microwave ovens and baking ovens' },
  { icon: '<i class="fa-solid fa-clock" style="color: #4682b4;"></i>', text: 'Smart Watches', query: 'Search for latest smart watches' },
  { icon: '<i class="fa-solid fa-bottle-water" style="color: #00ced1;"></i>', text: 'Tumblers', query: 'Search for tumblers and water bottles' },
  { icon: '<i class="fa-solid fa-gift" style="color: #ff1493;"></i>', text: 'Customized Gifts', query: 'Search for customized gifts and personalized items' }
];

let dynamicFindMeProducts = [...DEFAULT_FIND_ME_PRODUCTS];
let currentFindMeIndex = 0;

function updateFindMeContext(products) {
  if (!products || !products.length) return;

  const text = products.map(p => (p.name || '').toLowerCase()).join(' ');
  const newSuggestions = [];

  if (text.includes('cake')) {
    newSuggestions.push({ icon: '<i class="fa-solid fa-cake-candles" style="color: #ff9cf9;"></i>', text: 'Birthday Candles', query: 'Show me birthday candles' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-gift" style="color: #ff69b4;"></i>', text: 'Greeting Cards', query: 'Show me greeting cards for birthdays' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-cake-candles" style="color: #ffa07a;"></i>', text: 'Cupcakes', query: 'Show me cupcakes' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-face-smile-wink" style="color: #ffb6c1;"></i>', text: 'Party Hats', query: 'Show me party hats' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-glass-cheers" style="color: #ffd700;"></i>', text: 'Sparklers', query: 'Show me sparklers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-champagne-glasses" style="color: #dda0dd;"></i>', text: 'Party Poppers', query: 'Show me party poppers' });
  }
  if (text.includes('flower') || text.includes('rose') || text.includes('lily')) {
    newSuggestions.push({ icon: '<i class="fa-solid fa-cookie-bite" style="color: #d2691e;"></i>', text: 'Chocolates', query: 'Show me chocolates to go with flowers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-bag-shopping" style="color: #db7093;"></i>', text: 'Teddy Bears', query: 'Show me teddy bears' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-jar" style="color: #87ceeb;"></i>', text: 'Glass Vases', query: 'Show me glass vases' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-spray-can-sparkles" style="color: #ffd700;"></i>', text: 'Perfumes', query: 'Show me branded perfumes' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-gift" style="color: #ff1493;"></i>', text: 'Gift Wrappers', query: 'Show me gift wrappers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-heart" style="color: #ff0000;"></i>', text: 'Anniversary Cards', query: 'Show me anniversary cards' });
  }
  if (text.includes('chocolate') || text.includes('ferrero') || text.includes('lindt')) {
    newSuggestions.push({ icon: '<i class="fa-solid fa-spa" style="color: #ff69b4;"></i>', text: 'Flowers', query: 'Show me flower bouquets' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-basket-shopping" style="color: #d2691e;"></i>', text: 'Gift Hampers', query: 'Show me gift hampers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-mug-hot" style="color: #8b4513;"></i>', text: 'Coffee Mugs', query: 'Show me coffee mugs' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-cookie" style="color: #cd853f;"></i>', text: 'Biscuits', query: 'Show me premium biscuits' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-wine-glass" style="color: #800080;"></i>', text: 'Non-Alcoholic Wine', query: 'Show me non alcoholic wine' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-cake-candles" style="color: #8b4513;"></i>', text: 'Chocolate Cakes', query: 'Show me chocolate cakes' });
  }
  if (text.includes('watch') || text.includes('phone') || text.includes('laptop')) {
    newSuggestions.push({ icon: '<i class="fa-solid fa-headphones" style="color: #20b2aa;"></i>', text: 'Headphones', query: 'Show me headphones' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-plug" style="color: #b0c4de;"></i>', text: 'Power Banks', query: 'Show me power banks' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-mobile" style="color: #4682b4;"></i>', text: 'Phone Covers', query: 'Show me phone covers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-battery-full" style="color: #32cd32;"></i>', text: 'Chargers', query: 'Show me mobile chargers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-sd-card" style="color: #000000;"></i>', text: 'Memory Cards', query: 'Show me memory cards' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-gamepad" style="color: #ff4500;"></i>', text: 'Gaming Accessories', query: 'Show me gaming accessories' });
  }
  if (text.includes('toy') || text.includes('kid')) {
    newSuggestions.push({ icon: '<i class="fa-solid fa-child-reaching" style="color: #ff69b4;"></i>', text: 'Kids Clothes', query: 'Show me kids clothes' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-book" style="color: #4682b4;"></i>', text: 'Children Books', query: 'Show me children books' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-shapes" style="color: #32cd32;"></i>', text: 'Educational Toys', query: 'Show me educational toys' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-puzzle-piece" style="color: #ffa500;"></i>', text: 'Puzzles', query: 'Show me puzzles' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-pencil" style="color: #ffd700;"></i>', text: 'Stationery', query: 'Show me kids stationery' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-candy-cane" style="color: #ff0000;"></i>', text: 'Sweets', query: 'Show me sweets and candies' });
  }
  if (text.includes('pizza') || text.includes('burger')) {
    newSuggestions.push({ icon: '<i class="fa-solid fa-bottle-water" style="color: #00ced1;"></i>', text: 'Beverages', query: 'Show me cold beverages and drinks' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-cookie-bite" style="color: #d2691e;"></i>', text: 'Desserts', query: 'Show me desserts' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-bowl-food" style="color: #ffa500;"></i>', text: 'Appetizers', query: 'Show me appetizers' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-ice-cream" style="color: #ffb6c1;"></i>', text: 'Ice Cream', query: 'Show me ice cream' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-utensils" style="color: #a9a9a9;"></i>', text: 'Pasta', query: 'Show me pasta' });
    newSuggestions.push({ icon: '<i class="fa-solid fa-fire" style="color: #ff4500;"></i>', text: 'Spicy Food', query: 'Show me spicy food' });
  }

  if (newSuggestions.length > 0) {
    const uniqueSuggestions = newSuggestions.filter((s, index, self) =>
      index === self.findIndex((t) => (t.text === s.text))
    );

    dynamicFindMeProducts = [...uniqueSuggestions, ...DEFAULT_FIND_ME_PRODUCTS];
    currentFindMeIndex = 0;
    cycleFindMeCategories();
  }
}


function cycleFindMeCategories() {
  const allSlots = [
    document.getElementById('find-me-slot-0'),
    document.getElementById('find-me-slot-1'),
    document.getElementById('find-me-slot-2'),
    document.getElementById('find-me-slot-3'),
    document.getElementById('find-me-slot-4'),
    document.getElementById('find-me-slot-5')
  ];

  // Filter out any slot that is hidden via CSS (e.g. on small screens)
  const slots = allSlots.filter(s => s && window.getComputedStyle(s).display !== 'none');

  if (slots.length === 0) return;

  for (let i = 0; i < slots.length; i++) {
    const category = dynamicFindMeProducts[(currentFindMeIndex + i) % dynamicFindMeProducts.length];

    // Stagger each button's transition by 150ms
    setTimeout(() => {
      slots[i].style.transition = "opacity 0.3s ease, transform 0.3s ease";
      slots[i].style.opacity = 0;
      slots[i].style.transform = "translateY(4px)";

      setTimeout(() => {
        slots[i].innerHTML = `
          <span class="qa-icon qa-icon-find">${category.icon}</span>
          <span>${category.text}</span>
        `;
        slots[i].onclick = () => sendQuickAction(category.query);
        slots[i].style.opacity = 1;
        slots[i].style.transform = ""; // clear inline transform so hover CSS applies
      }, 300);
    }, i * 200); // 200ms delay between each button starting its animation
  }

  currentFindMeIndex = (currentFindMeIndex + slots.length) % dynamicFindMeProducts.length;
}

document.addEventListener("DOMContentLoaded", () => {
  cycleFindMeCategories();
  setInterval(cycleFindMeCategories, 8000);
});

// ── Check Delivery Info ─────────────────────────────────────────────────────
function openCheckDeliveryModal() {
  const modal = document.getElementById("check-delivery-modal");
  if (!modal) return;
  modal.classList.add("active");

  // Set min date to today — past dates are blocked, today and future are allowed
  const dateInput = document.getElementById("delivery-date");
  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    dateInput.min = `${yyyy}-${mm}-${dd}`;
    // Clear any previously selected date that is now in the past
    if (dateInput.value && dateInput.value < dateInput.min) {
      dateInput.value = "";
    }
  }

  const cityInput = document.getElementById("delivery-city");
  if (cityInput) setTimeout(() => cityInput.focus(), 320);

  // Close sidebar on mobile
  if (window.innerWidth <= 768) {
    const sb = document.getElementById("sidebar");
    const sbo = document.getElementById("sidebar-overlay");
    if (sb) sb.classList.remove("open");
    if (sbo) sbo.classList.remove("active");
  }
}

function closeCheckDeliveryModal() {
  const modal = document.getElementById("check-delivery-modal");
  if (modal) modal.classList.remove("active");
}

async function handleCheckDelivery(e) {
  e.preventDefault();
  const btn = document.getElementById("check-delivery-submit-btn");
  const resultDiv = document.getElementById("delivery-result-container");
  if (!btn || !resultDiv) return;

  const city = document.getElementById("delivery-city").value.trim();
  const date = document.getElementById("delivery-date").value;

  btn.disabled = true;
  btn.innerHTML = `<span class="status-spinner" style="width: 14px; height: 14px; border-width: 2px; border-top-color: white; margin-right: 6px;"></span> Checking...`;
  resultDiv.style.display = "none";
  resultDiv.innerHTML = "";

  try {
    const res = await fetch(`${BACKEND_URL}/checkout/check_delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: city, delivery_date: date })
    });

    if (!res.ok) throw new Error("Request failed");

    const data = await res.json();
    resultDiv.style.display = "block";

    // ── Case 1: Ambiguous / not found city — show suggestion chips ────────
    if (!data.available && data.suggestions && data.suggestions.length > 0) {
      const chipsHtml = data.suggestions.map(s => `
        <button type="button" onclick="selectDeliveryCity('${s.replace(/'/g, "\\'")}')"
          style="
            display: inline-flex; align-items: center; gap: 5px;
            padding: 6px 12px; border-radius: 20px; border: 1px solid rgba(248,218,8,0.35);
            background: rgba(248,218,8,0.08); color: rgba(255,255,255,0.9);
            font-size: 0.8rem; font-weight: 500; cursor: pointer;
            transition: background 0.2s, border-color 0.2s;
          "
          onmouseover="this.style.background='rgba(248,218,8,0.18)'; this.style.borderColor='rgba(248,218,8,0.6)';"
          onmouseout="this.style.background='rgba(248,218,8,0.08)'; this.style.borderColor='rgba(248,218,8,0.35)';">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f8da08" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="4"/><path d="M12 2C8.13 2 5 5.13 5 10c0 5.25 7 12 7 12s7-6.75 7-12c0-4.87-3.13-8-7-8z"/></svg>
          ${escapeHtml(s)}
        </button>`).join("");

      resultDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; color: #f8da08; font-weight: 600; margin-bottom: 10px; font-size: 0.92rem;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Did you mean one of these?
        </div>
        <p style="margin: 0 0 10px; font-size: 0.82rem; color: rgba(255,255,255,0.55);">
          "${escapeHtml(city)}" matches multiple regions — pick one to check:
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          ${chipsHtml}
        </div>`;
      return;
    }

    // ── Case 2: Delivery available ────────────────────────────────────────
    if (data.available) {
      const perishableWarning = data.perishable_warning
        ? `<p style="margin: 8px 0 0; font-size: 0.82rem; padding: 6px 10px; border-radius: 8px; background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.25); color: #fbbf24;">
             ⚠ ${escapeHtml(data.perishable_warning)}
           </p>`
        : "";

      resultDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; color: #10b981; font-weight: 600; margin-bottom: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          Delivery Available!
        </div>
        <p style="margin: 0; font-size: 0.9rem;"><strong>City:</strong> ${escapeHtml(data.canonical_city || city)}</p>
        <p style="margin: 4px 0 0; font-size: 0.9rem;"><strong>Date:</strong> ${escapeHtml(data.delivery_date || "")}</p>
        <p style="margin: 4px 0 0; font-size: 0.9rem;"><strong>Delivery Fee:</strong> ${data.rate !== null && data.rate !== undefined ? 'LKR ' + data.rate : 'Calculated at checkout'}</p>
        ${perishableWarning}`;
      return;
    }

    // ── Case 3: Not available (clear city, with reason / next date) ───────
    resultDiv.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; color: #ef4444; font-weight: 600; margin-bottom: 8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Delivery Not Available
      </div>
      <p style="margin: 0; font-size: 0.9rem; color: #fca5a5;">${escapeHtml(data.reason || data.message || "Not available on this date.")}</p>
      ${data.next_available_date ? `<p style="margin: 8px 0 0; font-size: 0.9rem;"><strong>Next Available:</strong> ${escapeHtml(data.next_available_date)}</p>` : ''}`;

  } catch (error) {
    console.error("Delivery check error:", error);
    resultDiv.style.display = "block";
    resultDiv.innerHTML = `<div style="color: #ef4444; font-size: 0.9rem;">Failed to check delivery. Please try again.</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Check Availability`;
  }
}

// Auto-fill city suggestion and re-submit
function selectDeliveryCity(city) {
  const cityInput = document.getElementById("delivery-city");
  if (cityInput) {
    cityInput.value = city;
    // Animate the input so it's visually clear what was selected
    cityInput.style.transition = "border-color 0.2s, box-shadow 0.2s";
    cityInput.style.borderColor = "rgba(248,218,8,0.7)";
    cityInput.style.boxShadow = "0 0 0 3px rgba(248,218,8,0.15)";
    setTimeout(() => {
      cityInput.style.borderColor = "";
      cityInput.style.boxShadow = "";
    }, 1200);
  }
  // Re-submit the form after a brief visual pause
  setTimeout(() => {
    const form = document.getElementById("check-delivery-form");
    if (form) form.requestSubmit();
  }, 350);
}

// ── Checkout Modal Overlay ──────────────────────────────────────────────────
function openCheckoutModal(url) {
  const modal = document.getElementById("checkout-modal");
  const iframe = document.getElementById("checkout-iframe");
  const loader = document.getElementById("checkout-loader");
  if (modal && iframe && loader) {
    loader.style.display = "flex";
    iframe.src = url;
    modal.classList.add("active");
  }
}

function closeCheckoutModal() {
  const modal = document.getElementById("checkout-modal");
  const iframe = document.getElementById("checkout-iframe");
  if (modal && iframe) {
    modal.classList.remove("active");
    // clear src after animation finishes to stop media/loading
    setTimeout(() => {
      iframe.src = "";
    }, 300);
  }
}

// ── Flash Search ────────────────────────────────────────────────────────────
function openFlashSearchModal() {
  const modal = document.getElementById("flash-search-modal");
  if (!modal) return;

  // Reset form to defaults
  const productInput = document.getElementById("flash-product");
  if (productInput) { productInput.value = ""; productInput.classList.remove("shake"); }

  const budgetToggle = document.getElementById("flash-budget-toggle");
  if (budgetToggle) budgetToggle.checked = false;
  const budgetWrap = document.getElementById("flash-budget-wrap");
  if (budgetWrap) budgetWrap.classList.remove("visible");
  const budgetSlider = document.getElementById("flash-budget");
  if (budgetSlider) budgetSlider.value = 15000;
  const budgetDisplay = document.getElementById("flash-budget-display");
  if (budgetDisplay) budgetDisplay.textContent = "15,000";

  // Reset sort to default (newest)
  document.querySelectorAll(".flash-sort-pill").forEach(pill => pill.classList.remove("active"));
  const defaultPill = document.querySelector(".flash-sort-pill[data-sort='newest']");
  if (defaultPill) defaultPill.classList.add("active");

  const keywordToggle = document.getElementById("flash-keyword-toggle");
  if (keywordToggle) keywordToggle.checked = false;
  const keywordWrap = document.getElementById("flash-keyword-wrap");
  if (keywordWrap) keywordWrap.classList.remove("visible");
  const keywordInput = document.getElementById("flash-keyword");
  if (keywordInput) keywordInput.value = "";

  modal.classList.add("active");

  // Focus product input after animation
  setTimeout(() => { if (productInput) productInput.focus(); }, 320);

  // Close sidebar on mobile when modal opens
  if (window.innerWidth <= 768) {
    const sb = document.getElementById("sidebar");
    const sbo = document.getElementById("sidebar-overlay");
    if (sb) sb.classList.remove("open");
    if (sbo) sbo.classList.remove("active");
  }
}

function closeFlashSearchModal() {
  const modal = document.getElementById("flash-search-modal");
  if (modal) modal.classList.remove("active");
}

function toggleFlashBudget(checkbox) {
  const wrap = document.getElementById("flash-budget-wrap");
  if (wrap) wrap.classList.toggle("visible", checkbox.checked);
}

function toggleFlashKeyword(checkbox) {
  const wrap = document.getElementById("flash-keyword-wrap");
  if (wrap) wrap.classList.toggle("visible", checkbox.checked);
  if (checkbox.checked) {
    setTimeout(() => {
      const kw = document.getElementById("flash-keyword");
      if (kw) kw.focus();
    }, 200);
  }
}

function selectFlashSort(btn) {
  document.querySelectorAll(".flash-sort-pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
}

function updateFlashBudgetDisplay(value) {
  const display = document.getElementById("flash-budget-display");
  if (display) display.textContent = parseInt(value).toLocaleString();
}

function submitFlashSearch() {
  const productInput = document.getElementById("flash-product");

  // Validate — product is required
  if (!productInput || !productInput.value.trim()) {
    if (productInput) {
      productInput.classList.remove("shake");
      void productInput.offsetWidth; // force reflow to restart animation
      productInput.classList.add("shake");
      productInput.focus();
      setTimeout(() => productInput.classList.remove("shake"), 500);
    }
    return;
  }

  const product = productInput.value.trim();

  // Budget
  const budgetEnabled = document.getElementById("flash-budget-toggle")?.checked;
  const budgetValue = budgetEnabled
    ? parseInt(document.getElementById("flash-budget")?.value || 15000).toLocaleString()
    : null;

  // Sort
  const activePill = document.querySelector(".flash-sort-pill.active");
  const sortLabel = activePill?.dataset?.sort || "newest";

  // Keyword / category narrowing
  const keywordEnabled = document.getElementById("flash-keyword-toggle")?.checked;
  const keyword = keywordEnabled ? (document.getElementById("flash-keyword")?.value?.trim() || "") : "";

  // Build the hybrid natural+structured query
  let query = `Find me ${product}`;
  if (keyword) query += `, specifically ${keyword}`;
  if (budgetValue) query += ` (budget: under LKR ${budgetValue})`;
  query += `, sorted by ${sortLabel}`;
  query += `. Please search Kapruka for this and show me the results.`;

  // Close modal and fire the query as a regular chat message
  closeFlashSearchModal();
  sendQuickAction(query);
}

// ── Duplicate Click Cooldown Safeguard ──────────────────────────────────────
function shouldDebounceButton(button) {
  // Exclude quantity stepper buttons
  if (button.classList.contains("qty-btn")) return false;
  if (button.textContent.trim() === "+" || button.textContent.trim() === "-") return false;

  // Exclude carousel navigation arrows
  if (button.classList.contains("carousel-arrow")) return false;

  // Exclude modal close and toggle buttons where cooldown feels laggy
  if (button.classList.contains("close-modal") || button.classList.contains("close-cart-btn")) return false;
  if (button.id === "sidebar-toggle" || button.id === "debug-toggle-btn") return false;

  // Exclude send button during streaming so user can stop it immediately
  if (button.id === "send-btn" && button.classList.contains("streaming")) return false;

  // Exclude sorting pills so switching preferences is instant
  if (button.classList.contains("flash-sort-pill")) return false;

  // Exclude check delivery submit since it handles its own loading state
  if (button.id === "check-delivery-submit-btn") return false;

  // Exclude Add to Cart on product cards so successive additions work smoothly
  if (button.classList.contains("pcard-btn") || button.classList.contains("pcard-btn-primary")) return false;

  return true;
}

document.addEventListener("click", function (e) {
  const button = e.target.closest("button");
  if (!button || !shouldDebounceButton(button)) return;

  // Block click if it is on cooldown
  if (button.dataset.clicked === "true") {
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Mark button as clicked
  button.dataset.clicked = "true";

  // Disable clicks and visually fade button
  const originalPointerEvents = button.style.pointerEvents;
  button.style.pointerEvents = "none";
  button.classList.add("btn-disabled-cooldown");

  setTimeout(() => {
    button.removeAttribute("data-clicked");
    button.style.pointerEvents = originalPointerEvents;
    button.classList.remove("btn-disabled-cooldown");
  }, 3000);
}, true); // Use capture phase to intercept before target onclick handlers execute

// ── Floating 3D Cards ───────────────────────────────────────────────────────



let currentFloatingCardUpdateIndex = 0;
let currentFloatingIndices = [];

async function loadDynamicFloatingProducts() {
  try {
    const res = await fetch('products.json?t=' + new Date().getTime());
    if (!res.ok) return;
    const products = await res.json();
    if (products && products.length > 6) {
      dynamicFloatingProducts = products;

      const byCategory = {};
      products.forEach((p, idx) => {
        const cat = p.category || 'Other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(idx);
      });

      const categories = Object.keys(byCategory).sort(() => 0.5 - Math.random());

      let selected = [];
      let catIdx = 0;
      while (selected.length < 6 && selected.length < products.length) {
        const cat = categories[catIdx % categories.length];
        const items = byCategory[cat];
        const unselected = items.filter(idx => !selected.includes(idx));
        if (unselected.length > 0) {
          const randItem = unselected[Math.floor(Math.random() * unselected.length)];
          selected.push(randItem);
        }
        catIdx++;
        if (catIdx > 100) break;
      }

      for (let i = 0; i < 6; i++) {
        currentFloatingIndices[i] = selected[i];
      }

      // Re-render once we have the data so the real cards show up
      renderFloatingCards();

      // Start rotating one card every 3.5 seconds
      if (!floatingCardInterval) {
        floatingCardInterval = setInterval(() => {
          const container = document.getElementById("floating-cards-container");
          if (!container || container.style.display === "none" || container.classList.contains("fly-away")) {
            return;
          }

          const wrappers = container.querySelectorAll('.floating-card-wrapper');
          if (wrappers.length > currentFloatingCardUpdateIndex) {
            const wrapper = wrappers[currentFloatingCardUpdateIndex];
            // Don't change the card if the user is hovering over it
            if (wrapper.matches(':hover')) {
              currentFloatingCardUpdateIndex = (currentFloatingCardUpdateIndex + 1) % 6;
              return;
            }
          }

          const displayedCategories = currentFloatingIndices.map(idx => dynamicFloatingProducts[idx].category || 'Other');

          let candidates = [];
          for (let i = 0; i < dynamicFloatingProducts.length; i++) {
            if (!currentFloatingIndices.includes(i)) {
              const cat = dynamicFloatingProducts[i].category || 'Other';
              if (!displayedCategories.includes(cat)) {
                candidates.push(i);
              }
            }
          }

          if (candidates.length === 0) {
            candidates = Array.from({ length: dynamicFloatingProducts.length }, (_, i) => i)
              .filter(i => !currentFloatingIndices.includes(i));
          }

          const nextIdx = candidates[Math.floor(Math.random() * candidates.length)];
          currentFloatingIndices[currentFloatingCardUpdateIndex] = nextIdx;
          updateSingleFloatingCard(currentFloatingCardUpdateIndex);

          currentFloatingCardUpdateIndex = (currentFloatingCardUpdateIndex + 1) % 6;
        }, 3500);
      }
    }
  } catch (err) {
    console.error("Failed to load products.json for dynamic floating cards:", err);
  }
}

function getShortCategory(title, category) {
  const t = (title || "").toLowerCase();
  if (t.includes('plush') || t.includes('soft toy') || t.includes('teddy')) return 'plush toys';
  if (t.includes('cheese cake') || t.includes('cheesecake')) return 'cheese cakes';
  if (t.includes('ribbon cake')) return 'ribbon cakes';
  if (t.includes('sponge cake')) return 'sponge cakes';
  if (t.includes('chocolate cake')) return 'chocolate cakes';
  if (t.includes('bento cake')) return 'bento cakes';
  if (t.includes('cake')) return 'cakes';
  if (t.includes('bouquet') || t.includes('roses') || t.includes('flower')) return 'flowers';
  if (t.includes('watch')) return 'watches';
  if (t.includes('pen')) return 'pens';
  if (t.includes('chocolate')) return 'chocolates';
  if (t.includes('plant')) return 'plants';
  if (t.includes('perfume') || t.includes('cologne')) return 'perfumes';
  if (t.includes('handbag') || t.includes('bag')) return 'handbags';
  if (t.includes('phone') || t.includes('smartphone')) return 'smartphones';
  if (t.includes('dress')) return 'dresses';
  if (t.includes('saree')) return 'sarees';
  if (t.includes('shirt') || t.includes('t-shirt') || t.includes('top')) return 'shirts';
  if (t.includes('shoe') || t.includes('sandal') || t.includes('heel') || t.includes('footwear')) return 'shoes';
  if (t.includes('toy')) return 'toys';
  if (t.includes('mug')) return 'mugs';
  if (t.includes('book')) return 'books';
  if (t.includes('hamper')) return 'hampers';
  if (t.includes('grocery') || t.includes('groceries')) return 'groceries';

  if (category && category.trim()) {
    let cat = category.toLowerCase().trim();
    if (cat.includes('womens') || cat.includes("women's")) {
      cat = cat.replace("womens", "").replace("women's", "").trim();
      if (!cat) return "women's clothing";
    }
    return cat;
  }

  const cleanTitle = (title || "").replace(/[^a-zA-Z0-9 ]/g, '');
  const words = cleanTitle.split(' ').filter(w => w.trim() && !['for', 'girl', 'boy', 'kid', 'kids', 'sri', 'lanka', 'womens', 'mens', 'women', 'men', 'ladies', 'gents'].includes(w.toLowerCase()));
  if (words.length > 0) {
    let noun = words[words.length - 1].toLowerCase();
    if (!noun.endsWith('s')) noun += 's';
    return noun;
  }

  return 'similar products';
}

function updateSingleFloatingCard(slotIndex) {
  const container = document.getElementById("floating-cards-container");
  if (!container) return;
  const wrappers = container.querySelectorAll('.floating-card-wrapper');
  if (wrappers.length <= slotIndex) return;

  const wrapper = wrappers[slotIndex];
  const pIdx = currentFloatingIndices[slotIndex];
  const p = dynamicFloatingProducts[pIdx];
  if (!p) return;

  let img = p.images && p.images.length > 0 ? p.images[0] : (p.image_url || "");
  // Strip 'zoom/' to use lower-res images for faster loading
  img = img.replace('/zoom/', '/').replace('/zooms/', '/');

  const title = p.name || "";
  const category = p.category || "";
  const shortCat = getShortCategory(title, category);
  const queryText = `Show me ${shortCat}`;
  const price = p.price ? formatPrice(p.price.amount, p.price.currency) : "";
  const safeQuery = escapeHtml(queryText).replace(/'/g, "\\'");
  const safeTitle = escapeHtml(title).replace(/'/g, "\\'");

  wrapper.style.transition = 'opacity 0.4s ease';
  wrapper.style.opacity = '0';

  setTimeout(() => {
    const inner = wrapper.querySelector('.floating-card-inner');
    const imgEl = wrapper.querySelector('.fc-image');
    const titleEl = wrapper.querySelector('.fc-title');
    const priceEl = wrapper.querySelector('.fc-price');

    if (inner) {
      inner.setAttribute('onclick', `sendQuickAction('${safeQuery}')`);
      inner.setAttribute('title', `Search for ${safeTitle}`);
    }
    if (imgEl) {
      imgEl.style.backgroundImage = `url('${img}')`;
    }
    if (titleEl) {
      titleEl.innerHTML = escapeHtml(title);
    }
    if (priceEl) {
      priceEl.innerHTML = price;
    }

    wrapper.style.opacity = '1';
  }, 400);
}

function renderFloatingCards() {
  const container = document.getElementById("floating-cards-container");
  if (!container) return;

  if (dynamicFloatingProducts.length === 0) {
    loadDynamicFloatingProducts();
  }

  let productsToRender = [];

  if (dynamicFloatingProducts.length >= 6) {
    productsToRender = currentFloatingIndices.map(idx => {
      const p = dynamicFloatingProducts[idx];
      let img = p.images && p.images.length > 0 ? p.images[0] : (p.image_url || "");
      img = img.replace('/zoom/', '/').replace('/zooms/', '/');
      return {
        img: img,
        title: p.name || "",
        price: p.price ? formatPrice(p.price.amount, p.price.currency) : "",
        query: `Show me ${getShortCategory(p.name, p.category)}`
      };
    });
  } else {
    // Fallback static
    productsToRender = [
      { img: "https://www.kapruka.com/shops/specialGifts/productImages/1770019772565_dsc00260.jpg", title: "Garfield Plush Toy", price: "LKR 2,500", query: "Show me plush toys" },
      { img: "https://www.kapruka.com/shops/cakes/productImages/zoom/1730193349184_blueberry.jpg", title: "Blueberry Cheese Cake", price: "LKR 8,500", query: "Show me cheese cakes" },
      { img: "https://www.kapruka.com/shops/flowershop/flowerImages/zooms/1768475653238_dsc03002.jpg", title: "5 Red Roses Bouquet", price: "LKR 6,880", query: "Show me flower bouquets" },
      { img: "https://www.kapruka.com/shops/specialGifts/productImages/1761117551714_dsc01173.jpg", title: "Java Cinnamon Chocolates", price: "LKR 3,500", query: "Show me chocolates" },
      { img: "https://www.kapruka.com/shops/specialGifts/productImages/1748257763980_30-2copy.jpg", title: "Giordano Analog Watch", price: "LKR 24,670", query: "Show me watches" },
      { img: "https://www.kapruka.com/shops/specialGifts/productImages/1756106966470_0001.jpg", title: "Personalized Pen", price: "LKR 1,200", query: "Show me pens" }
    ];
  }

  container.innerHTML = productsToRender.map((p, i) => {
    const safeQuery = escapeHtml(p.query).replace(/'/g, "\\'");
    const safeTitle = escapeHtml(p.title).replace(/'/g, "\\'");
    return `
    <div class="floating-card-wrapper" style="transform: ${floatingCardTransforms[i]}; transition: transform 0.8s ease, opacity 0.5s ease;">
      <div class="floating-card" style="animation-delay: ${i * 0.4}s">
        <div class="floating-card-inner" onclick="sendQuickAction('${safeQuery}')" title="Search for ${safeTitle}">
          <div class="fc-image" style="background-image: url('${p.img}')"></div>
          <div class="fc-info">
            <div class="fc-title">${escapeHtml(p.title)}</div>
            <div class="fc-price">${p.price}</div>
          </div>
        </div>
      </div>
    </div>
  `}).join("");
}

function clearFloatingCards() {
  const container = document.getElementById("floating-cards-container");
  if (container && !container.classList.contains("fly-away")) {
    container.classList.add("fly-away");
    setTimeout(() => {
      container.style.display = "none";
    }, 1000); // matches CSS transition
  }
}

function resetFloatingCards() {
  const container = document.getElementById("floating-cards-container");
  if (container) {
    container.style.display = "block";
    // Force reflow
    void container.offsetWidth;
    container.classList.remove("fly-away");
    renderFloatingCards();
  }
}

// ── User History Reorder Popup ──────────────────────────────────────────────
let lastReorderQuery = "";

async function fetchUserHistory() {
  try {
    const res = await fetch(`${BACKEND_URL}/user/${userId}/history?limit=5`);
    if (!res.ok) return;
    const data = await res.json();

    if (data && data.orders && data.orders.length > 0) {
      // Find the first order with cart items
      let lastOrderedItem = null;
      for (const order of data.orders) {
        if (order.cart && order.cart.length > 0) {
          lastOrderedItem = order.cart[0]; // Take the first item of the most recent order
          break;
        }
      }

      if (lastOrderedItem && lastOrderedItem.name) {
        // truncate if too long
        let itemName = lastOrderedItem.name;
        if (itemName.length > 30) {
          itemName = itemName.substring(0, 30) + "...";
        }

        lastReorderQuery = `I would like to order ${lastOrderedItem.name} again`;

        const popupText = document.getElementById("reorder-popup-text");
        if (popupText) {
          popupText.innerHTML = `Would you like to order <strong>${itemName}</strong> like we did last time?`;
        }

        const popup = document.getElementById("reorder-popup");
        if (popup) {
          // Only show if user hasn't started chatting yet
          setTimeout(() => {
            if (!phHasSentMessage && messages.length === 0) {
              popup.classList.add("show");
            }
          }, 2500);
        }
      }
    }
  } catch (err) {
    console.error("Error fetching user history:", err);
  }
}

function handleReorderClick() {
  if (lastReorderQuery) {
    sendQuickAction(lastReorderQuery, `[ui_action:search] ${lastReorderQuery}`);
    closeReorderPopup(new Event('click'));
  }
}

function closeReorderPopup(event) {
  if (event) {
    event.stopPropagation();
  }
  const popup = document.getElementById("reorder-popup");
  if (popup) {
    popup.classList.remove("show");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  fetchUserHistory();
});
