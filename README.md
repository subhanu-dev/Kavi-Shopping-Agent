# Kaví - Kapruka-Shopping-Agent 🛍️

Meet Kaví- Your AI Assistant to the largest shopping marketplace in Sri Lanka. Powered by Kapruka MCP

Live at: https://kapruka.axisdatatech.com/

Kaví is an intelligent shopping companion that can help you find anything you like from thousands of live products available at Kapruka.com 

Kaví can search Kapruka's live catalog 🔍, understand English, Sinhala, Tamil, Singlish and Tanglish (Truly multilingual) 🗣️, remember user histories 📝, manage shopping carts 🛍️, guide customers all the way to checkout 💳, and even track existing orders 📦 ; all through natural conversation

## System Architecture

Technologies Used

Backend <br>

Core stack; Python , FastAPI , LangGraph , LangChain, Kapruka MCP Server
Database: Postgress
LLM Observability: Langfuse
Deployment: Iniitally Hosted on Railway - Currently self-hosted on a VPS

Frontend <br>
Core stack: HTML, CSS, JS (Free from Frameworks)
Deployment: Hosted on Vercel


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


All these tools are actively being used during agent's execution. Kapruka_list_categories is being called at the initialization of the application and persisted as categories rarely change. this categories list output is then passed to the product agent 

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


Product agent is the agent node with the most number of tools available to it. This allows product agents to perform more than one task in it's run. it can search for a certain product and add it in the same run. Cart operations are available to both agent and UI interactions. both of the methods utilize the same tools and change the same shared state that keeps the data consistent. 

**Deterministic cross-sell.** When an item was *just added* (either the `[ui_action:add_to_cart]` event or an `add_to_cart` ToolMessage found this turn) **and** checkout hasn't started (`checkout is None`), `cart.find_complementary_suggestion` consults a fixed affinity table
This is from a deterministic dictionary of products associated to be closely together so the final concierge agent can use this to cross sell more products. A complementary affinity table instead of a tool call was used to cut down latency of another tool call.

The output of the product agent is designed to be as short as possible

Its final text is **internal only**. the shortest possible factual status note (what was searched, found, changed, out of stock). Kavi owns every greeting, emoji, and upsell; duplicating them here is wasted tokens. 

User Persistence

- Session ID - one conversation thread (persists until abandoned) 
- User ID - This user ID persists in customers browser localstorage. Since no login functionality was implemented to avoid adding signup friction - we are able to identify a user uniquely using this id persisted in browser storage that let's the users to continue

### Order agent

No `bind_tools`. No ToolNode. The node closure holds the raw MCP tools (`list_delivery_cities`, `check_delivery`, `create_order`) and calls two async core functions from Python: `check_delivery_core` and `place_order_core` (`tools.py`). These core functions wrap around the MCP tools - list_delivery_cities, check_deivery, create_order that are called in order.

 The order_agent manages the checkout flow deterministically by converging two different types of input—UI button clicks and typed chat messages—into a single set of Python-driven execution paths. As an architectural safeguard, if the cart is empty, the agent immediately bails out at the very top of the node before any processing occurs.                                                           
                                                                                                      
#### Path A: UI Actions (Zero-Latency)                                                              
                                                                                                      
