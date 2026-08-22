# Frontend Integration Guide: Sprint 10 & UI Action Patterns

This guide outlines the recent backend architecture changes, new data contracts, and interaction patterns designed to synchronize the React/Next.js frontend with the LangGraph-based AI backend.

---

## 1. New Data Contract: `ProductDetailCard`

When the user asks for more details about a specific product, or clicks to view a product, the backend will now emit a new card type: `product_detail`. This card is richer than the standard `product` card emitted by search results and contains full details, including product variants.

### Schema

```typescript
type ProductVariant = {
  id: string; // The specific variant ID (e.g., "cake001-2KG")
  name: string; // Variant name (e.g., "2KG", "Chocolate")
  sku?: string;
  price?: number;
  currency: string; // Default: "LKR"
  in_stock: boolean;
  stock_level?: string;
  attributes: Record<string, any>;
};

type ProductDetailCard = {
  type: "product_detail"; // Used to route rendering on the frontend
  product_id: string; // Base product ID
  name: string; // Base product name
  image_url?: string; // Primary image
  price?: number; // Base price
  compare_at_price?: number;
  currency: string;
  in_stock: boolean;
  stock_level?: string;
  summary?: string;
  url?: string;
  
  // NEW FIELDS
  images: string[]; // Full array of image URLs for carousels
  variants: ProductVariant[]; // Available variants/options
  category?: string;
  attributes: Record<string, any>;
  shipping?: Record<string, any>;
};
```

### Frontend Implementation Notes:
- **Variant Selection UI:** If `variants` is not empty, you should render a selection UI (dropdown, pills, or radio buttons) inside the card.
- **Image Carousel:** Use the `images` array to render an image carousel rather than just a static `image_url`.

---

## 2. The "UI Action" Pattern: Bypassing the LLM

To ensure deterministic, immediate, and safe state mutations (like adding to cart), the frontend must **never** ask the LLM to update the cart via a typed chat message when a user clicks a UI button. Instead, use the direct UI Action endpoints.

### How it Works:
1. **Direct API Call:** The frontend calls a `POST` endpoint on `actions.py` (e.g., `/cart/add`).
2. **Deterministic Mutation:** The backend immediately runs pure Python code to update the database/state.
3. **Synthetic Event:** The backend injects a synthetic `[ui_action:add_to_cart]` message into the chat thread.
4. **Agent Wakeup:** The AI agent wakes up, sees the state has changed, and responds contextually (e.g., *"Added to cart! Would you like some flowers with that?"*).

### Cart Endpoints

**1. Add to Cart (`POST /cart/add`)**
Trigger this when the user clicks "Add to Cart" on a rendered card.
```json
{
  "user_id": "user_123",
  "thread_id": "thread_abc",
  "product_id": "cake001-2KG", // MUST be the exact variant ID if a variant is selected!
  "name": "Black Forest Cake", // Use the synthesized name (e.g., "Black Forest Cake (2KG)")
  "quantity": 1,
  "unit_price": 2500,
  "currency": "LKR",
  "image_url": "https://...",
  "in_stock": true
}
```
*Crucial:* Pass the selected **variant's** `id` as the `product_id`, and its specific price as `unit_price`.

**2. Remove from Cart (`POST /cart/remove`)**
```json
{
  "user_id": "user_123",
  "thread_id": "thread_abc",
  "product_id": "cake001-2KG"
}
```

**3. Update Quantity (`POST /cart/update_qty`)**
```json
{
  "user_id": "user_123",
  "thread_id": "thread_abc",
  "product_id": "cake001-2KG",
  "quantity": 3
}
```

**4. Clear Cart (`POST /cart/clear`)**
```json
{
  "user_id": "user_123",
  "thread_id": "thread_abc"
}
```

---

## 3. Real-Time Streaming UI Updates (SSE)

The backend's `/chat/stream` endpoint uses Server-Sent Events (SSE) to provide granular, real-time status updates while the AI processes a request. This prevents the user from staring at a blank loading spinner during complex operations.

### Stream Event Types
Every SSE frame is a self-describing JSON object with an `event` field.

