# Findings — Kavi Agent Architecture Walkthrough

Notes captured on request while walking through the codebase. Read-only session — no code
was changed while producing these notes.

## Cart state vs. cart display — no rehydration endpoint exists

- `cart` is a real channel in `ShoppingState` (`agent.py:67`), persisted by the Postgres
  checkpointer keyed by `thread_id`. It is the source of truth and survives across turns/reloads
  on the same thread.
- The frontend never reads that channel directly. It only ever learns the cart via a
  `cart_summary` card, which is rebuilt fresh and sent on every `/chat`, `/chat/stream`, and
  `/cart/*`/`/checkout/*` response (`cards.py: extract_cards_from_messages`, gated on
  `if cart:` — cards.py:193). Every such card is the FULL current cart, not a diff, so the
  frontend should replace its sidebar state wholesale on receipt, not merge.
- **Gap**: there is no `GET` endpoint anywhere (checked `main.py`, `chat.py`, `actions.py`) that
  returns "current cart for this thread" without first running a graph turn. The closest thing,
  `actions.py`'s `_get_existing_state` (`graph.aget_state(config)`), is a private helper used
  inside the UI-action endpoints — not exposed as a callable route.
- **Consequence**: `thread_id` is meant to be reused for an entire conversation (persisted in
  `localStorage`, per `AGENT_OPERATIONS.md:584` — only replaced on an explicit "new chat"). So
  on a normal page reload/reopen with the *same* `thread_id`, the backend's `cart` channel still
  holds whatever was last saved, but the frontend sidebar will render as empty until the first
  `/chat`/`/chat/stream`/UI-action call of that visit completes and a `cart_summary` card finally
  arrives. There's a real window where backend truth (non-empty cart) and frontend display
  (empty) disagree.
  - This is specific to reusing the same `thread_id`. A genuinely *new* `thread_id` (explicit
    "new chat") is not a stale-display bug — cart/checkout state is scoped per `thread_id` by
    design, so a new thread legitimately starts with no cart at all.
- **Implication for a fix (not yet built)**: a persistent sidebar cart that should survive a
  page reload needs a new read-only endpoint that calls `graph.aget_state()` and returns a
  `cart_summary` card (and ideally `checkout`/`suggested_next_step`) on demand, callable on page
  load before any message is sent.