When a user submits a form or clicks a button, the frontend injects a deterministic [ui_action:...] event. This completely bypasses the LLM and routes directly to the Python core functions:           
                                                                                                      
  • [ui_action:checkout_form_submit]: Merges standard fields (name, phone, address, date) into the    
  checkout state. Crucially, the city is deliberately excluded from the standard merge and is instead 
  flagged as city_to_resolve. This routes the city to the strict check_delivery_core validator to     
  prevent users from bypassing delivery rules. Returns a system note detailing any remaining missing  
  fields.                                                                                             
  • [ui_action:place_order]: Routes directly to place_order_core to validate the final state and      
  generate the payment link.                                                                          
                                                                                                      
  #### Path B: Conversational Text (The Mini Tagger)                                                  
                                                                                                      
  When a user types their checkout details in natural language (e.g., "Deliver to Colombo tomorrow for
  Alice"), the agent relies on a Mini Tagger.                                                         
                                                                                                      
  Instead of an open-ended conversational LLM, this is a strict, 30-second timeboxed call to a fast   
  model (like Gemini Flash Lite) designed solely for Named Entity Recognition (NER). Its entire job is
  to evaluate the chat and emit exactly one plain-text action tag:                                    
                                                                                                      
    [action:update_checkout name="Alice" phone="0712345678" address="42 Galle Rd"]                    
    [action:check_delivery city="Colombo"]                                                            
    [action:place_order]                                                                              
    [action:none]                                                                                     
                                                                                                      
  Tagger Logic & Dispatch Priorities:                                                                 
  Once the tag is emitted, pure Python takes over to execute the logic safely:    

   • update_checkout: Python uses Regex to extract the key-value pairs and map them to the nested      
  checkout state.                                                                                     
      • Sanitization: Dates are automatically ISO-normalized at write time. If the LLM extracts an    
      unparseable date, Python strips it and flags it so the synthesizer asks for a real date         
      (preventing junk data from breaking downstream MCP validation).                                 
      • Auto-Revalidation: If a date change is detected, Python automatically resets                  
      delivery_confirmed. If the city is already on file, it seamlessly re-runs the delivery check in 
      the same turn so the customer doesn't have to redo the step manually.                           
  • check_delivery: Routes to check_delivery_core for API validation. (Note: If a message contains    
  both a city and other fields, the tagger prioritizes city validation first).                        
  • place_order: Routes to place_order_core for final validation.                                     
  • none / Timeout: If the user's message lacks actionable details, or if the 30-second timebox       
  expires, the system safely bails out. The checkout state remains completely unchanged (non-         
  destructive), and a system note is passed downstream to ask the user to clarify. 


The order_agent is the most heavily guarded part of the Kavi assistant. Because checkout involves   
  real money, real products, and strict delivery rules, we do not let the LLM guess or manage the     
  checkout state. Instead, the agent is driven by a strict, deterministic Python state machine called 
  the Sequential Gate.                                                                                
                                                                                                      
  Here is exactly how the execution flow works from the moment a user starts checking out to the      
  moment an order is placed:                                                                          
                                                                                                      
1. Gathering & Cleaning Information (Field Accumulation)                                        
                                                                                                      
  To place an order, the system needs a specific set of details (recipient name, phone, delivery      
  address, city, date, and sender name). Users can provide these details in any order—either by       
  chatting naturally or by filling out the UI form.                                                   
                                                                                                      
  • Deep Merging: When details arrive, Python safely merges them into a single CheckoutData object. It
  only overwrites fields that are explicitly provided, meaning if a user types just their phone number,
  they don't accidentally erase the address they provided earlier.                                    
  • The Single Source of Truth: The system uses a strict Python function (get_missing_checkout_fields)
  to calculate exactly what information is still missing. Both the AI agent and the UI form read from 
  this exact same list. They can never disagree on what to ask the user next.                         
  • Instant Cleaning (Normalization): The system cleans data the moment it receives it, not at the end.
      • Dates: "28th June", "June 28", and "28.06.26" are all instantly converted into a standard     
      YYYY-MM-DD format. If a user types something unparseable, Python rejects it immediately and asks
      them to try again, preventing junk data from breaking the backend later.                        
      • Phones: Phone numbers are automatically formatted to standard E.164 (e.g., +94712345678).     
                                                                                                      
                                                                                                      

2. The City Security Gate                                                                       
                                                                                                      
  Cities are a massive edge case in e-commerce (e.g., ambiguous suburbs, unserviced areas). In Kavi, a
  city is earned, never just typed.                                                                   
                                                                                                      
  No matter how a city is submitted (typed in chat or filled in a form), it is never blindly saved.   
  Instead, it is routed to a strict verification process (check_delivery_core):                       
                                                                                                      
  1. Live Search: The system pings the Kapruka MCP (get the canonical city from the kapruka_list_delivery_cities tool) to search for the user's typed city.               
  2. Strict Matching: The system will only accept an exact match or a single unique result. If the    
  user types an ambiguous city (e.g., "Colombo"), the system refuses to save it and instead asks the  
  user to clarify ("Did you mean Colombo 3, Colombo 7...?").                                          
  3. Freshness Warnings: If the cart contains perishable items (like a cake or flowers), the API check
  explicitly requests a freshness warning for that specific city.                                     
  4. Auto-Correction: If the user requests delivery on a date that is unavailable, but the API        
  suggests a next_available_date, the system automatically adopts the new date into the checkout state
  and informs the user. This prevents the user from getting stuck in an infinite loop of guessing     
  valid dates.                                                                                        
  5. Confirmation: Only after all this passes does the system flag delivery_confirmed = True.         
                                                                                                      
  Crucially: If the user ever changes their delivery date, the system instantly revokes the           
  delivery_confirmed flag and automatically re-runs this city verification behind the scenes.         
                                                                                                      
  3. The Final Hurdle (The Sequential Gate)                                                       
                                                                                                      
  When the user clicks "Place Order" or says "I'm ready to pay", the system doesn't immediately send  
  it to the Kapruka API. It must pass through four strict, sequential checks (is_ready_for_order).    
                                                                                                      
  If any check fails, the process instantly halts and tells the user exactly what to fix:             
                                                                                                      
| Step | What it checks         | What happens if it fails                                                    |
| ---: | ---------------------- | --------------------------------------------------------------------------- |
|    1 | Is the cart empty?     | Aborts: “Your cart is empty — let's add something first!”                   |
|    2 | Are all fields filled? | Aborts: “I still need: recipient's phone number, delivery date.”            |
|    3 | Is the phone valid?    | Aborts: “Please use a 10-digit Sri Lankan number.”                          |
|    4 | Is delivery confirmed? | Aborts: “Let's confirm delivery is available for your city and date first.” |

                                                                                                      
  Because only the strict City Gate (Step 2) can approve Step 4, an LLM can never accidentally        
  hallucinate that an order is ready to place.                                                        
                                                                                                      
4. Success and Clean-up                                                                         
                                                                                                      
  If all four gates pass, the system executes the order:                                              
                                                                                                      
  1. Python strips away internal data and builds the exact JSON payload the Kapruka API expects.      
  2. The order is sent to kapruka_create_order.                                                       
  3. On Success: The system records the order in the user's long-term database memory, completely     
  clears the cart and checkout state to prevent duplicate orders, and passes the generated payment URL
  to the UI to render the Checkout Confirmation card.                                                 
  4. On Error: If the Kapruka API rejects it (e.g., product went out of stock during checkout), a     
  Python mapper translates the raw API error code into a friendly, human-readable apology. Raw        
  database/API errors are never shown to the customer.


### `fast_support_agent` - Order tracking Agent


Pure Python, ~90 lines. No LLM is involved here in the agent node. Resolves an order id from two sources, in priority order:

1. the UI form payload: `[ui_action:track_order_submit] {"order_id": "KAP123"}`,
2. `state.extracted_order_id` — set by the router on the typed path, or injected directly by `POST /support/track`.

Then:

- **No id** → `{"show_tracking_form": True}` — `cards.py` renders a `track_order_form` card, and Kavi invites the customer to fill it.
- **Id found** → calls `kapruka_track_order` directly, and on success **fabricates a synthetic `AIMessage(tool_calls=[...]) + ToolMessage` pair** containing the JSON result. That's a neat trick: `cards.py` extracts cards from ToolMessages, so faking a tool round-trip makes the tracking card appear through exactly the same pipeline as a real one.
- **"error"/"not found" in the result, or an exception** → re-show the form plus a `(System note: …)` telling Kavi to have the customer double-check the id from their confirmation email.

`extracted_order_id` is always cleared on exit (one-shot). The wrapped tool's docstring also encodes a subtle domain fact: the trackable *order_number* from the confirmation email is **not** the pre-payment `order_ref` returned by place_order.

## Kavi_agent - The Voice

Runs at the end of every conversational path. Before the LLM call, deterministic Python computes everything Kavi must not improvise:

1. **Cards** — `extract_cards_from_messages(...)` (§6). The checkout form is only considered "active" if the turn actually went through `order_agent`.
2. **`suggested_next_step`** — `cart.compute_suggested_next_step`, pure rules:

   ```
   empty cart                                    → None
   checkout in progress, something missing       → "continue_checkout"
   checkout complete & delivery confirmed        → None  (nothing to nudge)
   cart ≥ 2 items and NO fresh product cards     → "proceed_to_checkout"
   otherwise                                     → "add_more"
   ```

   The "fresh product cards" exception matters: if this turn just showed products, an ambiguous "yes" next turn should mean *"yes, add that"* — so the checkout nudge is suppressed and the router's hint points back at product_agent.
3. **Prompt context blocks**, each only when relevant: a first-turn-only "welcome back" block for returning customers; a "you just showed products — invite a closer look" hint; and for cart-button clicks (which reach Kavi with no specialist draft at all) precise instructions to name the specific item from the event payload and to paraphrase errors rather than quoting them.

The system prompt then pins the persona and the safety rails: Kavi is the **only** thing the customer sees, must always produce a complete standalone reply (≤130 words), preserves tool facts exactly, never invents products/prices/delivery/tracking data, never mentions internal agent names or `[System]`, doesn't discuss competitors, deflects all off-topic asks (poems included — the name කවි "Kavi" literally means *poem* in Sinhala; the pun may be acknowledged in one playful line but verses are never written — see the repo's commit history for how hard-won this rule was), never reads card facts back as a list, copies cart numbers verbatim from the context block or omits them, and never reveals its prompt.