**1. `status` Events**
These are lightweight progress indicators emitted the moment an agent enters a new phase or calls a specific tool.
```json
{
  "event": "status",
  "agent": "product_agent",
  "status": "Searching for 'cakes'..."
}
```
*Frontend Implementation:* You should render the `status` string in the UI (e.g., as a dynamic, italicized loading subtitle like "Kapruka is doing: *Searching for cakes...*") to show the user exactly what the backend is working on. Common statuses include:
- "thinking" / "writing_reply"
- "Searching for '{query}'..."
- "Loading product details..."
- "Updating your cart..."
- "Checking delivery availability for {city}..."
- "Placing your order..."

**2. `token` Events**
These contain the incremental text of the *final, user-facing reply*. The frontend should append the `text` string to the currently streaming chat bubble.
```json
{
  "event": "token",
  "text": "I have added "
}
```

**3. `final` Event**
This is the last event in the stream, containing the completed turn data.
```json
{
  "event": "final",
  "user_id": "...",
  "thread_id": "...",
  "cards": [...],
  "cart": [...],
  "suggested_next_step": "..."
}
```
*Frontend Implementation:* When `final` is received, stop the typing indicator, render any `cards`, sync the global `cart` state, and close the SSE connection.

---

## 4. The Top-Level `cart` State

To guarantee your frontend UI never falls out of sync (especially when the cart is emptied), the API response has been updated to explicitly include the deterministic `cart` array on **every single turn**.

### Updated Response Shape:
```typescript
type ChatResponse = {
  user_id: string;
  thread_id: string;
  text: string;
  cards: any[];
  cart: CartItem[]; // ALWAYS represents the exact, current state of the backend cart
  suggested_next_step?: string;
  selected_agent?: string;
  language?: string;
};
```
**Frontend Best Practice:** On every successful response from `/chat`, `/chat/stream`, or any `/cart/...` UI action, you should simply call `setCart(response.cart)`. This replaces the need to rely exclusively on the `cart_summary` card, ensuring your UI instantly clears when the cart array becomes empty.

---

## 4b. Cards Are a Replacement Set — Not Accumulated

**Every `cards` array in a response is complete and self-contained for that turn. Always replace, never append.**

```typescript
// CORRECT — replace on each response
setCards(response.cards);

// WRONG — this causes stale cards to linger
setCards(prev => [...prev, ...response.cards]);
```

The backend recomputes cards from scratch each turn by scanning only the tool results from the *current* turn. Cards from previous turns are not re-included unless their state condition still holds.

There are two categories of card:

| Category | Types | When included |
|---|---|---|
| **Persistent** | `cart_summary`, `checkout_form` | Every turn, as long as the state condition holds (cart non-empty / checkout in progress) |
| **Transient** | `product`, `product_detail`, `order_tracking`, `track_order_form` | Only on the turn they were generated |

**Practical consequence:** if the user tracks an order (`order_tracking` card appears), then asks "show me cakes", the next response's `cards` array will contain product cards and a `cart_summary` — but no `order_tracking`. Replacing `cards` with `setCards(response.cards)` makes it disappear automatically, with no special cleanup logic needed.

---

## 5. Conversational Logic & Edge Cases

1. **The "Hard Gate":** The LLM is no longer allowed to guess prices or add items straight from a search result. If the user types *"Add the first cake to my cart"*, the LLM will first silently fetch the full `ProductDetailCard` to load the exact price and variants, and only *then* add it.
2. **Conversational Variant Resolution:** If the user asks the agent to add a product via chat, and that product has variants (e.g., sizes), but the user did not specify which one they want, the LLM will pause and explicitly ask the user: *"Which size would you like? We have 1kg and 2kg."*
3. **Nudge Suppression:** When the frontend renders a `ProductDetailCard`, the backend explicitly suppresses the generic "Ready to checkout?" nudge. Instead, the AI will prompt the user to interact with the product (e.g., *"Pick a size, or let me know if you want to add this."*). 
4. **Redundant Fetching is OK:** If the agent occasionally re-fetches a product to ensure its memory cache is perfectly aligned with the latest pricing/stock, this is expected and safe. 

---

---

## 6. Order Tracking — Card Types, Field Reference & Rendering Guide (Sprint 13)

The order tracking flow produces two card types. They appear at different stages and must never be rendered alongside `checkout_form`.

---

### 6.1 `track_order_form` — Order Number Input

Emitted when the user says "track my order" but hasn't provided an order number yet.

```typescript
type TrackOrderFormCard = {
  type: "track_order_form";
  // No other fields — this card carries no data, just tells the UI to show the form.
};
```

