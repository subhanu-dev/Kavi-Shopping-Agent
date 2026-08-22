# Kavi — Build Plan & Task Tracker

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

Sprints are ordered by dependency, not calendar time — finish one before starting the next. **No dimension is pre-deprioritized** — multi-language, visual cards, and checkout correctness are all must-have. If real time pressure hits mid-build, flag it explicitly for a decision rather than silently dropping scope.

---

## Cross-cutting pattern — UI actions must produce an agent-aware reaction

Any UI-driven action (click a product card's "Add to cart", submit a checkout form) must do **two** things, not one: (1) deterministically patch state, and (2) make the right agent react in natural language using the new state — never a silent state mutation. The same applies whether info arrives via free-text chat *or* a structured form submission; both write into the same state fields and trigger the same downstream logic.

**Mechanism** (LangGraph-native, reused everywhere instead of bespoke logic per endpoint):
1. Action endpoint receives a structured event: `{action_type, payload}` (e.g. `add_to_cart` + product, or `checkout_form_submit` + form fields).
2. Endpoint reads current state with `await graph.aget_state(config)`, then mutates `cart`/`checkout` **in Python** (append/remove/merge) — these fields have no LangGraph reducer, so a patch *replaces* them wholesale rather than merging. Always read-modify-write the full value.
3. Endpoint calls `graph.aupdate_state(config, patch, as_node="master_router")` — **not** the destination agent. `as_node` tells LangGraph "this node just finished"; resuming continues along *that node's* outgoing edges. Setting it to the destination agent (e.g. `"product_agent"`) would mark that agent as already-done and skip straight past it to `kavi_agent`, which has no tools — so it could never back an upsell with a real product search, and `order_agent`'s checkout-gating tool loop would never run. Setting it to `"master_router"` with `selected_agent` included in the patch fakes "the router already decided X" and correctly resumes into a **fresh run** of the right specialist node.
4. The patch also appends a synthetic event message, e.g. `"[ui_action:add_to_cart] product=cake00ka002034 qty=1"` or `"[ui_action:checkout_form_submit] {json of submitted fields}"` — this is what lets the agent "know what happened" rather than guessing from a diff.
5. Endpoint resumes with `graph.ainvoke(None, config)` — no new input. `route_after_master_router` reads the now-patched `selected_agent` and routes straight into `product_agent`/`order_agent`/`support_agent`, which runs for real (can call tools), then flows to `kavi_agent` as normal. This skips only the router's own LLM call and the need to replay the conversation from `START` — every node downstream still genuinely executes.
6. Response shape is identical to a normal `/chat` reply (`{text, cards}`) — frontend doesn't need a special case for action-triggered replies vs typed ones.
7. Guard against races: wrap each thread's read-modify-write-resume sequence in a per-`thread_id` `asyncio.Lock` (in-memory, single-instance deployment) so a button click and an in-flight `/chat` call for the same thread can't interleave checkpoint writes.

**Prompt rule** (add to `product_agent`, `order_agent`, `kavi_agent`): when the latest message is a `[ui_action:...]` event rather than user-typed text, acknowledge what happened and proactively suggest the next step (upsell a complementary product, or ask for the next missing checkout field) — don't treat it as a question to answer.

This same mechanism is what lets "ask for checkout info conversationally, turn by turn" and "show a checkout form card the user fills out and submits at once" coexist: both just merge into `ShoppingState["checkout"]`, and `order_agent`'s gating logic (Sprint 3) reacts to whatever's missing regardless of source.

## Cross-cutting pattern — text complements cards (never repeats them), and a deterministic "suggested next step" drives both phrasing and routing

- **No redundant text**: cards carry all factual data (name, price, qty, stock, totals). `kavi_agent`'s `text` must never restate those facts — its job is reaction, personality, and the next-step nudge. Feed it a compact "facts already visible on card" list (not the raw card JSON) plus an explicit don't-repeat instruction. If testing shows the model still drifts into restating facts despite the instruction, fall back to constraining `kavi_agent`'s output into a structured `{reaction, suggestion}` schema instead of free text — that structurally prevents a factual recap.
- **Deterministic next-step, not LLM-guessed**: after any cart/checkout-affecting turn, the specialist node (`product_agent`/`order_agent`) computes `suggested_next_step` with a plain rule-based helper using actual state (cart size, checkout completeness, stock issues) — e.g. first item added + no checkout started → `add_more_or_checkout`; 2+ items → lean `proceed_to_checkout`; checkout already has some fields filled → `continue_checkout`. Stored as `ShoppingState["suggested_next_step"]`. `kavi_agent` phrases that suggestion in its own voice but must never contradict it — keeps the prose and the actual state in sync.
- **Feeds routing**: `master_router` reads `suggested_next_step` from state as a disambiguation hint for short/ambiguous follow-ups ("yes", "sure", "do it") — cheaper and more reliable than re-deriving intent from prose history alone every time.
- **Feeds the frontend**: `suggested_next_step` is also returned to the frontend so it can render the suggestion as a clickable quick-action button (e.g. "Proceed to checkout →"). Clicking it is just another `[ui_action:...]` event through the resume mechanism above — closing the loop between what the agent suggests and what the user can tap.

## Cross-cutting pattern — persistent history writes are deterministic, not LLM-dependent

Same philosophy as cart mutations: writing to the cross-thread `Store` must not depend on the LLM remembering to do it after seeing a tool result — that's a paraphrase risk, not a guarantee.

- `kapruka_create_order` and `kapruka_search_products` are wrapped in thin Python functions that call the real MCP tool, then deterministically inspect the result (success vs an `"Error (...)"` string) and write to the Store accordingly — `(user_id, "orders")` on a successful order, `(user_id, "searches")` on a search. The wrapper returns the tool's original output unchanged, so the agent's behavior and the LLM's view of the tool result are unaffected; the write just always happens alongside it, guaranteed.
- These wrappers need `user_id` and the `Store` instance at call time. LangGraph's `InjectedStore` (a tool parameter annotation, same pattern as `InjectedState`) gives them the compiled graph's store automatically; `user_id` needs to be an explicit field in `ShoppingState` (Sprint 1) — not just embedded in the `thread_id` string — since tools read from state via `InjectedState`, not from FastAPI request context.
- Search history writes are capped/deduped (e.g. keep the last N distinct queries per user) rather than growing unbounded.
- The read side has one concrete trigger, not "sometime at session start": the first turn of a brand-new thread (no prior checkpointed messages) — not re-queried from Postgres on every single turn.

## Sprint 1 — Foundations: fix, model state, define contracts

Nothing visual yet — this sprint makes the next three sprints possible.

- [x] Fix bug: `create_order_agent_node` is defined twice in `agent.py` (lines ~206 and ~248). The second definition silently overwrites the first, so `order_agent_node` in `build_shopping_graph` is actually getting the *support* agent's closure. Renamed to `create_support_agent_node`.
- [x] Fix cleanup: `order_tools` currently includes `kapruka_track_order`, overlapping with `support_agent`'s exclusive tracking responsibility per the router's own routing rule. Removed `track_order` from `order_tools` and dropped the stray "order tracking" bullet from `order_agent`'s system prompt — tracking is `support_agent`-only.
- [x] Share the existing `AsyncConnectionPool` (already opened in `main.py` for the checkpointer) with the new `AsyncPostgresStore` instead of opening a second pool, to stay within Railway's Postgres connection limits.
- [x] Extend `ShoppingState` with a `cart: list[CartItem]` field. Shape it to map 1:1 onto `kapruka_create_order`'s cart item (`product_id`, `quantity`, `icing_text`) plus display fields needed for cards (`name`, `image_url`, `unit_price`, `currency`, `in_stock`). Defined in `schemas.py`.
- [x] Add a `checkout: dict | None` field to `ShoppingState` to hold in-progress checkout data (`recipient`, `delivery`, `sender`, `gift_message`) as it's collected turn-by-turn, plus a `delivery_confirmed: bool` flag gating `create_order`.
- [x] Add a `suggested_next_step: str | None` field to `ShoppingState` with a fixed enum (`add_more`, `proceed_to_checkout`, `continue_checkout`, `browse_categories`, `track_order`, `None`) — written by specialist nodes, read by `kavi_agent` (for phrasing), `master_router` (for routing hints), and returned to the frontend (for quick-action buttons). *(Field exists; nodes don't compute/consume it yet — that's Sprint 2/3.)*
- [x] Add a `user_id: str` field to `ShoppingState`, populated from the request payload on every `/chat` and action-endpoint call (cheap to just pass every turn, no separate "first turn only" logic needed). This is what makes `user_id` available to tools via `InjectedState`, since tools can't reach into the FastAPI request directly.
- [x] **Settled**: frontend sends `user_id` and `thread_id` as two explicit, independent fields on every request (not derived). Updated `ChatRequest` in `chat.py` and dropped the `thread_id = f"{user_id}:{conversation_id}"` string-concatenation in `main.py`/`chat.py` — uses the frontend-supplied `thread_id` directly for the LangGraph checkpointer `config`, and `user_id` directly for `ShoppingState["user_id"]`/Store namespacing.
- [x] Define the frontend card JSON contracts (product card, cart summary card, **checkout form card** — fields + which are still missing, delivery/checkout confirmation card, order confirmation card, tracking card) in `schemas.py`. Not yet emitted by any node — that's Sprint 2/3.
- [x] Define the `[ui_action:...]` synthetic event message format used by the action-resume mechanism below (action_type + payload serialization), and an `action_type` enum: `add_to_cart`, `remove_from_cart`, `update_qty`, `checkout_form_submit` — `UiAction` in `schemas.py`.
- [x] Stand up `AsyncPostgresStore` (LangGraph's cross-thread `Store`, separate from the `AsyncPostgresSaver` checkpointer already in `main.py`), sharing the same connection pool. Namespaces (`(user_id, "orders")`, `(user_id, "searches")`) are used at read/write time in Sprint 2/3 — no schema migration needed beyond `store.setup()`.
- [x] Add per-node call logging across the graph (`master_router`, `product_agent`, `order_agent`, `support_agent`, `kavi_agent`): log on entry/exit — which node ran, what triggered it (typed message vs `[ui_action:...]` event), `selected_agent`/`language`, every tool call made + a truncated result, and elapsed time. `log_node` decorator in `agent.py`.

**Also fixed while in here**: `main.py` was importing from the stale `v3` package (`from v3.agent import ...` etc.) instead of `v4_claude` — meant none of this would have actually been loaded at runtime. Switched to `v4_claude.*` imports and verified `import v4_claude.main` resolves cleanly end-to-end.

## Sprint 2 — Cart engine + direct card actions + rich product output ✅

- [x] Implement cart mutation logic as plain Python functions operating on a cart list (add/remove/set qty/clear), with stock/qty validation — `cart.py` (`add_item`, `remove_item`, `set_quantity`, `clear`, `CartError`). Single shared implementation called by both the LLM tools and the UI-action endpoints.
- [x] Wrap that logic as **local (non-MCP) LangGraph tools** — `add_to_cart`, `remove_from_cart`, `update_cart_quantity`, `clear_cart` in `tools.py`, using `InjectedState`/`InjectedToolCallId` and returning `Command(update={"cart": ..., "messages": [ToolMessage(...)]})`. Verified directly against a real compiled graph (not just docs) — `ToolNode` cannot be invoked standalone outside a Pregel run, so this was tested through an actual `StateGraph`.
- [x] Bind these cart tools into **both** `product_tools` and `order_tools` `ToolNode`s.
- [x] Add dedicated endpoints — `POST /cart/add`, `/cart/remove`, `/cart/update_qty`, `/cart/clear` (`actions.py`) — implementing the UI action pattern, guarded by a per-`thread_id` `asyncio.Lock` (`locks.py`). Cold-start (no prior thread) returns `404`, not a crash.
- [x] `product_agent`'s tool results (search/get_product) converted into product cards — `cards.py: extract_cards_from_messages`. **Found and fixed a real bug here**: tool results aren't always the last messages — the specialist often adds its own follow-up text after a tool result, before handing off to `kavi_agent`. The extractor now scans back to the most recent `HumanMessage` (start of turn) and collects every tool result in that span, not just a contiguous tail.
- [x] `kapruka_search_products` and `kapruka_get_product` wrapped (`tools.py`) to force `response_format="json"` unconditionally — never left to the LLM to remember — and the search wrapper writes `(user_id, "searches")` to the Store via `InjectedStore`, capped to the last 20 distinct queries.
- [x] `compute_suggested_next_step(cart, checkout, delivery_confirmed)` implemented in `cart.py`, called from `kavi_agent`.
- [x] `kavi_agent` now returns `{messages, cards, suggested_next_step}`; `chat.py`/`actions.py` shape this into `{user_id, thread_id, text, cards, suggested_next_step, selected_agent, language}` via `cards.py: shape_chat_response`. Simplified scope: `suggested_next_step` is exposed as a plain enum string, not a structured "button spec" object — left to the frontend to map to button copy/styling, cleaner separation of concerns than prescribing exact labels from the backend.
- [x] "Add to cart" button → `/cart/add`, resuming through `product_agent`/`kavi_agent` for a real reaction, not a generic confirmation.
- [x] `product_agent`/`order_agent` prompts document the cart tools and checkout guidance.

**Two real bugs found only by actually running the graph (not visible from reading code/docs) — both fixed:**

1. **Cart tools' own success was silently undermined by the *next* LLM call.** When `product_agent` saw a `[ui_action:add_to_cart]` event, it didn't know the cart was *already* mutated by the deterministic endpoint — it called `get_product` to "verify" the item, and when that failed (or returned different data) it told the user the add had *failed*, contradicting the actual cart state. Fixed by explicitly telling `product_agent`/`order_agent`'s prompts: a `[ui_action:...]` event means the mutation already happened — acknowledge it, never re-verify or redo it.
2. **`kavi_agent` intermittently returned completely empty text** (`finish_reason="STOP"`, near-zero output tokens) specifically when its input message list ended in an `AIMessage` (the specialist's own draft) rather than a `Human`/`Tool` message — reproduced this in isolation directly against the raw model (~80% empty rate on identical prompts), independent of `thinking_level`/`thinking_budget`. Gemini treats "respond when the last turn is already yours" as nothing new to react to. Fixed architecturally: `kavi_agent` now appends an ephemeral trailing instruction message (not persisted to state) so its model call always ends on a clear instruction turn, never on a stale AI draft. Also set `thinking_budget=0`/`thinking_level="low"` on all four models — unrelated to this specific bug but a real secondary issue (one diagnostic call showed 281 of 314 output tokens silently consumed by hidden reasoning tokens), and these nodes don't need extended reasoning anyway.

## Sprint 3 — Checkout & order flow + history writes ✅

The checkout sequence is strict and order-dependent, enforced in code (`checkout.py`/`tools.py`), not left to the LLM to sequence loosely:

1. **Cart ready** — `order_agent_node` deterministically initializes `checkout = {}` the moment there's a cart and no checkout has started yet (so the checkout form card appears immediately).
2. **Collect fields — two input paths, same destination**: conversational (`update_checkout_info` tool, merges via `checkout.merge_checkout`) or form submit (`POST /checkout/submit`, same merge function). Both land in the same `checkout` shape; **city is deliberately excluded from both direct-merge paths** — it only ever gets set via canonical resolution (see step 3), closing a loophole where a raw/typo'd city string could otherwise satisfy the "field present" check without ever being validated as deliverable.
3. **Resolve canonical city + check delivery — one composite tool, not two**: `check_delivery_for_city(city)` (`tools.py`) internally calls `kapruka_list_delivery_cities` then `kapruka_check_delivery`, deterministically resolving the canonical name (`checkout.py: resolve_canonical_city` — exact match or single-result only, otherwise asks the user to disambiguate) and setting `delivery_confirmed` based on real availability. Collapsing this into one tool (rather than trusting the LLM to call two raw tools in the right order and propagate the exact canonical string) removes an entire class of LLM-sequencing risk.
4. **Place the order — gated, zero-argument tool**: `place_order()` reads `cart`/`checkout`/`delivery_confirmed` straight from state via `InjectedState` (the LLM never reconstructs the order payload — `checkout.py: build_create_order_payload` does, deterministically). `checkout.py: is_ready_for_order` gates the real API call; on success, writes to `(user_id, "orders")` via `InjectedStore` and resets `cart`/`checkout`/`delivery_confirmed`; on failure, `checkout.py: parse_create_order_error` maps `create_order`'s error codes to specific friendly messages (never the raw `"Error (code): ..."` text).
5. **Raw MCP tools are not exposed to the LLM at all** for delivery/order creation — only the composite/gated tools are bound, so the gates can't be bypassed by calling the raw tool directly.
6. `support_agent` tracks orders via a `kapruka_track_order` wrapper (forces `response_format=json`), using the customer's **post-payment `order_number`** — its prompt explicitly distinguishes this from the pre-payment `order_ref`.
7. `test_checkout.py` (stdlib `unittest`, no new dependency): 21 tests covering canonical city resolution (exact match, single match, ambiguous, no match), the `is_ready_for_order` gate, `merge_checkout`, `build_create_order_payload`, and `create_order` error-code mapping.

**Three real bugs found only by actually running the graph against real Gemini (not visible from reading code) — all fixed:**

1. **The model sometimes pre-confirms the city in chat instead of calling `check_delivery_for_city` immediately**, even though the tool itself handles disambiguation — redundant, slower conversational style rather than a bug, but the prompt was strengthened to call the tool immediately rather than asking first.
2. **`InvalidUpdateError: At key 'checkout': Can receive only one value per step`** — when `update_checkout_info` and `check_delivery_for_city` were called as *parallel* tool_calls in one AIMessage (encouraged by an earlier prompt phrasing, "call both in the same response"), both wrote to the `checkout` channel in the same Pregel step, which the default last-value channel rejects outright. Worse than just a crash risk: parallel execution means `check_delivery_for_city` would read the *pre-step* `checkout` snapshot via `InjectedState`, missing the date `update_checkout_info` just saved in the same burst — functionally broken, not just unsafe. Fixed two ways: (a) the prompt now explicitly says call at most one checkout tool per response, wait for its result before the next; (b) added defensive reducers on `cart`/`checkout`/`delivery_confirmed` (`_merge_checkout_writes` using the same deep-merge-by-section logic, `_last_write_wins` for the others) so even if parallel writes occur, the graph merges instead of crashing.
3. **Test design flake, not a product bug**: an early version of the end-to-end test trusted the LLM to chain `update_checkout_info` → `check_delivery_for_city` correctly within one turn before asserting readiness for `place_order`. When the LLM didn't chain them (asked to confirm the city first instead), the test's `place_order` call hit a *different* gate (missing city) than the one it meant to exercise (the `create_order` error-code path), but still passed — for the wrong reason. Fixed by driving state directly via `aupdate_state` for that specific scenario, isolating the error-code-mapping concern from LLM tool-chaining variance, and by adding a one-turn "yes, that's correct" follow-up fallback to the chat-driven scenarios so minor conversational variance doesn't flake the test.

## Sprint 4 — Personalization, streaming, and polish ✅

New module `personalization.py` keeps the same philosophy as cart.py/checkout.py: the pure,
unit-testable summarization/reconstruction logic (`summarize_user_context`,
`describe_user_context`, `rebuild_cart_from_order`) is separated from the async Store I/O
(`load_user_context`, `load_latest_order_record`).

- [x] On the first turn of a brand-new thread (concrete trigger: `graph.aget_state` returns
  empty `values`), `chat.py` reads `(user_id, "orders")/"latest"` and
  `(user_id, "searches")/"recent"` from the Store, summarizes them, and seeds
  `ShoppingState["user_context"]`. Carried in checkpointed state thereafter — **not**
  re-queried on later turns. `kavi_agent` uses it for a brief "welcome back" (only when
  `human_turns <= 1`, so it never fires mid-conversation).
- [x] ~~Re-order shortcut ("order the usual")~~ **Removed by request.** We do NOT auto-rebuild
  the cart from a past order. Instead, `place_order` persists the **cart items** with each
  order record purely so Kavi knows what the customer bought before — that history feeds
  personalized *suggestions*, not an auto-repeat. (No `reorder_usual` tool, no router/prompt
  routing for it.)
- [x] `product_agent` makes **personalized suggestions** from `user_context` (recent searches
  + last order's item names): its prompt tells it to proactively recommend items that
  complement/relate to past purchases (e.g. previously bought a cake → suggest a matching
  bouquet), while explicitly NOT assuming they want to re-buy the same item.
- [x] `/chat/stream` implemented as SSE (`StreamingResponse`, `stream_mode=["updates","messages"]`).
  Emits `status` (one per node entered, tool nodes filtered out), `token` (incremental text),
  and a closing `final` event (cards, suggested_next_step, selected_agent, language). **Only
  `kavi_agent`'s tokens are streamed** — filtered by `metadata["langgraph_node"] == "kavi_agent"`
  — so specialist drafts and every raw tool call/result stay server-side. Verified directly:
  the metadata key is present and the filter isolates kavi's text cleanly. An immediate
  `status: received` event is emitted before the graph runs, so the frontend gets a first
  byte (~94 ms in testing) without waiting for the router's LLM call to finish.
  **Wire-level streaming proof**: confirmed against a real uvicorn server over a real TCP
  socket that frames arrive incrementally — ack at ~94 ms, status events as each node
  finishes (~900/2100/3250 ms), then kavi tokens spread over ~500 ms, `final` last. NOTE
  for anyone re-testing: `httpx.ASGITransport` buffers the entire ASGI response before
  releasing it, so a test through ASGITransport falsely looks "buffered/not streaming" —
  you must test against a real uvicorn server (or trust `graph.astream`, which emits kavi
  token chunks incrementally — measured 6 chunks over ~312 ms at the source).
- [x] Multi-language pass: router prompt now explicitly handles romanized Sinhala/Tamil
  (detect language, not script) and keeps the current language when ambiguous; `kavi_agent`
  told to use natural spoken-style Sinhala **and** Tamil. Verified: Sinhala and Tamil
  greetings are detected correctly and answered naturally.
- [x] Error handling pass: every Kapruka MCP call (search, get_product, track_order,
  list_delivery_cities, check_delivery, create_order) is wrapped in try/except returning a
  friendly Kavi message (never a raw exception). `/chat` and `/chat/stream` have top-level
  graceful fallbacks (`GRACEFUL_ERROR_TEXT` / an `error` SSE event). The place_order failure
  message explicitly reassures "nothing has been charged".
- [x] Logging finalization: action endpoints now log entry with `user_id`/`thread_id`/
  `selected_agent`; `/chat` and `/chat/stream` log entry; all nodes already covered by the
  Sprint 1 `log_node` decorator (so stream + actions get per-node logs for free, since both
  drive the same nodes).
- [x] End-to-end smoke test (`_verify_sprint4.py`, throwaway, real Gemini + fake MCP stubs):
  personalization, reorder, streaming token-filtering, search-outage error handling, hard-
  failure fallback, Sinhala+Tamil, and a full English search→add→checkout→place→track flow —
  all 7 scenarios passed. Permanent regression tests: `test_personalization.py` (13 stdlib
  `unittest` tests; 34 total across the suite, all passing).

**No new product bugs surfaced this sprint** — the implementation passed end-to-end on the
first real-Gemini verification run (after a trivial Windows-console UTF-8 print fix in the
throwaway script, not a code bug). The one design unknown going in — whether LangGraph's
`stream_mode="messages"` metadata reliably exposes `langgraph_node` so we can stream *only*
kavi's tokens — was confirmed working by direct execution rather than assumed.

## Sprint 5 — Session-aware, cart-driven proactive recommendations ✅

Cart-driven proactive product recommendations: no node previously did *live, in-session*
cross-sell (`product_agent` only recommended from long-term history, never read
`state["cart"]`; `kavi_agent` has no tool access). Full design + audit history:
`C:\Users\subha\.claude\plans\flickering-greeting-river.md`.

- [x] **`cart.py`**: `COMPLEMENTARY_AFFINITY` dict (`CAKE`→flowers, `FLOWER`→chocolates,
  `COMBO`→greeting card, `CHOCOLATES`→flowers, `GREETING`→chocolates) + deterministic
  `find_complementary_suggestion(cart, already_suggested)`. `compute_suggested_next_step`
  gained `has_fresh_product_cards: bool = False` — `len(cart) >= 2` now also requires
  `not has_fresh_product_cards` to return `"proceed_to_checkout"`.
- [x] **`agent.py` — `ShoppingState`**: new `cross_sold_categories` field (`_last_write_wins`).
- [x] **`agent.py` — `product_agent_node`**: reads live `cart`, adds a "Current cart" block to
  its prompt (fixes the original cart-blindness bug). New `_cart_was_just_added_to(messages)`
  module-level helper + a unified gate (`added_this_turn` — covers both the
  `[ui_action:add_to_cart]` button path and the typed-text tool-call path —
  `checkout_not_started`, `complementary`) computed once and shared by: the `history_hint`
  suppression, the forced `cross_sell_instruction`, and the `cross_sold_categories` write.
- [x] **`agent.py` — `kavi_agent`**: computes `has_fresh_product_cards` from `cards`, passes
  it into `compute_suggested_next_step`; added the "what you asked for" vs "you might also
  like" framing line.
- [x] **`tools.py`**: `clear_cart` and `place_order`'s success path both reset
  `cross_sold_categories: []`.
- [x] **`actions.py`**: `/cart/clear` resets `cross_sold_categories` too (`_resume_cart_action`
  gained an `extra_state_patch` parameter so this didn't have to be hardcoded into the
  shared add/remove/update_qty/clear helper).
- [x] **`test_cart.py`** (new, 15 tests): `find_complementary_suggestion` (cake→flowers,
  already-cross-sold skipped, empty/no-match/multi-item cases, affinity-table sanity) +
  `compute_suggested_next_step`'s new parameter (override, regression guard, doesn't leak
  into the checkout branch). All 45 tests across the suite pass (`test_cart` + `test_checkout`
  + `test_personalization`), no regressions.
- [x] **End-to-end verification** against real Gemini + the real Kapruka MCP server
  (`InMemorySaver`/`InMemoryStore` in place of Postgres, throwaway script, deleted after):
  button add → real `kapruka_search_products(q="flowers")` fires once, flower cards appear,
  reply correctly frames it as "how about adding some flowers" rather than restating the add;
  a second same-category add does **not** repeat the suggestion (`cross_sold_categories`
  stays `["CAKE"]`, reply just acknowledges the quantity change); checkout already in
  progress → no forced search at all; a 3-item cart with a fresh cross-sell card correctly
  produces `suggested_next_step="add_more"` instead of `"proceed_to_checkout"` (Bug #2's fix,
  confirmed live, not just unit-tested).

**Real bug found only by running this against the live router (not visible from reading code) — flagged, not fixed, separate from this sprint:**
`master_router`'s prompt only lists "product search/details/suggestions/browsing" under
`product_agent` and "delivery/order creation/checkout" under `order_agent` — it never
mentions cart-adds explicitly. `add_to_cart` is bound on **both** agents (`product_tools` and
`order_tools`), so a *typed* "add that to my cart" can get routed to `order_agent` instead of
`product_agent` depending on conversation context (confirmed live: with no strong
`suggested_next_step` signal carried in from a prior turn, the router sent it to
`order_agent`, which added the item and immediately started collecting checkout fields,
correctly never touching Sprint 5's logic since that's scoped to `product_agent` only by
design). This is a pre-existing routing ambiguity, not something Sprint 5 introduced —
`_cart_was_just_added_to` itself is verified correct in isolation (unit-checked against
synthetic message sequences for the typed-add, button-add, plain-search, and
stale-prior-turn cases) and fires correctly whenever the router *does* send a typed add to
`product_agent`. Real-world activation of the typed-path cross-sell is therefore inconsistent
today, gated on a router decision outside this sprint's scope. Worth a future sprint: teach
`master_router`'s prompt to route any cart-add (typed or otherwise) to `product_agent`
consistently, since that's the only agent designed to react to it with a real suggestion.

**Verified by direct code inspection, not re-run live (lower risk, simple conditionals):**
`history_hint` suppression on the cross-sell turn and its being unaffected on every other
turn; the no-affinity-match fallback; clear-cart-then-re-add re-arming the cross-sell.

**Explicitly out of scope**: cold-start recommendations for first-time visitors with an empty
cart and no history (`category=newadditions`/`bestsellers` don't work as live search filters
even though they're real top-level categories — confirmed against the live MCP server — so a
future "starter products" endpoint would need `sort=newest`/`sort=bestseller` instead; a
separate, unstarted idea, not bundled here). Mid-checkout cross-sell in `order_agent` —
deferred.

## Sprint 6 — Latency instrumentation & diagnosis (measure-first) 🔬

Responses are slow (~15–18 s/turn). User logs show each Gemini call takes 5–9 s and there are
3 sequential calls per turn (`master_router` → specialist → `kavi_agent`), plus ~3 s of remote-DB
overhead on UI actions (app runs locally against a remote Railway Postgres). Measure-first: add
the missing timing (total-turn, MCP, DB) and run per-checkout-path tests to rank bottlenecks
before optimizing. Existing `log_node` already logs per-node `elapsed_ms`.

- [x] Total-turn + time-to-first-token timing on `/chat` and `/chat/stream` (`chat.py`)
- [x] `aget_state` timing in `_build_initial_state` (`chat.py`) — a concrete remote-DB read
- [x] `_timed_ainvoke` helper + route all 6 MCP `.ainvoke` calls through it (`tools.py`)
- [x] Tag `log_node` exit with a greppable `[timing]` prefix (`agent.py`)
- [x] `_verify_perf.py` (throwaway, deleted): (a) raw per-call Gemini baseline, (b) per-checkout-path
  stage timing, (c) InMemory-vs-Postgres DB tax (real Gemini + real Railway DB)
- [x] Run diagnostic, capture numbers, rank bottlenecks
- [x] Report findings + recommended optimizations (measure-first — optimizations NOT applied yet)

### Findings (measured)
**Raw single Gemini call from this region (no graph):** `2.5-flash` median ~2.8s, `3.5-flash`
thinking=low ~3.7s — but **very high variance** (spikes to 9–24s). `3.5-flash` *default* thinking
~6.3s (so our `thinking_level="low"` already saves ~2.5s). **Tool-binding/AFC adds ~0ms** (ruled
out). So per-call cost is **network RTT to Google + variance**, not our config.

**Per turn = 3–4 sequential LLM calls:** `master_router` → specialist (decide tool) → specialist
(react to result, *its text is then discarded by kavi*) → `kavi_agent`. Measured per-path totals:
search ~7.8s, product details ~11.5s, cart-add ~8.3s, checkout-collect ~22s (router spiked to 11s),
check-delivery ~20s, place-order ~6.4s, tracking ~6.1s. MCP itself ≈ 0 (fake stubs; real MCP adds
~0.5–1s each).

**Remote DB:** one `aget_state` round-trip from local = **391ms**; a turn does several → ~1–2s/turn
(more on UI actions, matching the ~3s prod gap). **Vanishes when app + DB are co-located in prod.**
(The InMemory-vs-Postgres *total* comparison was dominated by a 24s LLM spike, so the direct
`aget_state` number is the reliable DB figure.)

### Ranked bottlenecks
1. **LLM call count × per-call latency** (dominant). Each turn fans through 3–4 sequential Gemini
   calls at ~2–4s median each (variance to 24s).
2. **`kavi_agent` adds a full call every turn**; the **specialist tool-loop runs the model twice**
   (the post-tool "react" call is discarded since kavi re-synthesizes).
3. **Remote DB from local** (~1–2s/turn) — a dev artifact; gone in co-located prod.
4. Config is fine (AFC negligible; thinking=low good).

### Recommended optimizations (next pass — not applied)
1. **Route tool results straight to `kavi_agent`** instead of back to the specialist (skip the
   discarded post-tool call); only loop back to the specialist when *another* tool is needed.
   Removes ~1 call (~3s) per tool-using turn — highest leverage.
2. **Cut/lighten the router call** (heuristic or merged classification) — removes another call.
3. **Frontend on `/chat/stream`** for perceived latency (already built/verified).
4. **Co-locate app + DB in prod** (internal Railway URL); optional InMemory toggle for local dev.
5. Try **kavi `thinking` lower/off** (~1–2s).

---

## Sprint 7 — Postgres pool exhaustion fix (checkout hang/timeout) ✅

A live test session ended with the final "Proceed To Checkout" request hanging and the frontend
showing a client-side timeout. Server logs showed `psycopg_pool.PoolTimeout: couldn't get a
connection after 30.00 sec` from `chat.py`'s `aget_state` call. Confirmed via a direct read-only
query against the live Railway Postgres (`SHOW max_connections` / `pg_stat_activity`) that the
database itself was **not** the bottleneck (100 allowed, ~13 in use) — our own app's
`AsyncConnectionPool(max_size=20)` had run out of its own slots. The session's own
`[timing] aget_state ms=...` logs showed this building gradually (300–500ms → a sudden 34266ms →
then the hard timeout), consistent with connections being checked out and not always returned —
most plausibly tied to long turns (3–4 sequential Gemini calls, per Sprint 6) getting abandoned by
a client mid-`/chat/stream`, a documented failure class in `psycopg_pool`'s own changelog (the
installed `psycopg-pool==3.3.1` already has the newest of those fixes, so this addresses the
*symptom* with certainty while treating the exact leak point as not-fully-confirmed).

- [x] `main.py`: pool `timeout` 30.0s → **8.0s** (fail fast instead of stacking multiple 30s waits
  across one turn's several DB round-trips) and `max_size` 20 → **40** (confirmed safe headroom —
  Railway allows 100, only ~13 in use)
- [x] `main.py`: background task logs `pool.get_stats()` every 30s under `[timing]` — continuous
  pool-health trail so a future leak shows up before the next hard failure, not just after
- [x] `chat.py`: `MAX_TURN_SECONDS = 60` — `/chat`'s `graph.ainvoke` wrapped in `asyncio.wait_for`;
  `/chat/stream` now manually pulls from the stream iterator with a per-chunk `wait_for` against
  the *remaining* turn budget (not a per-iteration check) so a hang inside any single node's model
  call — even one that never streams an intermediate token, like the router's structured-output
  call — still gets bounded, not just hangs visible between chunks
- [x] `actions.py`: `_resume_via_master_router`'s `aupdate_state` + `ainvoke` sequence wrapped in
  the same `MAX_TURN_SECONDS` bound, with a graceful universal-shape fallback response on any
  failure (this closes a pre-existing gap too — this function previously had no error handling at
  all, unlike `/chat`)
- [x] Verified: all 45 unit tests pass; `main`/`chat`/`actions` import cleanly together (checked
  for circular imports since `actions.py` now imports `GRACEFUL_ERROR_TEXT`/`MAX_TURN_SECONDS`
  from `chat.py`)

**Deliberately unchanged**: the per-`thread_id` lock's scope (`locks.py`) still spans the entire
turn — it's the only thing preventing two concurrent graph invocations on the same thread from
corrupting the LangGraph Postgres checkpoint history, a correctness issue, not just a performance
one. The fix bounds *how long* a turn (and the lock, and any connection it holds) can ever run,
rather than shrinking what the lock protects.

**Known limitation, accepted**: if the 60s ceiling fires while `place_order`'s `kapruka_create_order`
MCP call is in flight, we won't know whether the order actually succeeded server-side before
cancelling. This risk already existed today via client-disconnect-driven cancellation; this change
makes it bounded/deterministic rather than introducing it. A `place_order`-specific "if interrupted,
check tracking before retrying" message would be a reasonable follow-up but is separate scope.

---

## Known issues carried in from current code — ~~fixed in Sprint 1/2/3~~
- ~~Duplicate `create_order_agent_node` definition.~~ Fixed.
- ~~`order_tools` includes `kapruka_track_order`...~~ Fixed.
- ~~`main.py` importing from stale `v3` package instead of `v4_claude`.~~ Fixed (found while wiring the Store).
- ~~`order_agent`/`support_agent` have no explicit step-by-step checkout sequencing.~~ Fixed in Sprint 3 — gated via `check_delivery_for_city`/`place_order`, raw create_order/check_delivery/list_delivery_cities no longer exposed to the LLM at all.
- ~~`/chat/stream` endpoint is still fully commented out in `chat.py`.~~ Implemented in Sprint 4 as an SSE endpoint that streams only kavi's tokens (specialist drafts + raw tool events filtered out).
- ~~`Procfile` still points at `web: uvicorn v2.main:app`~~ Fixed — now `web: uvicorn v4_claude.main:app --host 0.0.0.0 --port $PORT`.

## Decisions made while evaluating the plan (no user input needed)
- **Cold-start action endpoints**: cards are always rendered as the result of a prior `/chat` turn (search results, product details), so a thread's state always exists before any action button is clickable. Action endpoints can assume an existing thread and return a graceful error if `aget_state` finds none, rather than bootstrapping a blank thread.
- **Multiple perishable items in one cart**: `kapruka_check_delivery` accepts only one `product_id` for the freshness warning. Use the first perishable item found (`CAKE*`/`FLOWER*`/`COMBO*`) as representative; don't loop over all of them — a minor accuracy trade-off, not worth the extra round trips.

## Sprint 8 — Consolidate UI-action routing into `master_router_node` ✅

Previously the UI-action resume mechanism bypassed `master_router_node` entirely via
`aupdate_state(..., as_node="master_router")` + `ainvoke(None)`, with the destination agent hardcoded
in `actions.py` (`"product_agent"` for every `/cart/*`, `"order_agent"` for `/checkout/submit`). This
split routing logic across `agent.py` and `actions.py` and gave the action endpoints a different
graph-calling convention than `/chat`. Now the deterministic mapping lives inside the router node, and
every entry point calls the graph the same way.

- [x] **`schemas.py`**: `parse_ui_action_type(content)` — inverse of `UiAction.to_event_message`,
  extracts the action type from a `[ui_action:...]` message string (returns `None` for typed
  messages / non-strings, so the router falls through to normal LLM routing). Shares the
  `_UI_ACTION_PREFIX` constant with `to_event_message` so the format lives in one place.
- [x] **`agent.py`**: `_UI_ACTION_AGENT = {"checkout_form_submit": "order_agent"}` (default
  `product_agent`); `master_router_node` short-circuits at the top — if the latest message parses as a
  ui_action, it returns the mapped `selected_agent` **without** building the prompt or calling
  `router_model`. `language` is intentionally not written (a click carries none), so it carries
  forward unchanged.
- [x] **`actions.py`**: `_resume_via_master_router` → renamed `_run_ui_action_turn`, drops the
  `selected_agent` param, and replaces `aupdate_state(as_node=...) + ainvoke(None)` with a single
  `graph.ainvoke(patch, config)` — the same call `/chat` uses. Both call sites
  (`_resume_cart_action`, `checkout_submit`) updated; the file header comment now documents the new
  flow instead of the old `as_node` rationale.
- [x] **`test_actions.py`** (new, 10 tests): `parse_ui_action_type` (valid types, json payload,
  non-ui_action → `None`, `None`/list input, malformed-but-prefixed) + round-trip with
  `UiAction.to_event_message` over every `UiActionType`, incl. a `"]"`-in-payload case. All 55 tests
  across the suite pass (45 prior + 10 new), no regressions.
- [x] **Live verification** (throwaway, real Gemini + InMemory saver/store + fake MCP stubs, deleted
  after): with a router-call spy — `add_to_cart` → `product_agent` with **0 router LLM calls**;
  `checkout_form_submit` → `order_agent` with **0 router calls**; a prior-turn `language="Sinhala"`
  survived a subsequent UI-action turn; and a normal typed turn still called the router exactly once
  (normal routing intact). `[master_router] enter | trigger=ui_action` now also logs for free via the
  existing `log_node` decorator.

**No frontend changes** — endpoints, request bodies, and response shape are all unchanged. **Cohesion
refactor, not a latency fix** (no LLM call for UI actions before or after). Does **not** fix the
separate Sprint 5 known issue (typed cart-adds sometimes routing to `order_agent`) — that's the LLM
branch's prompt wording, untouched here. *(Now fixed in Sprint 9.)*

## Sprint 9 — Typed cart-add routing fix + deploy config ✅

Closes the two items flagged at the end of the UI-action review: the Sprint 5 typed-cart-add routing
ambiguity and the stale `Procfile`.

- [x] **`agent.py` — `master_router_node` prompt**: the router only governs the LLM (typed) branch;
  the Sprint 8 short-circuit already pins *button/form* actions. A typed "add that to my cart" could
  still drift to `order_agent` because `add_to_cart` is bound on both specialists and nothing told the
  router that cart mutations are `product_agent`-only. Fixed with two prompt additions: (a) a "Do NOT
  use for adding/removing/changing cart items" boundary on the `order_agent` description, and (b) a hard
  rule that **any** add/remove/qty-change goes to `product_agent` regardless of context (even mid-checkout,
  even when phrased as "buy"/"order this"), since `product_agent` is the only agent that reacts to a cart
  change with a complementary suggestion. `order_agent` takes over only once the customer moves to delivery
  details / placing the order. Prompt-only change — no graph/tool/binding changes.
- [x] **`Procfile`**: confirmed pointing at `web: uvicorn v4_claude.main:app --host 0.0.0.0 --port $PORT`
  (was `v2.main:app`) — deploy now targets the v4_claude app.
- [x] All 55 unit tests pass; `agent.py` parses cleanly. The routing nudge is a prompt change, so its
  real-world effect is best confirmed with a live-Gemini run of a typed "add that to my cart" with a
  checkout-leaning prior turn (not covered by the stdlib unit tests, which deliberately avoid model
  instantiation).

## Sprint 10 — Hard-gate cart adds behind `kapruka_get_product`, richer detail payload, "offer more info" after search

Today `add_to_cart` can be called straight off `kapruka_search_products` results, with the LLM
supplying `name`/`unit_price`/`image_url`/`currency`/`in_stock` from memory. Fragile in general, and
flatly broken for products with size/flavor/weight **variants** — search results never include
`variants` (only `kapruka_get_product` does, per `mcp_info.md`'s schema: each variant has its own
`id`/`price`/`in_stock`/`attributes`) — so "add a medium pizza" has no way to resolve a price or stock
level today. This sprint hard-gates cart adds behind a `get_product` call (code-level, same philosophy
as `place_order`'s `is_ready_for_order` gate — not just a prompt instruction), gives `get_product` its
own richer card distinct from the flat search/carousel `ProductCard`, and tightens the product agent's
prompt to keep recommending after search while explicitly inviting the customer to ask for more
details. **Decision**: variant selection ("medium" → the right variant's `id`) is left to the LLM
reading the `variants` list it just fetched and passing that variant's own `id` as `product_id` — no
deterministic fuzzy-matching backstop (kept in scope tight; revisit only if live testing shows the LLM
mis-copying variant ids).

- [x] **`agent.py` — `ShoppingState`**: new `viewed_products: dict[str, dict]` field, a per-thread
  cache of `kapruka_get_product` results keyed by the response's own `data["id"]` (never the raw
  `product_id` argument — they can differ if the LLM mistakenly fetches a variant id). New reducer
  `_merge_viewed_products(left, right) -> {**(left or {}), **(right or {})}` — a **shallow union**, not
  a deep merge like `_merge_checkout_writes`: a re-fetch of the same id (e.g. in a new currency) must
  replace that key's whole record, never blend old+new fields.
- [x] **`tools.py` — `wrap_get_product_tool`**: convert `kapruka_get_product` from a plain
  `str`-returning `@tool` to an async `Command`-returning tool (same pattern as
  `check_delivery_for_city`/`place_order` in this file) with `tool_call_id: Annotated[str,
  InjectedToolCallId]`. Still returns the identical raw JSON text as the `ToolMessage` content (so
  `cards.py`'s name-based dispatch is undisturbed) but additionally writes `{"viewed_products":
  {data["id"]: data}}` into the Command update when the parsed response has an `"id"`. The
  MCP-exception fallback path also needs wrapping in `Command(update={"messages": [...]})` now that the
  function no longer returns a plain string.
- [x] **`cart.py`**: new pure, unit-testable `resolve_catalog_item(viewed_products, product_id) ->
  dict | None` — checks `viewed_products` for a top-level match first (base product), else scans every
  cached detail's `variants` list for a matching `id` and synthesizes `name = f"{parent_name}
  ({variant_name})"` + price/currency/in_stock from the variant + image from the **parent's**
  `images[0]` (variants carry no image of their own), else returns `None`.
- [x] **`tools.py` — `add_to_cart`**: drop `name`/`unit_price`/`currency`/`image_url`/`in_stock` as
  LLM-supplied params entirely — new signature is just `product_id, quantity, icing_text=None` plus
  injected `tool_call_id`, `cart`, and `viewed_products: Annotated[dict, InjectedState("viewed_products")]
  = {}`. **The `= {}` default is required, not stylistic** — `ToolNode`'s state injection raises
  `KeyError` for an injected param with no default if that key isn't yet present in state, which is
  exactly the case on a fresh thread's very first tool call. Calls `cart_ops.resolve_catalog_item(...)`;
  if `None`, returns a `Command`/`ToolMessage` saying details aren't loaded yet (no cart write) instead
  of guessing — a hard gate in the same category as `place_order`'s rejection, just expressed as a
  retryable tool message.
- [x] **`schemas.py`**: new `ProductVariant` (`id, name, sku, price, currency, in_stock, stock_level,
  attributes: dict`) and `ProductDetailCard` (`type="product_detail"`, full `images: list[str]`,
  `variants: list[ProductVariant]`, `category`, `attributes`, `shipping`, plus the existing
  `ProductCard` fields) models. Add `ProductDetailCard` to the `Card` union.
- [x] **`cards.py`**: replace `_product_card_from_detail` with `_product_detail_card(detail) ->
  ProductDetailCard` reading the full shape (all of `images`, not just `images[0]`; `variants`;
  `category`; `attributes`; `shipping`). Update `extract_cards_from_messages`'s `kapruka_get_product`
  dispatch branch to emit this instead of the flat `ProductCard` search results use. Extend
  `summarize_cards_for_prompt` with a `"product_detail"` branch (name, price, stock, variant count).
- [x] **`agent.py` — `kavi_agent`**: broaden `has_fresh_product_cards` (currently `c.get("type") ==
  "product"`) to also match `"product_detail"`, so a detail view also suppresses the premature
  "proceed_to_checkout" nudge in `cart_ops.compute_suggested_next_step`. Add a short conditional hint to
  the system prompt inviting further exploration when fresh cards were shown — phrased differently for
  a multi-result search/cross-sell ("ask for more details on anything that catches your eye") vs. a
  single detail view ("pick a size/option if there are any, or just say the word to add it").
- [x] **`agent.py` — `product_agent_node` prompt**: replace the "Cart tools" bullet block with: (a)
  never call `add_to_cart` straight from search results — always call `kapruka_get_product` for that
  exact `product_id` first, even when the customer jumps straight to "add it"; (b) when `get_product`
  returns a non-empty `variants` list, match the customer's wording ("medium", "1kg") against
  `variants[].name`/`attributes` and pass *that variant's own `id`* as `product_id` to `add_to_cart` —
  if ambiguous (2+ variants, no clear match), list the options and ask before adding; (c) if
  `add_to_cart` replies that details aren't loaded yet, immediately call `get_product` and retry, no
  need to ask the customer first; (d) it's fine to re-call `get_product` for something possibly already
  fetched earlier in a long conversation — a redundant call beats guessing at forgotten details; (e)
  after presenting search results, explicitly invite the customer to ask for more details on anything
  that interests them, alongside the existing recommendation behavior.
- [x] **Explicitly out of scope (confirm, don't change)**: `actions.py`'s UI-button `/cart/add`
  endpoint keeps calling `cart_ops.add_item` directly with frontend-supplied fields — it never went
  through the LLM `add_to_cart` tool and isn't touched by this gate (the frontend is expected to have
  full/variant data from a rendered `ProductDetailCard` already). `checkout.py:
  build_create_order_payload` is unchanged — `kapruka_create_order` only ever accepts
  `product_id`/`quantity`/`icing_text` per line, so a selected variant's `id` already flows through as
  the cart line's `product_id` with no extra field needed.
- [x] **`test_cart.py`**: add tests for `resolve_catalog_item` — top-level product hit, variant hit
  (synthesized name/price), no-match → `None`, and a same-id-refetched-with-different-currency case
  proving the `viewed_products` reducer is last-write-wins per key, not a deep merge.
- [x] **Verification**: run the full stdlib suite from the master folder; then drive `/chat` live
  against a product family with real variants — search → recommend + "want more details?" (flat
  `ProductCard`s) → ask for details on one → `ProductDetailCard` with `images[]`/`variants`/`category`/
  `attributes`/`shipping` populated → say "add a [variant] to my cart" directly (no prior detail
  request) → confirm `get_product` fires silently before `add_to_cart`, and the cart line carries the
  *variant's* price/name, not the base product's → same product with 2+ variants and no variant
  specified → confirm the agent asks instead of guessing → a brand-new thread's first-ever message
  being a direct "add X to cart" → confirm no crash (exercises the `viewed_products` default-`{}` fix).

## Sprint 11 — Cut wasted specialist-agent LLM work (skip drafts that are always discarded) ✅

Sprint 6 measured 3-4 sequential Gemini calls per turn and flagged "the post-tool react call is
discarded since kavi re-synthesizes" as the #1 unapplied optimization. Live session logs confirmed
it concretely: every specialist turn writes a fully-styled, customer-voiced draft (numbered lists,
bold prices, emojis, "would you like...", upsell nudges) that `kavi_agent` explicitly discards and
rewrites from scratch ("Treat the specialist's text as private notes... not as something already
shown to the user" — `agent.py`'s `kavi_agent` prompt). Worst case measured: a single
`ui_action:add_to_cart` turn spent 3617ms in `product_agent` writing a full
cart-summary-and-upsell reply, then 7164ms in `kavi_agent` rewriting essentially the same message
— ~10.8s for one button click, with zero tool calls involved in either step.

- [x] **Skip `product_agent` entirely for `remove_from_cart` / `update_qty` / `clear_cart`
  UI-action clicks.** `actions.py: _resume_cart_action` already mutates the cart in plain Python
  (`cart_ops.remove_item`/`set_quantity`/`clear`) and injects the new `cart` into
  `graph.ainvoke`'s state patch *before* the graph runs — `product_agent` never performs this
  mutation, it only narrates it afterward, and its own prompt explicitly forbade calling any tool
  to "redo" it. `cards.py: extract_cards_from_messages` builds the `cart_summary` card straight
  from `state["cart"]`, not from any specialist message, so `kavi_agent` loses nothing by running
  first. Fix: extended `agent.py`'s `_UI_ACTION_AGENT` dict with `"remove_from_cart"`,
  `"update_qty"`, `"clear_cart"` all mapped to `"kavi_agent"` — `route_after_master_router` already
  had an explicit `selected_agent == "kavi_agent"` branch, so no graph/edge changes were needed,
  just the dict.
  - **Follow-up gap closed**: with no specialist running first, `kavi_agent` now sees the raw
    `[ui_action:remove_from_cart/update_qty/clear_cart]` event itself as the latest message — it
    previously only ever saw these after a specialist had already translated them into natural
    language. Added a deterministic `cart_action_block` to `kavi_agent`'s prompt (same pattern as
    `product_hint_block`/`personalization_block`, gated on `parse_ui_action_type` of the latest
    message) instructing it to never surface "ui_action"/JSON/field names, name the specific item
    directly the way a specialist draft used to, and rephrase rather than quote a raw `CartError`
    message on `status: "error"`.
  - **Name parity with the old `product_agent` draft**: `RemoveFromCartRequest`/
    `UpdateCartQuantityRequest` only ever carried `product_id` (unlike `AddToCartRequest`, which
    carries `name`), so without a specialist resolving it from chat history, `kavi_agent` would
    have fallen back to a vague "that item." Fixed at the source, no frontend change needed:
    `actions.py: _resume_cart_action` now looks up the item's `name` from the **pre-mutation**
    cart (already fetched via `aget_state` for the mutation itself) and injects it into
    `event_payload` before the event message is built, so `kavi_agent` gets the same
    human-readable name `product_agent` used to supply.
  - **`add_to_cart` deliberately excluded**: `product_agent_node` runs deterministic cross-sell
    logic on this trigger (`find_complementary_suggestion`) that can fire a *real*
    `kapruka_search_products` tool call `kavi_agent` has no ability to make (no search tools).
    Left routed through `product_agent` as before. *(Possible future sprint: hoist that
    deterministic check up to the router so `add_to_cart` only goes through `product_agent`
    when a cross-sell opportunity actually exists.)*
  - **`view_details` deliberately excluded**: no pre-mutation happens (`actions.py` passes an
    empty `state_patch`) — `product_agent` must actually call `kapruka_get_product` to fetch real
    data. Real work, not a discarded draft.
- [x] **Trimmed `product_agent`'s system prompt** (`agent.py`) so its final (no-more-tool-calls)
  turn writes a short factual status note instead of full customer-voiced prose: dropped the
  "explicitly invite the customer to ask for more details" line (duplicated by `kavi_agent`'s own
  deterministic `product_hint_block`), narrowed the `[ui_action:...]` cart-tools bullet to
  `add_to_cart` only (remove/update/clear no longer reach this node) and dropped its
  upsell-phrasing instruction (duplicated by `kavi_agent`'s `suggested_next_step` + "always try to
  upsell" instruction), dropped the standalone "proactively guide them toward checkout" line (same
  redundancy), trimmed `cross_sell_instruction`'s customer-phrasing tail while keeping the real
  tool-call instruction intact, and added one blanket "your draft is internal-only, be terse"
  instruction.
  - **`history_hint` block deliberately left untouched** — unlike the others, it can plausibly
    steer *which* complementary item gets searched for/recommended based on purchase history, not
    just phrasing; trimming it risked losing the personalization feature itself, not just shaving
    wasted prose.
- [x] **Light, matching trim on `order_agent`'s prompt** for consistency: added the same
  "internal-only, terse" framing instruction; dropped the tone word "conversationally" from the
  missing-fields bullet while keeping its substance (ask a few fields at a time, not a giant
  checklist).
- [x] **`support_agent` left unchanged** — already minimal/factual, no emoji/upsell/invitation
  instructions to trim.
- [x] **Verification**: full stdlib suite (64 tests across `test_actions`/`test_cart`/
  `test_checkout`/`test_personalization`) passes with no regressions — expected, since
  `cart.py`/`checkout.py`/`schemas.py` are untouched by this sprint; `agent.py` parses cleanly.
  Live `/chat` + UI-action verification (search → view details → add to cart → remove → update
  qty → clear cart, confirming cross-sell search still fires on add and `kavi_agent`'s replies/cards
  are unaffected) is a manual follow-up per `tests/CLAUDE.md` (this codebase deliberately keeps
  LLM-routing behavior out of the model-free stdlib suite).

## Sprint 12 — Stop `product_agent` from calling `get_product` with an unverified product_id ✅

Live log review caught `product_agent` calling `kapruka_get_product(product_id='FRUITS00162')`
as its **first** action on a customer message ("hi mata seeni kilo 1k dennna" — give me 1kg of
seeni banana), with no `kapruka_search_products` call anywhere in the turn. The id happened to
be correct (resolved to "Banana Seeni- Sri Lankan Fruits"), and the downstream `add_to_cart`
hard gate (Sprint 10) still correctly forced real variant resolution before any cart write — so
nothing wrong ended up in the cart this time. But the prompt's own "SEARCH FIRST, ASK LATER" rule
(unchanged since before Sprint 11) requires a search before any other action, and that step was
skipped. Confirmed `FRUITS00162` isn't hardcoded anywhere in the prompts/codebase (grepped, no
matches) — the most likely explanation is the underlying Gemini model recalling/guessing the id
from its own pretraining knowledge of Kapruka's public catalog rather than grounding it in an
actual tool result, a known LLM failure mode (trusting internal "knowledge" over the prescribed
tool workflow). Risk: a wrong guess for a different product could fetch/show the wrong item.

- [x] **Prompt-only fix** (`agent.py`, `product_agent_node`'s system prompt, right after the
  "SEARCH FIRST, ASK LATER" bullet): added an explicit, emphatic rule forbidding
  `kapruka_get_product` (or any other product tool) from being called with a product_id that
  hasn't actually appeared in this conversation — i.e. one returned by a
  `kapruka_search_products` result, a `kapruka_get_product` result already fetched earlier in
  this thread, or a `[ui_action:...]` event's payload. Explicitly tells the model: even if it
  recognizes the product and feels confident it knows the id, it does not have it from *this*
  conversation yet — call search first and use whatever id that actually returns.
  - **Why this doesn't break `view_details`/`add_to_cart` ui_action flows**: their product_id
    comes from the event payload, explicitly listed as an allowed source — those bullets below
    this rule are untouched.
  - **Scope decision**: prompt-only, not a hard code-level gate (the stronger alternative
    discussed — wrapping `kapruka_get_product` to refuse an unverified id — was deliberately not
    taken, to keep risk/effort proportionate to a single observed incident; revisit with a real
    gate if this recurs).
- [x] **Verification**: full stdlib suite (64 tests) passes, `agent.py` parses cleanly — no
  pure-logic module touched. Live re-test (fresh thread, name a specific well-known product,
  confirm `kapruka_search_products` now precedes any `kapruka_get_product` call for an
  id not already established earlier in the thread) is a manual follow-up, per `tests/CLAUDE.md`.

## Sprint 13 — Fix order tracking card rendering end-to-end

**Observed symptom (live test, 2026-06-25):** User says "I'd like to track my order." Kavi
correctly replies "I have brought up the Order Tracking form for you below." But the card
rendered on the frontend is the *checkout delivery form* ("Please provide delivery details /
Recipient Name / Recipient Phone / …"), not a tracking order-ID input.

**Root causes — two independent bugs:**

1. **Frontend has no renderer for `track_order_form` card type.**
   The backend correctly emits `{"type": "track_order_form", ...}` (via `TrackOrderFormCard`
   in `schemas.py`, appended in `extract_cards_from_messages`). The frontend doesn't handle
   this type, so it silently ignores it and renders the `checkout_form` card that also happens
   to be in the same cards array (the user had a cart + prior checkout state → the checkout
   form always co-renders when `checkout is not None and cart`). Fix: add a
   `track_order_form` card component to the frontend that renders a single order-ID text field
   + "Track" submit button, wiring the button to the existing `track_order_submit` UI-action
   endpoint.

2. **`show_tracking_form` flag is sticky — persists in LangGraph state across turns.**
   `fast_support_agent` sets `show_tracking_form: True` when no order ID is provided. No
   other agent ever resets it to `False`, so every subsequent turn keeps re-appending the
   tracking form card to the response (even after the user moves on to buying something).
   Fix: add `"show_tracking_form": False` to `kavi_agent`'s return dict — since kavi runs
   at the end of every turn, it resets the flag after the form has been shown once.

**Tasks:**
- [x] **Backend: reset `show_tracking_form` in `kavi_agent`** (`agent.py`). Added
  `"show_tracking_form": False` to `kavi_agent`'s return dict.
- [x] **Backend: add `POST /support/track` endpoint** (`actions.py`). Injects
  `extracted_order_id` into state before graph invocation so `fast_support_agent` picks it
  up without needing to parse the event message. Also fixed the broken payload parser in
  `fast_support_agent` (`content.split("payload=")` → `content.split("] ", 1)`) and added
  `"extracted_order_id": None` to every return branch to prevent stale IDs persisting.
- [ ] **Frontend: implement `track_order_form` card component.** Renders a compact form:
  single "Order Number" text input + "Track Order" button. On submit, fires
  `POST /support/track` with `{user_id, thread_id, order_id}`. Styling should match the
  checkout form card's look, just simpler (one field).
- [ ] **Frontend: suppress the checkout form card when a `track_order_form` card is present.**
  If the cards array contains `track_order_form`, do not render any co-present `checkout_form`
  — the two forms on the same screen are confusing. Simple filter on the frontend before
  rendering the card list: if `cards.some(c => c.type === "track_order_form")`, drop all
  `checkout_form` entries from that render pass.
- [ ] **Verification**: tracking flow — new thread, "I'd like to track my order" → tracking
  form renders (not checkout form); enter a valid order ID via form → `POST /support/track`
  fires → `OrderTrackingCard` renders with status/progress. Confirm on subsequent typed turn
  (e.g. "show me cakes") the tracking form no longer reappears.

## Sprint 14 — Order agent → Deterministic Smart Interceptor ✅

Refactored `order_agent_node` from an autonomous LLM tool-caller to a "Smart Interceptor":
the LLM is demoted to a NER/intent tagger (no tool binding, cheapest model), and Python
dispatches all state mutations and API calls deterministically. UI button actions bypass
the LLM entirely (zero latency). Chat messages go through a single mini LLM call that
outputs a structured action tag, then Python executes it.

**What changed:**
- `tools.py`: Added `check_delivery_core` and `place_order_core` standalone async functions
  (same logic as the old `check_delivery_for_city`/`place_order` tools, minus the LangChain
  `@tool` wrapper). These are called directly from the node interceptor.
- `agent.py` — `create_order_agent_node`: Removed `bind_tools`. Added unified interceptor:
  UI actions (`checkout_form_submit`, `place_order`) are handled with zero LLM calls;
  conversational text goes through a mini tagger LLM that emits `[action:...]` tags; Python
  dispatches all tags to the same core functions. Added `_flat_to_checkout_patch` helper.
- `agent.py` — `order_model_base`: Downgraded to `gemini-2.5-flash-lite` (NER-only role,
  no tool schemas needed).
- `agent.py` — `_UI_ACTION_AGENT`: Added `"place_order": "order_agent"`.
- `agent.py` — `ShoppingState`: Added `last_order_data: dict | None` field for passing
  order success data to `extract_cards_from_messages` without using ToolMessages.
- `agent.py` — `kavi_agent`: Passes `last_order_data` to `extract_cards_from_messages`;
  resets `last_order_data: None` each turn (same pattern as `show_tracking_form`).
- `agent.py` — `build_shopping_graph`: Removed `make_checkout_tools`/`order_tools`
  ToolNode and `order_should_continue` conditional edge; added direct `order_agent →
  kavi_agent` edge; updated `create_order_agent_node` call to pass raw MCP tools + store.
- `schemas.py`: Added `"place_order"` to `UiActionType`.
- `actions.py`: Added `PlaceOrderRequest` + `POST /checkout/place_order` endpoint.
- `cards.py`: Added `last_order_data` param to `extract_cards_from_messages`; builds
  `CheckoutConfirmationCard` from it when present (Smart Interceptor path).

**Wins:**
- ~7 tool schemas removed from order_model context → ~500–1,000 tokens saved per turn
- UI form submits and "Place Order" button → zero LLM latency
- Conversational updates → 1 mini LLM call (was 2+: LLM generates tool call + ToolNode
  executes + LLM sees result)
- No tool loop in graph for order_agent (direct edge to kavi_agent)
- `delivery_confirmed` city-change re-check invariant preserved
- Date change → delivery_confirmed reset preserved

**Explicitly not changed:**
- `checkout.py`, `cart.py` — pure logic, untouched
- `fast_ui_agent`, `kavi_agent` behavior — untouched (kavi still synthesizes)
- Cart mid-checkout conversational path — routes through `[action:none]` → kavi guides
  (rare edge case; user can use cart buttons for removes/updates)

- [x] `tools.py`: `check_delivery_core`, `place_order_core` standalone functions
- [x] `agent.py`: Smart Interceptor node, model downgrade, graph cleanup
- [x] `schemas.py`: `"place_order"` in `UiActionType`
- [x] `actions.py`: `POST /checkout/place_order` endpoint
- [x] `cards.py`: `last_order_data` card extraction
- [x] All 64 unit tests pass with no regressions
- [ ] Live verification: conversational field update → kavi confirms; city check → delivery
  confirmed/unavailable; UI form submit → zero LLM; "Place Order" button → order created,
  cart cleared, `CheckoutConfirmationCard` rendered

## Sprint 15 — Kavi's Picks sidebar carousel

Always-visible sidebar carousel of bestseller product cards. Fetched from a dedicated
REST endpoint outside the chat graph; clicking a card injects a natural human message
into the thread and triggers `kapruka_get_product` in `product_agent`.

**Backend** (`picks.py` + `main.py` + `agent.py`):
- `GET /products/picks` — calls `kapruka_search_products(sort='bestseller', limit=10)`
  directly on the raw MCP tool from `app.state.mcp_tools`. Returns
  `{"picks": [ProductCard, ...]}` using the same `ProductCard` schema as search results.
  Module-level cache (4-hour TTL) — every user gets the same query so a single MCP call
  serves all page loads until the cache expires. Returns stale/empty on MCP error.
- `POST /products/select` — pick click. Injects a real `HumanMessage("Tell me more about
  {name}.")` into the thread (so it shows in chat history like the user typed it) and sets
  `pending_product_view = product_id`. Buffered response (`shape_chat_response`), per-thread
  lock + `MAX_TURN_SECONDS` timeout + graceful fallback, same as the action endpoints.
- `main.py`: import + `app.include_router(picks.router)`.
- `agent.py`: new `pending_product_view` state field (plain LastValue channel so a None
  write clears it). `master_router` short-circuits to `product_agent` when it's set (no
  router LLM call). `product_agent` reads it → forces `kapruka_get_product` on that exact
  verified id (no search) → resets it to None on return.

**Frontend** (see `frontend_integration_guide.md` §9):
- Fetch `GET /products/picks` on page load; render in sidebar carousel.
- On card click: fire `POST /products/select` with `{user_id, thread_id, product_id, name}`.
  - `thread_id`: use active thread if one exists, otherwise a fresh `crypto.randomUUID()` —
    `graph.ainvoke` creates the LangGraph thread implicitly (no prior state needed).
  - Opens/focuses the chat panel; the "Tell me more about {name}" message + Kavi's reply +
    `ProductDetailCard` all land in the conversation.

- [x] `picks.py`: `GET /products/picks` (4-hour cache) + `POST /products/select`
- [x] `agent.py`: `pending_product_view` field, router short-circuit, product_agent hook
- [x] `main.py`: router registered
- [ ] Frontend: sidebar carousel + click wiring (see frontend guide §9)
- [ ] Live verification: `GET /products/picks` returns 10 cards; click a card on a fresh
  page → "Tell me more about X" appears in chat → `ProductDetailCard` renders; second
  picks request within 4h is instant (cache hit)

## Hotfix — Fix product_agent search hallucination (roses / budget queries) ✅

**Problem**: `product_agent` searched `q='flowers'` when the user asked for roses under a
budget, causing the Kapruka API to return greeting cards and accessories instead of fresh
rose bouquets. The agent then confidently told the user no roses existed under the price
limit. Root causes: (1) the category list in the agent's context anchored the model on
coarse category names; (2) `sort='price_asc'` with `max_price` floods results with the
cheapest unrelated items before the actual product type.

**Fixes (`agent.py`):**
- Removed `Available top-level product categories` block from `product_agent`'s dynamic
  prompt — the category taxonomy was anchoring searches to parent-category names instead
  of the user's specific product term.
- Added specific-terms mandate to the `q` rule: "if they say 'roses', use q='roses' NOT
  q='flowers'" — explicitly forbids collapsing specific terms to broad category names.
- Fixed sort/price rule: when `max_price` is already set, use `sort='relevance'` not
  `sort='price_asc'` — the price cap handles the budget ceiling; price_asc floods the
  first page with cheap unrelated items.
- Converted `kavi_agent` to `create_kavi_agent_node(categories)` factory (same pattern as
  `create_product_agent_node`) so categories are properly in scope for the dynamic prompt.
- Passed categories to kavi_agent's dynamic prompt; added category-answering rules to
  kavi_agent's static prompt — kavi now handles "what categories do you have?" questions.

## Sprint 16 — Fix checkout dead-end loop on delivery-date auto-reschedule ✅

**Problem** (confirmed from production logs, 2026-06-28 Padukka order): a customer gets
permanently stuck at checkout when their requested delivery date is full but the delivery
API offers a *next available date*. The user submits `2026-06-28`; `check_delivery` returns
"slots full, next available `2026-06-29`" — but the 29th was **only ever put into a message
string**, never written into `checkout.delivery.date`, and `delivery_confirmed` stayed
`False`. So every subsequent **Place Order** click was rejected by the gate in
`checkout.py:124` (*"Let's confirm delivery is available for your city and date first."*) —
an infinite loop. Typing "29th is fine" didn't help (the tagger emits `[action:none]`), and
`kavi_agent` kept hallucinating "I've moved it to the 29th, all confirmed!" — masking the
failure since the state never actually changed.

**Root cause**: `check_delivery_core` (live Smart-Interceptor path) and its twin tool
`check_delivery_for_city` surfaced `next_available_date` as text but never adopted it into
checkout state — leaving checkout on an undeliverable date with `delivery_confirmed=False`,
which `place_order`'s gate (`is_ready_for_order`) can never pass.

**Fix (`tools.py`)** — when delivery is unavailable on the requested date but the API offers
a `next_available_date` (≠ requested), adopt it: normalize via `checkout_ops.normalize_date`,
`merge_checkout` it into `delivery.date`, and return delivery as **confirmed** for that date
with a transparent message (*"{old} isn't available for {city} ({reason}), so I've moved your
delivery to {next}."*). With state now matching, the next Place Order click succeeds and
kavi's "moved to {date}" narration becomes true instead of hallucinated.

- [x] `check_delivery_core` (~L766): three-way return — available → confirmed; unavailable
  with next date → adopt + confirmed; unavailable with no next date → not confirmed.
- [x] `check_delivery_for_city` tool (~L591): mirrored the same logic in its `Command`
  updates (`delivery_confirmed=True` on available + rescheduled branches) so the LangChain
  twin stays in sync even though `order_model` is currently unbound (`agent.py:801`).

**Out of scope** (deliberate): tagger affirmative-handling ("29th is fine" → confirm) — made
moot by auto-adopt, the date is set+confirmed before the user even replies. `kavi_agent`
prompt unchanged — its reschedule narration is now backed by real state.

- [x] `agent.py`: all prompt + factory changes above
- [ ] Live verification: Sinhala thread — ask for flowers → narrow to roses under LKR 5000
  → confirm `q='roses'` + `sort='relevance'` + `max_price=5000` → fresh rose bouquets appear

## Hotfix — Strip frontend `_default` variant suffix before `create_order` ✅

**Observed symptom (live session, 2026-06-26):** Full checkout flow succeeded — city
resolved to Homagama, delivery confirmed for 2026-06-27, all fields filled — but
"Place Order" returned `Error (product_not_found)` from the Kapruka API.

**Root cause:** The frontend appends `_default` to a product ID when there are no explicit
variants, so the cart line carries `product_id = "cake00KA001827_default"` instead of the
bare `"cake00KA001827"` that the Kapruka API actually knows. `build_create_order_payload`
in `checkout.py` forwarded that raw value verbatim, and the API rejected it with the
`product_not_found` error code (which `parse_create_order_error` mapped to the friendly
"one of the items in your cart isn't available anymore" message — correct phrasing, wrong
diagnosis entirely).

**Fix (`checkout.py`):**
- Added `_strip_default_variant(product_id: str) -> str` — strips the `_default` suffix
  if present, leaves real variant IDs (e.g. `_1KG`, `_L`) untouched since they don't end
  in `_default`.
- `build_create_order_payload` now calls `_strip_default_variant(item["product_id"])` for
  each cart line before building the MCP payload.

## Mini Sprint — Mid-checkout track-order form + hung tagger kills the turn ✅

**Problem** (production logs, thread `01b7…`, 2026-07-03 15:13–15:46): a checkout flow broke in
two ways. (1) The customer typed `sanduni, 0710723027` (recipient name + phone); `order_agent`'s
Gemini tagger call **hung ~2 min** and the stream died with `TimeoutError` (`chat.py:254`, the
120s `MAX_TURN_SECONDS` budget) — the name/phone were **never written to `checkout`**. (2)
Confused, the user typed "hey what happened"; `master_router` misclassified it as a support
request and routed to `fast_support_agent`, which found no order id and **unconditionally set
`show_tracking_form: True`** → a **track-order form popped up in the middle of checkout**.

**Design constraint**: a *genuine* mid-checkout tracking request must still work — only
low-signal/ambiguous messages get redirected back to checkout, and the in-progress checkout is
never lost (`fast_support_agent` writes no `checkout` key, so `_merge_checkout_writes` preserves
it across a tracking detour).

**Fix #1 — checkout-aware routing (`agent.py` `master_router_node`)**
- [x] Compute a `checkout_in_progress` signal from `selected_agent == "order_agent"` /
  `suggested_next_step` (not `checkout` truthiness — it can be `{}` mid-checkout).
- [x] When in progress, add a prompt rule biasing *ambiguous* messages toward `order_agent`.
- [x] Deterministic override: if the router picks `fast_support_agent` with **no** extracted
  order id, **no** tracking keyword (`_looks_like_tracking`), and a checkout is in progress →
  force `order_agent`. Genuine tracking (order id or keyword like "track"/"where's my order")
  still reaches `fast_support_agent` and its form.

**Fix #2 — per-call tagger timeout (`agent.py`, order tagger ~L953)**
- [x] Added `ORDER_TAGGER_TIMEOUT = 30`; wrapped the tagger `ainvoke` in `asyncio.wait_for`
  (added `import asyncio`). On `TimeoutError`, return `checkout` unchanged with a `[System]`
  note so kavi re-asks the user to resend — turn recovers in-band instead of 120s-timing-out
  and losing state.

**Out of scope** (deferred, #3): tagger over-conservatism — e.g. "colombo 07" → `[action:none]`
so `checkout` never fills. Known reliability gap; separate prompt/testing effort.
- [x] `fast_support_agent` left unchanged **on purpose**: a mid-checkout guard there would
  suppress the form for a legitimate "where's my order?" (no id), which should still show it —
  the router override is the correct single point of control.
- [ ] Live verification (see plan): confused message stays in checkout & shows no track form;
  "track order KAP123" mid-checkout still tracks with checkout preserved; simulated hung tagger
  recovers gracefully within ~30s.

No other files changed — the cart itself keeps the `_default` ID intact (the frontend
relies on it for its own variant UI logic); stripping happens only at the
`create_order` payload-assembly boundary.

- [x] `checkout.py`: `_strip_default_variant` + applied in `build_create_order_payload`

## Bugs identified — flow-state leaks (flows that break other flows) 🐞

Audit (2026-06-28) of "confusing customer flows / too many entry points / workflows
that break other flows." **Finding:** the architecture itself is sound — one graph,
a clean `master_router → specialist → kavi_agent` topology, and UI-action endpoints
that share the same graph/state. The real defects are **state flags that one flow
sets and a different flow fails to clear**, because the latency bypasses
(`fast_ui_agent`, the `order_agent` interceptor) skip the node that normally resets
them. Three confirmed correctness bugs below. (Scope note: the "mid-checkout product
browse hides the checkout form" behavior at `agent.py:1270-1274` was reviewed and is
**intentional** — not a bug. Entry-point redundancy and dead-code cleanup are out of
scope for this batch.)

### Bug 1 — `delivery_confirmed` survives a cart change → order placed on a stale delivery quote

**Problem:** `is_ready_for_order` (`checkout.py:108-127`) gates order placement on
`delivery_confirmed`. That flag is reset on place-order success, on cart *clear*, and
on a checkout *date* change — but **never when cart contents change** (add / remove /
qty). The delivery fee and perishable-freshness check are computed for the cart *as it
was at confirmation time* (`checkout.py:33-40`, `tools.py:734`).

**Repro:** add an item → checkout → confirm delivery for a city/date → add a second
(heavier / perishable) item → "Place Order". The gate still passes, and the order is
placed against a delivery quote / freshness check that no longer matches the cart.

**Root cause:** no cart-write seam resets `delivery_confirmed`. The date-change
invariant was deliberately preserved in Sprint 14 (`TASKS.md` Sprint 14 "wins"), but
the analogous cart-change case was missed.

**Proposed fix:** any change to cart *contents* invalidates a prior delivery
confirmation, so reset `delivery_confirmed=False` at every cart-write seam — mirror
what `clear_cart` already does (`tools.py:198-208`, `actions.py:277-281`).
Unconditional reset is safe: in the normal flow adds precede confirmation, so it's a
no-op there; it only bites post-confirmation, which is exactly when re-verification
should be forced.
- `tools.py`: add `"delivery_confirmed": False` to the `Command(update=...)` of
  `add_to_cart` (`tools.py:134-139`), `remove_from_cart` (`tools.py:155-160`),
  `update_cart_quantity` (`tools.py:182-187`).
- `actions.py`: pass `extra_state_patch={"delivery_confirmed": False}` from `cart_add`
  (`actions.py:227`), `cart_remove` (`actions.py:242`), `cart_update_qty`
  (`actions.py:252`).

- [ ] `tools.py`: reset `delivery_confirmed` in the 3 non-clear cart tools
- [ ] `actions.py`: reset `delivery_confirmed` in the 3 non-clear cart endpoints
- [ ] Verify: confirm delivery → add item (typed + `/cart/add`) → place order is blocked
  until re-confirmed; happy path (no cart change after confirm) still places the order

### Bug 2 — `show_tracking_form` / `last_order_data` leak through the `fast_ui_agent` bypass

**Problem:** `show_tracking_form` and `last_order_data` are reset only inside
`kavi_agent` (`agent.py:1420-1421`). But cart-button actions
(`remove_from_cart` / `update_qty` / `clear_cart`) route to `fast_ui_agent`
(`agent.py:350-352`), which returns at `agent.py:1260` (and the fallback at
`agent.py:1235`) **without** touching these flags and skips `kavi_agent` entirely.

**Repro:** ask "track my order" with no id (tracking form renders, `show_tracking_form
= True`) → click any cart button → the cart-button turn goes through `fast_ui_agent`,
never clears the flag, and `extract_cards_from_messages` re-appends the tracking form.
The form keeps reappearing. (This is a residual of the Sprint 13 sticky-flag fix,
reintroduced by the Sprint 11/14 `fast_ui_agent` bypass that skips kavi.)

**Root cause:** the only reset for these flags lives in `kavi_agent`; the
latency-bypass path doesn't run it.

**Proposed fix:** reset both flags in `fast_ui_agent` so the bypass can't strand them.
Add `"show_tracking_form": False` and `"last_order_data": None` to **both** return
statements in `fast_ui_agent` (`agent.py:1235`, `agent.py:1260`). A cart-button turn
never legitimately needs either flag set.

- [ ] `agent.py`: reset `show_tracking_form` + `last_order_data` in both `fast_ui_agent`
  returns
- [ ] Verify: ask to track (no id) → click a cart button → tracking form does NOT
  reappear and `show_tracking_form` is `False`

### Bug 3 — an empty `checkout={}` permanently kills cross-sell

**Problem:** the cross-sell gate uses
`checkout_not_started = state.get("checkout") is None` (`agent.py:627`). `order_agent`
writes an empty placeholder `checkout={}` in its no-action and missing-fields branches
(`agent.py:1060-1064`, `agent.py:904-905`) — e.g. when the customer merely asks "can
you deliver to Kandy?" and is briefly routed to `order_agent`. After that, `checkout`
is `{}` (non-`None`) forever, so `find_complementary_suggestion` never fires again even
though the customer is still in the browsing phase and has collected no checkout data.

**Repro:** add an item (cross-sell suggestion appears) → ask a delivery question that
routes to `order_agent` (writes `checkout={}`) → add another complementary item → no
cross-sell suggestion ever appears again for the life of the cart.

**Root cause:** the gate distinguishes `None` from `{}`, but an empty `{}` is
semantically still "checkout not started." The adjacent comment
(`agent.py:614-619`) rests on a stale post-Sprint-14 assumption ("order_agent sets
checkout={} the moment a cart exists") that no longer holds — `order_agent` only
initializes `checkout` when it actually runs.

**Proposed fix:** treat an empty dict the same as `None`:
`checkout_not_started = not state.get("checkout")` (`agent.py:627`). A truthy checkout
(real recipient/address fields collected) still stops cross-sell — matching the
intended "confine cross-sell to pre-checkout" design — but an empty placeholder no
longer does. Update the comment at `agent.py:614-619` to describe the real trigger.

- [ ] `agent.py`: change `checkout_not_started` to falsy check; fix stale comment
- [ ] Verify: add item → delivery question (writes `checkout={}`) → add complementary
  item → cross-sell still appears; then provide real checkout details → cross-sell
  correctly stops once `checkout` is non-empty

## Hotfix — Filter brand/partner storefront pages out of product search results ✅ (2026-07-04)

**Problem** (user report + confirmed live): `kapruka_search_products` mixes real products
with brand/partner storefront pages — e.g. searching "jewellery" surfaced a card for
"Jayda Jewellery" itself (a shop, not a purchasable item), consistently priced at a nominal
LKR 140. Same junk appears on kapruka.com's own live site search, so it's an upstream
catalog data-quality issue, not an MCP-layer bug — has to be filtered on our end.

**Findings:**
- The existing `include_stubs: False` (`tools.py:304`) only strips `CATSYM`-prefixed
  category landing pages (per `mcp_info.md:90-91`) — it does **not** catch partner/brand
  storefronts, which carry a normal-looking product `id`.
- Confirmed via WebFetch that these storefront pages live at
  `kapruka.com/partner/<brand-slug>` (e.g. `kapruka.com/partner/soraya-jewelry` renders a
  14-item grid, not a single product).
- User supplied a real raw search-result entry for "Jayda Jewellery" confirming the exact
  shape: `id: "PC00470"` (no `CATSYM` prefix — so id-prefix filtering alone would miss it),
  `url: "https://www.kapruka.com/partner/jayda-jewellery"`, `image_url` pointing to a
  generic placeholder (`cms_temp/brand_creator/logo/kap_parter_default.png`), and
  `price.amount: 140`.
- Price alone is **not** a safe filter: `agent.py:815-819` already documents legitimate
  LKR 140 items (e.g. greeting cards), so filtering on price would drop real products too.
  User explicitly OK'd sacrificing those if needed, but it turned out unnecessary — the
  url/image_url signals are precise with no observed false positives/negatives.

**Fix (`cards.py`):**
- Added `_is_storefront_result(item) -> bool`: true if `url` contains `/partner/`, or
  `image_url` contains the placeholder path `brand_creator/logo/kap_parter_default.png`,
  or `id` starts with `CATSYM` (bundled in as a free defensive backstop for the existing
  `include_stubs=False` guarantee, which previously had no local check at all).
- `extract_cards_from_messages`'s search-result branch now filters `data["results"]`
  through this predicate **before** the `[:MAX_PRODUCT_CARDS_PER_SEARCH]` slice, so a
  storefront entry can't silently consume one of the card slots.

**Fix (`picks.py`):** `_fetch_picks` applies the same `_is_storefront_result` filter
(imported from `cards.py`) before mapping bestseller search results into `ProductCard`s —
the only other call site that turns raw search results into cards.

- [x] `cards.py`: `_is_storefront_result` predicate + filter in
  `extract_cards_from_messages`
- [x] `picks.py`: same filter applied in `_fetch_picks`
- [ ] Live verification: search "jewellery" / "soraya jewellery" → no LKR 140 storefront
  card appears, real jewellery products still do; hit `GET /products/picks` → no
  storefront entries in the bestseller carousel

**Future directions:**
- If a *different* brand/partner URL shape ever surfaces (not `/partner/...`), the
  `image_url` placeholder check is the more durable signal — worth confirming whether
  *all* partner storefronts share that exact placeholder filename, or whether it's
  brand-specific (would need another sample to verify).
- No unit test added for `_is_storefront_result` yet (the codebase's stdlib suite
  currently covers `cart.py`/`checkout.py`/`personalization.py`/`actions.py`, not
  `cards.py`) — worth a small `test_cards.py` if this area gets touched again.
- Consider whether the raw Kapruka catalog issue (partner pages leaking into search)
  is worth reporting upstream, since it also pollutes kapruka.com's own live search —
  out of scope for this app, but the fix here is a workaround, not a root-cause repair.


## Sprint: Search Latency Optimization & JSON Minification

**Problem:**
1. Text-based product searches were incurring a redundant LLM inference cycle (`product_agent`) just to pass search JSON through to `kavi_agent`, causing unnecessary latency.
2. E-commerce API responses (`kapruka_search_products`, `kapruka_get_product`) are bloated with internal IDs, SEO metadata, and image URLs. Feeding this raw JSON into the `product_agent` bloats the context window and increases Time-To-First-Token (TTFT).

**Findings:**
- `cards.py` natively converts the raw JSON from tool responses into frontend UI cards and passes a lightweight summary to `kavi_agent`. `product_agent`'s post-search summary was strictly redundant.
- For JSON minification, `cards.py` still requires the full verbose API response (specifically `image_url` and `url`) to render rich UI elements, meaning we cannot strip these fields globally.

**Fix (`agent.py`):**
- Implemented `route_after_product_tools` to introduce conditional routing. If the just-finished tool is `kapruka_search_products`, the graph jumps straight to `kavi_agent`, saving an LLM inference cycle. For other tools (`get_product`, `add_to_cart`), execution loops back to `product_agent` to allow tool chaining.

**Fix (`tools.py` & `cards.py`):**
- Introduced `_minify_json()` in `tools.py` to strip out all fields except `id`, `name`, `price`, `in_stock`, `stock_level`, and `variants`.
- Leveraged LangChain's `ToolMessage.artifact` feature: `kapruka_search_products` and `kapruka_get_product` now return `Command`s that package the *minified* JSON into `ToolMessage.content` (for the LLM) and the *full* original JSON into `ToolMessage.artifact` (for the UI).
- Updated `extract_cards_from_messages` in `cards.py` to seamlessly read from `msg.artifact` when available, falling back to `msg.content`.

- [x] `agent.py`: Search Short-Circuit routing condition.
- [x] `tools.py`: `_minify_json` helper and updated tool return values.
- [x] `cards.py`: `msg.artifact` prioritization.

## Sprint: Resilient UI Workflows & Search-to-Cart Fallback

**Problem:**
1. The strict rule demanding that `kapruka_get_product` must always be called before `add_to_cart` caused friction if the agent was asked to add an item straight from search results or if the `get_product` API call failed.
2. We needed to ensure that clicking "View Details" from the UI still strictly fired the `get_product` API to render the product modal, but provided a graceful fallback path if that call failed (e.g. catalogue unavailability).

**Fix (`tools.py` & `agent.py`):**
- Updated `wrap_search_tool` in `tools.py` to seamlessly populate the agent's `viewed_products` cache with essential product information directly from search results, enabling `add_to_cart` to operate without demanding `get_product`.
- Relaxed the agent instructions in `agent.py`, informing the agent that while calling `get_product` is still a recommended best practice to fetch complete variants, adding to the cart straight from search results is fully permitted.
- Maintained the strict mathematical requirement in `agent.py` that a `[ui_action:view_details]` event must trigger a `kapruka_get_product` call for frontend rendering.
- Modified the failure message `PRODUCT_UNAVAILABLE_MSG` in `tools.py` and added a fallback instruction in `agent.py`: if `kapruka_get_product` fails, the agent will gracefully apologize for the missing details but explicitly offer to add the product to the user's cart anyway using the cached search results.

- [x] `tools.py`: Populate `viewed_products` via `wrap_search_tool`.
- [x] `agent.py`: Relax `get_product` prerequisite for `add_to_cart` in chat.
- [x] `agent.py` & `tools.py`: Implement chat-driven fallback when `get_product` fails.