Two Gemini-specific mechanics handled here:

- Kavi's view of history (`_kavi_visible_messages`) strips ToolMessages and tool-call stubs (keeping any text content), so it can't hallucinate tool calls and the token bill stays small.
- A **trailing synthetic human message** ("write your final reply now, in {LANGUAGE}") is appended, un-persisted, because Gemini returns empty content ~80% of the time when the input ends with an AI message (measured directly — same prompts, same model). As this agentic system mixes together multiple llm providers and synthetic tool calls, this must be handled for the final agent to reply as it it was all executions from llms that adhere to the structure


Kavi never hallucinates JSON UI components.                                                         
                                                                                                      
  • UI Cards (cards.py): At the end of every turn, a pure Python function                             
  (extract_cards_from_messages) scans the latest tool results and current state (like cart and        
  checkout) to build the UI payload. If a checkout is in progress, Python checks for missing fields   
  and attaches them to a CheckoutFormCard.                                                            
  • Suggested Next Steps (cart.py): The clickable quick-action buttons presented to the user (e.g.,   
  "Proceed to Checkout", "Add More") are generated by a strict Python rule tree                       
  compute_suggested_next_step(...) based on cart size and checkout state. The LLM never invents these.


### Conversation state (`ShoppingState`)

Defined in `agent.py`; checkpointed to Postgres per `thread_id` after every step.