**Render as:** A compact card — one text input labelled "Order Number", one primary CTA button "Track Order". Style it with the same padding/weight as the checkout form card.

**On submit**, POST to `/support/track`:
```json
{
  "user_id": "string",
  "thread_id": "string",
  "order_id": "VPAY827982BA"
}
```

- **Success** → response `cards` contains an `order_tracking` card (see 6.2).
- **Failure** (bad order number, API error) → `cards` contains a new `track_order_form` so the user can retry; `text` carries Kavi's friendly error message.
- **Valid order number format:** Kapruka order numbers look like `VPAY827982BA` or `VIMP34456CB2` — alphanumeric, uppercase, typically 10-12 characters. Do **not** strip or transform the value before sending.

---

### 6.2 `order_tracking` — Tracking Result

Emitted after `kapruka_track_order` returns a valid result.

#### TypeScript type

```typescript
type ProgressStep = {
  step: string;       // Human-readable step description (field name is literally "step")
  timestamp: string;  // Formatted string e.g. "JUN 23, 2026 4:40 PM" — all returned steps
                      // have a timestamp (they are completed past events). A step with no
                      // timestamp would be a future/pending milestone — handle gracefully.
};

type OrderTrackingCard = {
  type: "order_tracking";
  order_number: string;       // e.g. "VPAY827982BA"
  status: string;             // Machine-readable slug — see status table below
  status_display: string;     // Human-readable — ALWAYS use this for the badge label
  progress: ProgressStep[];   // Ordered oldest → newest; may be empty on some orders
  has_delivery_photo: boolean;
  has_delivery_video: boolean;

  // Date/amount metadata — always check for null before rendering
  order_date: string | null;    // When the order was placed. Raw Kapruka string, format varies:
                                //   e.g. "Tue Jun 23 07:10:46 EDT 2026"
  delivery_date: string | null; // Requested delivery date, e.g. "24 / JUNE / 2026"
  shipped_date: string | null;  // When the order was dispatched, e.g. "24 Jun 2026 05:11:27 GMT"
  order_total: number | null;   // e.g. 26060  (numeric, not a string)
  order_currency: string;       // Always "LKR"
  comments: string | null;      // Kapruka's final note, e.g. "Delivery successfully completed."
                                // null when empty — safe to render directly if non-null
  live_tracking_available: boolean; // if true, real-time GPS tracking is available on Kapruka.com

  // What was ordered
  items: OrderTrackingItem[];   // May be empty if the API didn't return item detail
};

type OrderTrackingItem = {
  product_id: string;           // Kapruka product ID
  name: string;                 // Product name as it appeared on the order
  quantity: int;
  selling_price: number | null; // Price per unit at time of order, in order_currency
};
```

> **Date format note:** Kapruka returns date strings in inconsistent formats across fields. Do not attempt to parse them with `new Date()` — render them as-is. If you want formatted display, use a simple cleanup like `.replace(/ EDT | GMT/, "").trim()` to strip timezone labels before showing to the user.

#### Status slug → badge colour mapping

| `status` value | `status_display` | Suggested badge colour |
|---|---|---|
| `processing` | Processing | Blue (`#3B82F6`) |
| `confirmed` | Confirmed | Teal (`#14B8A6`) |
| `preparing` | Preparing | Amber (`#F59E0B`) |
| `shipped` | Shipped | Purple (`#8B5CF6`) |
| `out_for_delivery` | Out for Delivery | Orange (`#F97316`) |
| `delivered` | Delivered | Green (`#22C55E`) |
| `cancelled` | Cancelled | Red (`#EF4444`) |

> Always show `status_display` in the UI. Use `status` only for colour/icon logic. The slug values above are the ones Kapruka currently returns; treat unknown slugs as a neutral grey badge.

#### Real payload (from live API, order VPAY827982BA)

