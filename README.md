# Kaví - Kapruka-Shopping-Agent 🛍️

Meet Kaví- Your AI Assistant to the largest shopping marketplace in Sri Lanka. Powered by Kapruka MCP

Live at: https://kapruka.axisdatatech.com/

Kaví is an intelligent shopping companion that can help you find anything you like from thousands of live products available at Kapruka.com 

Kaví can search Kapruka's live catalog 🔍, understand English, Sinhala, Tamil, Singlish and Tanglish (Truly multilingual) 🗣️, remember user histories 📝, manage shopping carts 🛍️, guide customers all the way to checkout 💳, and even track existing orders 📦 ; all through natural conversation

### System Architecture

Technologies Used

Backend <br>
Python , FastAPI , LangGraph , LangChain, Postgress, Iniitally Hosted on Railway - Currently self-hosted on a VPS, Kapruka MCP Server

Frontend <br>
HTML, CSS, JS (Free from Frameworks), Hosted on Vercel


### AI architecture

Though end users interact only one one chat interface, Kaví is build on a tiered multi-agent architecture. 

![agent_architecture.jpg](Agent_architecture.jpg)

### Models used

- Router Agent Node : GPT OSS 20B using Groq, Fallback : Gemini 2.55-flash-lite
- Subagents
  Product agent - GPT-5.4-mini
  Order agent - Gemini-2.5 flash-lite

- Concierge Agent (Kavi Agent) - Gemini-3.5-flash


Every conversational path funnels through **kavi_agent**, the single voice the customer ever hears. Specialist agents write terse internal "status notes" that Kavi rewrites from scratch.

Tools available in Kapruka MCP,


| Tool                           | Purpose                                                 | Key Inputs                                                                                        | Output / Use                                                                              |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kapruka_list_categories`      | Browse Kapruka's product category hierarchy             | `depth`, `response_format`                                                                        | Category names, sub-categories, and public category URLs                                  |
| `kapruka_search_products`      | Search Kapruka products with filtering and pagination   | `q`, `category`, `limit`, `cursor`, `currency`, `min_price`, `max_price`, `in_stock_only`, `sort` | Matching products with IDs, prices, stock status, images, categories, and URLs            |
| `kapruka_get_product`          | Retrieve complete details for a specific product        | `product_id`, `currency`, `type`, `response_format`                                               | Product details, variants, images, pricing, stock, shipping, attributes, and URL          |
| `kapruka_list_delivery_cities` | Find Kapruka-supported delivery cities                  | `query`, `limit`, `response_format`                                                               | Canonical city names and aliases                                                          |
| `kapruka_check_delivery`       | Check delivery availability and pricing for a city/date | `city`, `delivery_date`, `product_id`, `response_format`                                          | Availability, delivery fee, next available date, and perishable-item warnings             |
| `kapruka_create_order`         | Create a guest checkout and generate a payment link     | `cart`, `recipient`, `delivery`, `sender`, `gift_message`, `currency`                             | Checkout URL, pre-payment order reference, totals, and expiry time                        |
| `kapruka_track_order`          | Track a completed Kapruka order                         | `order_number`, `response_format`                                                                 | Order status, delivery details, progress timeline, items, and delivery media availability |


Component configs

| Node | LLM? | Model | Role |
|---|---|---|---|
| `master_router` | Yes (skipped for UI events) | Groq `openai/gpt-oss-20b` → fallback Gemini 2.5 Flash Lite, temp 0, structured output | Language detection, agent routing, order-id extraction |
| `product_agent` | Yes | OpenAI `gpt-5.4-mini`, temp 0.3 | Search, product details, gift ideas, all cart changes |
| `product_tools` | — | (ToolNode) | Executes product_agent's tool calls |
| `order_agent` | Mini tagger only | Gemini 2.5 Flash Lite, temp 0, 30s timeout | Checkout field collection, delivery checks, order placement |
| `fast_support_agent` | **No** | — | Deterministic order tracking |
| `kavi_agent` | Yes | Gemini 3.5 Flash, temp 0.7, `thinking_budget=0`, max 1024 tokens | The only customer-facing voice; card assembly happens here too |
| `fast_ui_agent` | **No** | — | Instant canned replies for cart-button clicks |




### Router Agent Node - master_router

What the router is allowed to see is deliberately narrow (`_router_visible_messages`): the last **8** messages, with every tool-call AIMessage, every ToolMessage, and every hidden specialist draft stripped out. Raw tool traffic is both noise and a misrouting risk — and removing both halves of each tool round-trip together means Gemini never sees an orphaned ToolMessage.

Routing rules baked into the prompt (the ones that matter):

- **All cart changes go to `product_agent`** — even mid-checkout, even phrased as "buy"/"order this". `order_agent` is only for delivery checks, checkout details, and placing the order.
- "proceed to checkout" / "let's checkout" → `order_agent`, always.
- Greetings/small talk → `kavi_agent` directly. Any availability/price question → `product_agent`.
- Romanized Sinhala/Tamil ("mata cake ekak ganna ona") counts as Sinhala/Tamil — detect the *language*, not the script. Short ambiguous messages bias toward English/Sinhala; Tamil only when confident.

**Disambiguation hint:** the previous turn's `suggested_next_step` is injected into the router prompt, so a bare "yes" / "ok" resolves to the agent implied by what Kavi just offered (`continue_checkout` → order_agent, `add_more` → product_agent, `track_order` → fast_support_agent) instead of being re-guessed from scratch.

**Mid-checkout stickiness (deterministic override):** while a checkout is in progress, a prompt hint keeps ambiguous messages ("wait", "huh?", "hello?") in the checkout lane — and if the LLM *still* answers `fast_support_agent` for a message that carries **no order id and no tracking keyword** (`track`, `where is`, `order status`, `order eka`, …), Python overrides it back to `order_agent`. This exists because the router occasionally misread confused messages as tracking requests and popped a tracking form mid-checkout. The override never hijacks a genuine tracking request.

"Checkout in progress" itself is tested as `checkout is not None` (not truthiness) — `{}` is a valid in-progress checkout — which is also what keeps the post-order *"track it?" → "yes"* flow from being dragged back into an empty-cart checkout.

**The router LLM call** returns a Pydantic `RouterDecision` in a single structured-output call:
```
class RouterDecision(BaseModel):
    detected_language: Literal["English", "Sinhala", "Tamil"]
    next_agent: Literal["product_agent", "order_agent", "fast_support_agent",
                        "kavi_agent", "fast_ui_agent"]
    extracted_order_id: str | None   # tracking number found in the message, if any