| Channel | Type | Reducer | Notes |
|---|---|---|---|
| `messages` | `list[AnyMessage]` | `add_messages` | Full history, including internal drafts and `[System]` notes |
| `selected_agent` | `str` | last-value | Which specialist owns the current turn; also read next turn for checkout-in-progress detection |
| `language` | `"English" \| "Sinhala" \| "Tamil"` | last-value | Sticky; only changed when the router detects a switch. UI clicks never change it (a click has no language) |
| `user_id` | `str` | last-value | Browser-generated, from localStorage — no login |
| `cart` | `list[CartItem]` | `_last_write_wins` | Derived list; the reducer is crash-defense for two same-step writes, not a merge |
| `checkout` | `CheckoutData \| None` | `reduce_checkout` | **Explicit `None` write = reset** (place-order success, cart clear). Two same-step dict writes deep-merge. `None` = no checkout; `{}` = checkout started, nothing collected |
| `delivery_confirmed` | `bool` | `_last_write_wins` | Only ever set `True` by `check_delivery_core` after a live API success |
| `cross_sold_categories` | `list[str]` | `_last_write_wins` | Affinity prefixes already cross-sold this cart lifetime |
| `suggested_next_step` | literal | — | Computed by rules in kavi_agent; echoed to the frontend and to next turn's router |
| `cards` | `list[dict]` | — | This turn's rendered cards |
| `user_context` | `dict \| None` | — | Returning-customer summary, loaded once on a thread's first turn, then carried in checkpointed state |
| `viewed_products` | `dict[str, dict]` | shallow union | Product-detail cache keyed by id; re-fetch replaces. Backs `add_to_cart` validation and variant resolution |
| `show_tracking_form` | `bool` | — | One-shot; cleared by kavi_agent |
| `extracted_order_id` | `str \| None` | — | One-shot; router writes, support agent consumes+clears |
| `last_order_data` | `dict \| None` | — | Order-confirmation payload for card rendering; one-shot |
| `pending_product_view` | `str \| None` | plain LastValue | Kavi's Picks click → verified product id; explicitly `None`-cleared after use |