```json
{
  "type": "order_tracking",
  "order_number": "VPAY827982BA",
  "status": "delivered",
  "status_display": "Delivered",
  "order_date": "Tue Jun 23 07:10:46 EDT 2026",
  "delivery_date": "24 / JUNE / 2026",
  "shipped_date": "24 Jun 2026 05:11:27 GMT",
  "order_total": 26060.0,
  "order_currency": "LKR",
  "comments": "Delivery successfully completed.",
  "has_delivery_photo": false,
  "has_delivery_video": false,
  "live_tracking_available": false,
  "items": [
    { "product_id": "flowers00ka123", "name": "Pink Rose Bouquet (12 Stems)", "quantity": 1, "selling_price": 3500.0 },
    { "product_id": "chocolates00767_default", "name": "All Nuts Mix-12 Piece (Java)", "quantity": 2, "selling_price": 3600.0 }
  ],
  "progress": [
    { "step": "Order Confirmed and Awaiting preparation",             "timestamp": "JUN 23, 2026 4:40 PM" },
    { "step": "Kapruka Flower Shop, Flower Arrangement is preparing", "timestamp": "JUN 23, 2026 5:15 PM" },
    { "step": "Kapruka Warehouse, Order is preparing",               "timestamp": "JUN 23, 2026 5:23 PM" },
    { "step": "Kapruka Warehouse, Order Prepared",                   "timestamp": "JUN 23, 2026 5:23 PM" },
    { "step": "Delivery Assigned to Rider",                          "timestamp": "JUN 23, 2026 7:37 PM" },
    { "step": "Order Dispatched",                                    "timestamp": "JUN 24, 2026 8:11 AM" },
    { "step": "Order Out for Delivery",                              "timestamp": "JUN 24, 2026 8:23 AM" },
    { "step": "Order Delivered",                                     "timestamp": "JUN 24, 2026 10:41 AM" }
  ]
}
```

#### Timeline rendering rules

```javascript
function renderProgressStep(step, index, allSteps) {
  // IMPORTANT: field name is "step", not "label" / "name" / "status"
  const label = step.step;
  const time  = step.timestamp;

  // Completion: inferred from timestamp presence (all returned steps are past events)
  const isCompleted = !!time;
  // "Current": visually highlight the last step in the array
  const isCurrent   = isCompleted && index === allSteps.length - 1;

  const icon = isCurrent  ? "●"    // active/current indicator
             : isCompleted ? "✓"   // green check
             : "○";                // future/pending (uncommon)

  const cls  = isCurrent  ? "step-current"
             : isCompleted ? "step-complete"
             : "step-pending";

  return `
    <div class="timeline-step ${cls}">
      <div class="timeline-icon">${icon}</div>
      <div class="timeline-body">
        <span class="step-label">${escapeHtml(label)}</span>
        ${time ? `<span class="step-time">${escapeHtml(time)}</span>` : ""}
      </div>
    </div>
  `;
}
```

---

#### Beautiful Timeline — Enhanced Rendering

Kapruka's step description strings are human-readable and keyword-rich, making it possible to infer an emoji icon per step without any backend changes.

**Step icon inference** (match keywords in `step.step`, case-insensitive, first match wins):

```javascript
function inferStepIcon(stepText) {
  const t = stepText.toLowerCase();
  if (t.includes("delivered") && !t.includes("out for"))  return "🎉";
  if (t.includes("out for delivery"))                      return "🚚";
  if (t.includes("dispatch"))                              return "🚀";
  if (t.includes("rider") || t.includes("assigned"))      return "🛵";
  if (t.includes("picked up") || t.includes("collect"))   return "📦";
  if (t.includes("flower") || t.includes("arrangement"))  return "💐";
  if (t.includes("cake") || t.includes("bakery"))         return "🎂";
  if (t.includes("preparing") || t.includes("warehouse")) return "🏭";
  if (t.includes("prepared"))                              return "✅";
  if (t.includes("confirmed") || t.includes("awaiting"))  return "📋";
  if (t.includes("paid") || t.includes("payment"))        return "💳";
  if (t.includes("cancel"))                               return "❌";
  return "📍";  // default pin
}
```

**Progress percentage** from `status` slug — use this to drive a progress bar at the top of the card:

```javascript
const STATUS_PROGRESS = {
  processing:       10,
  confirmed:        25,
  preparing:        45,
  shipped:          60,
  out_for_delivery: 80,
  delivered:        100,
  cancelled:        0,
};

const pct = STATUS_PROGRESS[card.status] ?? 50; // fallback to 50% for unknown slugs
```

**Date display helper** — Kapruka date strings have inconsistent formats; clean them before showing:

```javascript
function cleanDate(raw) {
  if (!raw) return null;
  return raw
    .replace(/\b(EDT|EST|GMT|UTC|IST)\b/g, "")  // strip timezone labels
    .replace(/\s*\/\s*/g, " ")                   // "24 / JUNE / 2026" → "24 JUNE 2026"
    .replace(/\s{2,}/g, " ")
    .trim();
}
```