```

**Three short-circuits run before any LLM call:**

1. **UI action events.** Button/form clicks arrive as synthetic human messages like `[ui_action:add_to_cart] {"product_id": "...", ...}`. The action type maps directly to an agent via `_UI_ACTION_AGENT`:

   | Action | Destination | Why |
   |---|---|---|
   | `checkout_form_submit`, `place_order` | `order_agent` | Checkout logic lives there |
   | `remove_from_cart`, `update_qty`, `clear_cart` | `fast_ui_agent` | Endpoint already mutated the cart; a specialist would only produce a discarded draft |
   | `track_order_submit` | `fast_support_agent` | Tracking |
   | `add_to_cart` (and anything unmapped) | `product_agent` | An add can still trigger a real cross-sell search |

2. **Kavi's Picks click.** `pending_product_view` in state → straight to `product_agent` (the clicked id came from our own listing; nothing to classify).
3. Otherwise → the **router LLM**.

Every interaction does through an llm inference in the router node unless it is a UI interaction(Cart interactions) that sets the next agent to fast_ui_agent without spending time for an LLM call.



###  `product_agent` — search, details, cart (LLM + tool loop)

The only agent still using the classic LangGraph pattern: LLM decides → `ToolNode` executes → results loop back → LLM continues or hands off (`product_should_continue`: tool calls pending → `product_tools`, else → `kavi_agent`).

**Its tools** (all built in `tools.py`):

| Tool | Kind | What the deterministic wrapper enforces |
|---|---|---|
| `kapruka_search_products` | MCP wrapper | Forces `response_format="json"` and `in_stock_only=true`; **hard-disables the `category` param** (upstream tags almost everything `cat_general`, so real taxonomy labels return zero results — a prompt rule alone was occasionally ignored, so the argument simply doesn't exist); records the query to the cross-thread Store for personalization on *every* call |
| `kapruka_get_product` | MCP wrapper | Forces JSON; caches the full product payload into `state.viewed_products[product_id]` — this cache is what later validates `add_to_cart` |
| `add_to_cart` | Local | Refuses ids that were never seen in a tool result ("details aren't loaded yet — call get_product first"); multi-variant products force a which-variant question; a single "default" variant resolves silently to the variant's own id; price/image/stock are taken from the cached detail, never from the LLM |
| `remove_from_cart`, `update_cart_quantity`, `clear_cart` | Local | Same `cart.py` functions the REST endpoints use; `clear_cart` also resets `checkout`, `delivery_confirmed`, `cross_sold_categories` |


User Persistence

- Session ID - one conversation thread (persists until abandoned) 
- User ID - This user ID persists in customers browser localstorage. Since no login functionality was implemented to avoid adding signup friction - we are able to identify a user uniquely using this id persisted in browser storage that let's the users to continue 