### Cards — the visual layer

`cards.py` deterministically converts tool results into typed Pydantic cards (`schemas.py`). The LLM never constructs card content; it only talks around what's already built.

**Extraction (`extract_cards_from_messages`)** scans backwards from the end of history to the turn's opening HumanMessage and collects *every* ToolMessage in that span (tool results aren't necessarily the tail — specialists often add text after them). Then:

| Source | Card |
|---|---|
| `kapruka_search_products` results | up to 20 × `product` — with partner/storefront pseudo-results filtered out (`/partner/` urls, placeholder images, `CATSYM` ids: landing pages, not purchasable items) |
| `kapruka_get_product` | `product_detail` (images, variants, attributes, shipping) — deduped if the model stuttered and fetched twice |
| `place_order` / `last_order_data` | `checkout_confirmation` (pay link, order_ref, totals, expiry) |
| `kapruka_track_order` | `order_tracking` (status, progress timeline, items, delivery photo/video flags) |
| always, when cart non-empty | `cart_summary` (line items, line totals, items_total — `None` if any price is unknown, never a guess) |
| when `checkout is not None` **and** cart non-empty | `checkout_form` (current values + `missing_fields`) — the cart guard means a stale checkout can never render a form over an empty cart |
| when `show_tracking_form` | `track_order_form` |

Post-rules: a `product_detail` card suppresses that turn's generic `product` cards (detail view wins over list view).

**`summarize_cards_for_prompt`** renders the same cards as a compact fact list into Kavi's system prompt — this is how Kavi knows what **not** to repeat (the prompt forbids reading card facts back as a list) and where it must copy cart numbers from verbatim.

Full card type catalog (see `schemas.py` for every field): `product`, `product_detail` (+ `ProductVariant`), `cart_summary` (+ `CartLineCard`), `checkout_form`, `checkout_confirmation`, `order_tracking` (+ `OrderTrackingItem`), `track_order_form`.


## API Endpoints & The UI-Action Pipeline                                                           
                                                                                                      
  Kavi exposes a suite of FastAPI endpoints. Rather than treating button clicks and chat messages as  
  two separate systems, all mutating endpoints feed back into the exact same LangGraph state machine. 
                                                                                                      
  When a user clicks a button (like "Add to Cart" or "Submit Checkout"), the respective endpoint      
  handles the mutation instantly in pure Python, then injects a synthetic [ui_action:...] event into  
  the graph. This allows the agent to naturally react to UI clicks without breaking the conversation  
  history.                                                                                            
                                                                                                      
  ### 1. Core Chat (Conversational Input)                                                             
                                                                                                      
  • POST /chat: The standard buffered chat endpoint. Accepts natural language text or stringified     
  button clicks (like a "Proceed to Checkout" suggested next step). Returns the final completed turn  
  (text + cards) in one JSON payload.                                                                 
  • POST /chat/stream: The Server-Sent Events (SSE) version of the chat endpoint. Streams the LLM's   
  thought process, tool execution status, and final text/cards in real-time.                          
                                                                                                      
  ### 2. Cart & Product Actions (Zero-Latency UI Clicks)                                              
                                                                                                      
  These endpoints process UI button clicks. They mutate the state immediately under a thread lock and 
  bypass the router LLM.                                                                              
                                                                                                      
  • POST /cart/add: Adds an item. Injects [ui_action:add_to_cart], triggering the product_agent to run
  deterministic cross-sell logic.                                                                     
  • POST /cart/remove, POST /cart/update_qty, POST /cart/clear: Simple cart mutations. These inject UI
  actions that route to the fast_ui_agent, which replies instantly using localized canned templates   
  (zero LLM inference).                                                                               
  • POST /products/details: Triggered by "Show more" buttons on product cards. Injects                
  [ui_action:view_details] to force the graph to fetch and render a ProductDetailCard.                
                                                                                                      
  ### 3. Checkout & Support Actions (Strict Gates)                                                    
                                                                                                      
  These endpoints enforce strict data validation before allowing the state to progress.               
                                                                                                      
  • POST /checkout/submit: Receives the structured checkout form. Sanitizes and merges standard fields
  (name, address, date) into state. Explicitly refuses to merge the delivery_city, flagging it for    
  mandatory API validation by the order_agent.                                                        
  • POST /checkout/check_delivery: Functionally separate from the LLM workflow. Allows the frontend to
  check delivery availability/dates directly against the MCP server without mutating the graph state. 
  • POST /checkout/place_order: Triggered by the final confirmation button. Routes directly to the    
  core Python logic to execute the order and generate a payment link.                                 
  • POST /support/track: Receives an order ID from the tracking form. Injects                         
  [ui_action:track_order_submit] to trigger the fast_support_agent for an instant tracking lookup.    
                                                                                                      
  ### 4. Data & Utility                                                                               
                                                                                                      
  • GET /picks: Powers the "Kavi's Picks" carousel on the frontend. Cached heavily (e.g., 4 hours). If
  the underlying Kapruka MCP goes down, it falls back to stale cache data rather than breaking the UI.
  • GET /user/{user_id}/history: Fetches the user's past orders directly from the Postgres Store so   
  the frontend can display them in a quick-reorder suggestion card.                                   
  • GET /health: Standard liveness probe.           