**Full enhanced render function:**

```javascript
function renderTrackingCard(card) {
  const pct        = STATUS_PROGRESS[card.status] ?? 50;
  const badgeColor = STATUS_BADGE_COLOR[card.status] ?? "#6B7280";

  // ── Header + progress bar ─────────────────────────────────────────
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

  // ── Date / amount metadata row ────────────────────────────────────
  const metaItems = [
    card.order_date    ? { label: "Ordered",  value: cleanDate(card.order_date) }    : null,
    card.delivery_date ? { label: "Delivery", value: cleanDate(card.delivery_date) } : null,
    card.shipped_date  ? { label: "Shipped",  value: cleanDate(card.shipped_date) }  : null,
    card.order_total   ? { label: "Total",
                           value: `${card.order_currency} ${card.order_total.toLocaleString()}` } : null,
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

  // ── Items ordered ─────────────────────────────────────────────────
  const itemsHtml = card.items && card.items.length > 0
    ? `<div class="tracking-items">
        <div class="tracking-items-heading">🛍️ Items Ordered</div>
        ${card.items.map(item => `
          <div class="tracking-item-row">
            <div class="tracking-item-name">${escapeHtml(item.name)}</div>
            <div class="tracking-item-meta">
              <span class="tracking-item-qty">×${item.quantity}</span>
              ${item.selling_price != null
                ? `<span class="tracking-item-price">${card.order_currency} ${(item.selling_price * item.quantity).toLocaleString()}</span>`
                : ""}
            </div>
          </div>`).join("")}
       </div>`
    : "";

  // ── Completion comment ────────────────────────────────────────────
  const commentHtml = card.comments
    ? `<div class="tracking-comment">💬 ${escapeHtml(card.comments)}</div>`
    : "";

  // ── Timeline steps ────────────────────────────────────────────────
  const stepsHtml = card.progress.length > 0
    ? `<div class="tracking-timeline">
        ${card.progress.map((step, i, all) => {
          const isCompleted = !!step.timestamp;
          const isCurrent   = isCompleted && i === all.length - 1;
          const cls  = isCurrent ? "step-current" : isCompleted ? "step-complete" : "step-pending";
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

  // ── Delivery media banner ─────────────────────────────────────────
  const mediaBanner = (card.has_delivery_photo || card.has_delivery_video)
    ? `<div class="tracking-media-banner">
        ${card.has_delivery_photo ? "📸 Delivery photo" : ""}
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
```

**Suggested CSS structure:**

```css
/* Card shell */
.tracking-card {
  border-radius: 12px;
  padding: 20px;
  background: #fff;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08);
}

/* Header row */
.tracking-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.tracking-order-number { font-weight: 600; font-size: 0.95rem; color: #374151; }
.tracking-badge {
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  color: #fff;
  letter-spacing: 0.03em;
}

/* Progress bar */
.tracking-progress-bar {
  height: 6px;
  border-radius: 3px;
  background: #E5E7EB;
  margin-bottom: 4px;
  overflow: hidden;
}
.tracking-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #6366F1, #22C55E);
  transition: width 0.6s ease;
}
.tracking-progress-label { font-size: 0.72rem; color: #9CA3AF; margin-bottom: 16px; }

/* Metadata row (ordered / delivery / shipped / total) */
.tracking-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
  background: #F9FAFB;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.tracking-meta-item { display: flex; flex-direction: column; gap: 2px; }
.meta-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; color: #9CA3AF; font-weight: 600; }
.meta-value { font-size: 0.82rem; color: #1F2937; font-weight: 500; }

/* Items ordered */
.tracking-items {
  border: 1px solid #E5E7EB;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.tracking-items-heading {
  font-size: 0.78rem;
  font-weight: 600;
  color: #6B7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}
.tracking-item-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px solid #F3F4F6;
}
.tracking-item-row:last-child { border-bottom: none; }
.tracking-item-name { font-size: 0.85rem; color: #111827; flex: 1; }
.tracking-item-meta { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
.tracking-item-qty  { font-size: 0.78rem; color: #6B7280; }
.tracking-item-price { font-size: 0.82rem; font-weight: 600; color: #111827; }

/* Completion comment */
.tracking-comment {
  font-size: 0.82rem;
  color: #374151;
  background: #F0FDF4;
  border-left: 3px solid #22C55E;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 16px;
}

/* Timeline */
.tracking-timeline { display: flex; flex-direction: column; gap: 0; }
.timeline-item { display: flex; gap: 14px; }

.timeline-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 36px;
  flex-shrink: 0;
}
.timeline-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #F3F4F6;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  flex-shrink: 0;
}
.step-current .timeline-icon-wrap {
  background: #EEF2FF;
  box-shadow: 0 0 0 3px #C7D2FE;
}
.timeline-connector {
  width: 2px;
  flex: 1;
  min-height: 16px;
  background: #E5E7EB;
  margin: 4px 0;
}
.step-complete .timeline-connector { background: #BBF7D0; }

.timeline-right { padding: 6px 0 16px; }
.timeline-step-label { font-size: 0.85rem; font-weight: 500; color: #111827; line-height: 1.4; }
.step-current .timeline-step-label { color: #4F46E5; font-weight: 600; }
.step-pending .timeline-step-label { color: #9CA3AF; }
.timeline-step-time { font-size: 0.75rem; color: #6B7280; margin-top: 2px; }

/* Media banner */
.tracking-media-banner {
  margin-top: 16px;
  padding: 10px 14px;
  background: #F0FDF4;
  border: 1px solid #BBF7D0;
  border-radius: 8px;
  font-size: 0.82rem;
  color: #166534;
}
```

#### Delivery media indicators

```javascript
if (card.has_delivery_photo || card.has_delivery_video) {
  // Show a small info banner — the actual media is not available via the tracking card.
  // Kapruka does not expose the media URL in the tracking API response.
  const types = [
    card.has_delivery_photo ? "📸 Delivery photo" : null,
    card.has_delivery_video ? "🎥 Delivery video" : null,
  ].filter(Boolean).join("  ·  ");

  return `<div class="delivery-media-banner">${types} available on Kapruka.com</div>`;
}
```

#### Fields the backend intentionally excludes from the card

The raw Kapruka tracking API returns these additional fields, but the backend strips them before sending the card (they're verbose or PII):

| Raw API field | Contains |
|---|---|
| `order_date` | Order placement date string |
| `delivery_date` | Requested delivery date |
| `shipped_date` | Dispatch date/time |
| `amount.value` / `amount.currency` | Order total |
| `payment_method` | Payment gateway code |
| `comments` | Delivery completion note |
| `recipient.name/phone/address/city` | Delivery recipient details |
| `greeting_message` | Gift card message |
| `special_instructions` | Delivery notes |
| `pnref` | Internal Kapruka reference |

If you want to display `order_date`, `delivery_date` or `amount` on the tracking card, ask the backend to add them to `OrderTrackingCard` in `schemas.py` and `_order_tracking_card` in `cards.py` — it is a 5-minute change.

---

## 7. Critical Rule: Suppress `checkout_form` During Any Tracking Context

**The problem:** If the user has items in their cart and checkout has started, the backend sends a `checkout_form` card on *every* turn. When they also trigger order tracking, both `checkout_form` and the tracking card land in the same `cards` array, creating a confusing mixed UI.

**The rule:** Suppress `checkout_form` whenever any tracking card is present — both `track_order_form` (entering the order number) and `order_tracking` (viewing the result).

```typescript
function filterCards(cards: Card[]): Card[] {
  const inTrackingContext = cards.some(
    c => c.type === "track_order_form" || c.type === "order_tracking"
  );
  if (inTrackingContext) {
    return cards.filter(c => c.type !== "checkout_form");
  }
  return cards;
}
```

Apply this once, immediately before the `cards.map(...)` render call. The checkout form automatically reappears the next turn the user returns to shopping.

> **Note:** The backend also resets the `show_tracking_form` flag every turn so the tracking form card does not persist. The frontend filter is a second layer of defence.

---

## Summary Checklist for Frontend integration:
- [ ] Handle `type === "product_detail"` in the message feed.
- [ ] Render a variant picker if `variants.length > 0`.
- [ ] Render an image carousel using `images[]` if available.
- [ ] When the user clicks "Add to Cart", submit the **Variant ID** (not the base product ID) and the variant's specific price to `POST /cart/add`.
- [ ] Ensure all UI cart buttons (add, remove, qty+, qty-) call the `/cart/...` REST endpoints rather than sending chat messages.
- [ ] Handle `type === "track_order_form"`: render a single order-number input + "Track Order" button; on submit call `POST /support/track` with `{ user_id, thread_id, order_id }`.
- [ ] Handle `type === "order_tracking"`:
  - [ ] Show `status_display` in a coloured badge (use `status` slug for colour lookup).
  - [ ] Render `progress` as a vertical timeline — use `step.step` for the label, `step.timestamp` for the time, infer completion from `!!step.timestamp`.
  - [ ] Highlight the last step as the "current" milestone.
  - [ ] Show a media banner if `has_delivery_photo` or `has_delivery_video` is `true`.
- [ ] **Apply `filterCards` before rendering**: suppress `checkout_form` whenever `track_order_form` OR `order_tracking` is present.

---

## 8. Sprint 14 Integration: Zero-Latency Checkout Actions

In Sprint 14, the backend order flow was refactored into a "Smart Interceptor", bypassing the LLM completely for deterministic UI button clicks. This ensures immediate feedback and no token costs for checkout actions.

### 8.1 "Place Order" Button
When the user is in the checkout flow and clicks the final **"Place Order"** or **"Confirm"** button, the frontend must make a direct API call rather than sending a chat message.

**Endpoint:** `POST /checkout/place_order`
**Payload:**
```json
{
  "user_id": "user_123",
  "thread_id": "thread_abc"
}
```

*What happens on the backend:*
1. The backend immediately processes the order using the stored cart and checkout state.
2. A `checkout_confirmation` card is generated upon success.
3. The cart is cleared deterministically.

### 8.2 UI Action Update for Forms
If your frontend submits checkout form updates (e.g., entering an address or changing delivery dates), ensure these are sent as UI actions. Like the cart actions, this triggers an immediate, zero-latency state update.

*Note: This is formatted as an event message (e.g., `[ui_action:checkout_form_submit] {...}`) when sent through the chat socket.*

### Updated Checklist for Sprint 14:
- [ ] Wire the final "Place Order" button to call `POST /checkout/place_order` directly.
- [ ] Ensure checkout form updates are sent as UI actions (`checkout_form_submit`) rather than conversational text to benefit from zero LLM latency.
- [ ] Handle `type === "checkout_confirmation"` in the cards array to render the success state (using `checkout_url`, `order_ref`, etc.).

---

## 9. Kavi's Picks — Always-Visible Sidebar Carousel (Sprint 15)

A sidebar section showing ~10 bestseller product cards at all times, independent of the
chat conversation. Cards look identical to search result cards. Clicking one opens a full
product detail view in the chat.

---

### 9.1 Fetching the Picks

**Endpoint:** `GET /products/picks`
**Auth:** none required (same as all other endpoints)
**When to call:** once on page load; no polling needed (data is cached server-side for 4 hours)

**Response:**
```typescript
type PicksResponse = {
  picks: ProductCard[]; // same ProductCard schema as search results (type: "product")
};
```

The `ProductCard` schema is defined in section 1 of this guide (same `type: "product"` shape). Each card has `product_id`, `name`, `image_url`, `price`, `currency`, `in_stock`, `url`, etc.

**Example fetch:**
```typescript
async function loadKaviPicks(): Promise<ProductCard[]> {
  const res = await fetch(`${API_BASE}/products/picks`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.picks ?? [];
}
```

Call this on mount and store the result in component state. No need to re-fetch on every
navigation — the backend cache means results are stable for hours.

---

### 9.2 Rendering the Carousel

Render picks as a horizontal or vertical scrollable list in the sidebar using the same
product card component you use for chat search results (`type === "product"`). Suggested
visual treatment:

- **Header:** "✨ Kavi's Picks" with a subtle "Bestsellers" label or badge
- **Cards:** same image / name / price layout as chat product cards — reuse the component
- **Scroll:** horizontal scroll on mobile, vertical list on desktop sidebar

```typescript
function KaviPicksSidebar({ picks }: { picks: ProductCard[] }) {
  if (picks.length === 0) return null;

  return (
    <aside className="kavi-picks-sidebar">
      <h3 className="picks-heading">✨ Kavi's Picks</h3>
      <p className="picks-subheading">Bestsellers</p>
      <div className="picks-list">
        {picks.map(card => (
          <ProductCard
            key={card.product_id}
            card={card}
            onViewDetails={() => handlePickClick(card)}
          />
        ))}
      </div>
    </aside>
  );
}
```

---

### 9.3 Click Interaction — `POST /products/select`

Clicking a Kavi's Pick fires a dedicated endpoint. Unlike the silent `view_details` UI
action, this injects a **natural human message** ("Tell me more about {name}") into the
chat thread, so it appears in the conversation exactly as if the customer typed it —
followed by Kavi's reply and the product detail card.

**Endpoint:** `POST /products/select`
**Payload:**
```json
{
  "user_id": "user_abc",
  "thread_id": "thread_xyz",
  "product_id": "flowers00ka123",
  "name": "Pink Rose Bouquet"
}
```

> Send both `product_id` (drives the exact product lookup) and `name` (used to build the
> visible "Tell me more about {name}." message). Use the card's own `product_id` and `name`.

**`thread_id` rules:**
- If the user already has an active chat thread → use that `thread_id`.
- If no chat thread exists yet → generate a fresh UUID (`crypto.randomUUID()` — the
  browser's built-in unique-ID generator) and use it as `thread_id`. The backend creates
  the LangGraph thread implicitly on this first call — **no pre-creation step needed**.

**What happens on the backend:**
1. A real human message `"Tell me more about {name}."` is added to the thread's history.
2. The router skips its LLM call (a verified `product_id` is already in state) and goes
   straight to `product_agent`.
3. `product_agent` calls `kapruka_get_product` with that exact verified `product_id` — no
   search, no guessing.
4. Response is the standard chat shape: Kavi's reply + a `product_detail` card.

```typescript
async function handlePickClick(card: ProductCard) {
  const threadId = getActiveThreadId() ?? crypto.randomUUID();

  // Open / focus the chat panel; optionally show the user's message bubble optimistically
  openChatPanel(threadId);

  const res = await fetch(`${API_BASE}/products/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: getUserId(),       // from cookie / localStorage
      thread_id: threadId,
      product_id: card.product_id,
      name: card.name,
    }),
  });

  const data = await res.json();
  // Append text + cards to the chat thread as a normal Kavi response
  appendChatResponse(threadId, data);
}
```

The response shape is the standard `ChatResponse`:
```typescript
{
  user_id: string;
  thread_id: string;
  text: string;           // Kavi's reply about the product
  cards: Card[];          // includes ProductDetailCard + optional cart_summary
  cart: CartItem[];
  suggested_next_step?: string;
  selected_agent: "product_agent";
  language: string;
}
```

> **Buffered, not streamed.** `POST /products/select` returns the complete response in one
> shot (like the cart/checkout action endpoints), not as SSE. The product fetch is a single
> quick turn, so there's no streaming to wire up here.

---

### 9.4 Checklist

- [ ] Call `GET /products/picks` on page load; store in sidebar state.
- [ ] Render picks using the existing `ProductCard` component (reuse, don't duplicate).
- [ ] On pick click: resolve `thread_id` (active or fresh `crypto.randomUUID()`), fire
  `POST /products/select` with `{user_id, thread_id, product_id, name}`.
- [ ] Open/focus the chat panel; the user's "Tell me more about {name}" message and Kavi's
  reply both belong in the conversation thread.
- [ ] Handle empty `picks` array gracefully (hide the sidebar section, don't show an empty list).

---

## 10. Customer Purchase History (Reorder Suggestions)

You can now fetch a customer's past orders to display in a "Reorder" or "Purchase History" suggestion card on the frontend.

**Endpoint:** `GET /user/{user_id}/history?limit=5`
**Auth:** none required (same as all other endpoints)
**When to call:** When rendering a user profile page or a "Buy it again" carousel.

**Response:**
```typescript
type HistoryResponse = {
  orders: PastOrder[];
};

type PastOrder = {
  order_ref: string;
  checkout_url?: string;
  summary?: string;
  expires_at?: string;
  created_at: string;
  cart: CartItem[]; // The items purchased in this order
};
```

**Implementation Guide:**
- This endpoint queries the database directly and returns orders sorted by `created_at` (newest first).
- You can iterate through `orders` and then through the `cart` arrays within them to display the products the user previously bought.
- The `cart` items match the standard `CartItem` schema, meaning you can easily re-use your product cards and the "Add to Cart" API (`POST /cart/add`) to allow one-click reordering.