## End-to-end walkthrough using and example

**Typed: "mata chocolate cake ekak ganna ona" (romanized Sinhala)**
1. `/chat/stream` → thread lock → first-turn context load (if new thread).
2. `master_router` LLM: `{detected_language: "Sinhala", next_agent: "product_agent"}`.
3. `product_agent` translates → `kapruka_search_products(q="chocolate cake")` → ToolNode runs it (JSON forced, query recorded to the Store) → loops back → writes a terse status note, hands off.
4. `kavi_agent`: cards built from the search JSON (≤20 `product` cards + `cart_summary` if the cart has items), `suggested_next_step` computed, reply written in Sinhala script — tokens streamed live.
5. `final` event carries the cards; the frontend renders them with Add-to-Cart / More-Details buttons.

**Click: "Add to Cart" on a card**
1. `POST /cart/add` → lock → `cart.add_item` mutates state deterministically.
2. Graph turn with `[ui_action:add_to_cart] {…}` → router short-circuit (no LLM) → `product_agent`.
3. Cart already updated, so the agent just notes the fact — but the cross-sell gate may fire: cake in cart → forced `kapruka_search_products(q="flowers")`.
4. Kavi confirms the add and floats the flowers as a clearly-separate suggestion, with cards.

**Checkout: "send it to my sister in Kandy on the 28th"**
1. Router → `order_agent`. Tagger emits `[action:check_delivery city="Kandy"]` (city outranks other fields).
2. `check_delivery_core`: canonical "Kandy" saved; date on file → live availability check → `delivery_confirmed=True`, fee included in the note.
3. Kavi replies; the `checkout_form` card shows current values and remaining `missing_fields`.
4. Remaining fields arrive by chat or form submit; "place the order" → tagger `[action:place_order]` → the §5 gate → `kapruka_create_order` → confirmation card with pay link; cart and checkout reset; order recorded to the Store.

**Tracking: "where is my order KAP12345?"**
1. Router: `{next_agent: "fast_support_agent", extracted_order_id: "KAP12345"}` — one LLM call, both facts.
2. `fast_support_agent` calls the tracking tool in Python, fakes the tool round-trip, → `order_tracking` card.
3. Kavi phrases the status in one warm line; the card carries the timeline.


## Persistence, memory & personalization

Two layers share **one** Postgres `AsyncConnectionPool` (min 2 / max 40 connections — raised from 20 after a live pool-exhaustion incident; 8s acquire timeout so a starved request fails fast into the friendly error instead of stacking 30s waits; idle connections recycled at 300s):

- **`AsyncPostgresSaver` (checkpointer)** — full per-thread graph state. Every `thread_id` resumes exactly where it left off, indefinitely.
- **`AsyncPostgresStore` (cross-thread store)** — per-`user_id` long-term memory:

  | Namespace | Key | Value |
  |---|---|---|
  | `(user_id, "searches")` | `"recent"` | `{queries: [...]}` — deduped MRU, max 20, written by the search wrapper on **every** search |
  | `(user_id, "orders")` | `order_ref` and `"latest"` | order_ref, checkout_url, summary, **the full cart items** (that's what powers "you bought a cake last time…"), created_at |

There is no login: the frontend generates a `user_id`, stores it in localStorage, and sends it with every request.

**Personalization flow** (`personalization.py`): on the *first turn of a brand-new thread only* (detected by an empty checkpoint snapshot), `load_user_context` reads both namespaces and summarizes into `user_context` — `{is_returning, recent_searches (≤5), last_order {order_ref, item_names, created_at}}` — which then rides in checkpointed state (never re-queried mid-thread). It feeds two prompts: product_agent's history-biased suggestions (suppressed on cross-sell turns) and Kavi's first-turn-only "welcome back" flourish. Every step is best-effort: any failure means "no personalization", never an error.



## File map

| File | Lines | Purpose |
|---|---|---|
| `main.py` | ~170 | FastAPI app + lifespan: MCP connect → category preload (fetched once at startup and injected into Kavi's prompt — the category list never changes, so it isn't a tool) → Postgres pool → checkpointer/store setup → graph build; CORS; `/health` |
| `agent.py` | ~1730 | `ShoppingState` + reducers, `RouterDecision`, model wiring, all six nodes, prompt engineering, `log_node`, message-window hygiene, graph assembly + PNG export |
| `chat.py` | ~350 | `/chat/stream` SSE endpoint, turn budget, first-turn personalization trigger, `_repair_thread_state`, node→status mapping |
| `actions.py` | ~455 | All button/form endpoints; the `[ui_action:…]` synthetic-turn pattern; the form-city `city_to_resolve` gate |
| `picks.py` | ~180 | Kavi's Picks carousel (4h cache) + pick-click → verified product view turn |
| `tools.py` | ~890 | Local cart tools (Command-based), deterministic MCP wrappers (JSON forced, history recorded), `check_delivery_core` / `place_order_core` (the Smart Interceptor cores), Store recorders, friendly fallback strings. *Also contains `make_checkout_tools` — the legacy LLM-callable checkout tools from the pre-interceptor design; no longer bound to any agent (dead code kept for reference)* |
| `cart.py` | ~200 | Pure cart mutations (max qty 99, out-of-stock rejection), totals, `compute_suggested_next_step` rules, `COMPLEMENTARY_AFFINITY`, catalog/variant resolution |
| `checkout.py` | ~270 | Pure checkout logic: `is_ready_for_order` (the gate), `resolve_canonical_city`, `merge_checkout`/`reduce_checkout`, `normalize_date`/`normalize_phone`, `build_create_order_payload`, create-order error mapping |
| `cards.py` | ~400 | Tool JSON → typed cards; storefront-result filtering; card-facts summary for Kavi's prompt; `shape_chat_response` |
| `schemas.py` | ~265 | Every shared contract: cart/checkout TypedDicts, `CHECKOUT_REQUIRED_FIELDS`, the `ui_action` event codec, all card models |
| `personalization.py` | ~80 | Store → `user_context` summary (pure logic separated from Store I/O for testability) |
| `mcp_client.py` | ~40 | Kapruka MCP connection; tools loaded once at startup onto `app.state` |
| `locks.py` | ~15 | Per-thread asyncio locks |
| `observability.py` | ~70 | Langfuse wiring (no-op without keys) |
| `tests/` | ~500 | Unit tests for the deterministic cores: cart mutations, the checkout gate + city resolution, action payloads, personalization summaries |
| `TASKS.md`, `AGENT_OPERATIONS.md`, `frontend_integration_guide.md`, `findings.md`, `mcp_info.md` | — | Sprint log, ops notes, the contract doc the frontend was built against, research notes |



---
By [Subhanu](https://github.com/subhanu-dev) 🚀


