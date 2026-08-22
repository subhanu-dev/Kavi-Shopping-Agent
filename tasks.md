# Filter tool calls/results out of the master_router's view

## Context

The `master_router` node classifies each turn into a sub-agent (`product_agent` /
`order_agent` / `support_agent` / `kavi_agent`) via structured output
(`RouterDecision{next_agent, detected_language}`), using `gemini-2.5-flash-lite`.

Today it is fed the **entire, unfiltered** conversation:

```python
# v4_claude/agent.py:351-356
decision = await router_model.ainvoke(
    [SystemMessage(content=system_prompt), *state["messages"]]
)
```

Because the `messages` channel uses the append-only `add_messages` reducer
(`agent.py:63`) and every specialist writes its `AIMessage(tool_calls=…)` plus every
`ToolMessage` result (search-results JSON, cart confirmations, `place_order` JSON,
delivery checks) back into that **single shared channel**, the router re-ingests all of
that tool noise on every turn. There is currently **no message-filtering helper anywhere
in `v4_claude`**.

This is pure low-signal noise for a router whose only job is to read the *latest human
turn* and pick an agent. It grows token cost/latency unboundedly and creates a real
misrouting risk (e.g. a stale `place_order`/search JSON blob nudging the classifier toward
`order_agent`/`product_agent`). The router is safe to filter because it only runs from
`START` on a fresh turn — the message being classified is always the new
`HumanMessage`/`ui_action`, never a tool result, so stripping tool history can never remove
the actual classification target.

**Decision (confirmed with user):** strip tool content but keep the full conversational
text history (every `HumanMessage` + every assistant text reply). Apply to
**`master_router` only** — specialist agents and `kavi_agent` genuinely need tool
results/cards and keep full history.

## Change

### 1. Add a filtering helper — `v4_claude/agent.py`

Place a small module-level helper near the other message/state helpers (e.g. just above
`master_router_node` at `agent.py:286`):

```python
def _router_visible_messages(messages: list[AnyMessage]) -> list[AnyMessage]:
    """The router only classifies the latest human turn; raw tool calls/results are
    noise (and a misrouting risk). Keep HumanMessages and assistant *text* replies,
    dropping every tool-call AIMessage and every ToolMessage. Both halves of each
    tool round-trip are removed together, so no orphaned ToolMessage (which Gemini
    rejects) is ever left behind."""
    visible: list[AnyMessage] = []
    for m in messages:
        if isinstance(m, ToolMessage):
            continue
        if isinstance(m, AIMessage) and getattr(m, "tool_calls", None):
            continue
        visible.append(m)
    return visible
```

Key correctness point: dropping **both** the tool-call `AIMessage` and its `ToolMessage`
as a unit is what avoids orphan-pairing errors. Keeping AIMessages purely by
"`tool_calls` is falsy" naturally retains `kavi_agent` replies (Anthropic-style list
content, no tool_calls) without needing to inspect content shape.

### 2. Wire it into the router call — `v4_claude/agent.py:351-356`

```python
    decision = await router_model.ainvoke(
        [
            SystemMessage(content=system_prompt),
            *_router_visible_messages(state["messages"]),
        ]
    )
```

No other node changes — `product_agent` (`agent.py:533`), `order_agent` (`agent.py:639`),
`support_agent` (`agent.py:683`), and `kavi_agent` (`agent.py:783`) keep `*state["messages"]`.

### 3. Add the `ToolMessage` import — `v4_claude/agent.py:13`

```python
from langchain_core.messages import AnyMessage, SystemMessage, AIMessage, HumanMessage, ToolMessage
```

(`AIMessage`/`AnyMessage` are already imported; only `ToolMessage` is new.)

## Notes / non-goals

- The `[ui_action:…]` fast path (`agent.py:292-296`) returns before the LLM call and is
  untouched. Historical `ui_action` `HumanMessage`s remain visible to the router — they are
  human-authored and harmless; not worth special-casing now.
- No last-N trimming (the user chose full-conversation text). The `suggested_next_step`
  disambiguation hint already in the prompt continues to handle vague "yes"/"do it" replies.
- This is router-scoped only; it does not touch the separate `place_order` phone-validation
  bug discussed earlier.

## Verification

1. **Unit test** (add to the existing `v4_claude/tests/` suite, following the style of the
   current test modules e.g. `test_actions.py`): construct a `messages` list mixing
   `HumanMessage`, an `AIMessage(tool_calls=[…])`, a `ToolMessage`, and a plain
   `AIMessage(content=…)` text reply; assert `_router_visible_messages(...)` returns only
   the HumanMessage(s) and the text AIMessage(s), and that the result contains **no**
   `ToolMessage` and **no** AIMessage carrying `tool_calls` (i.e. no orphans).
2. **Run the suite:** `python -m pytest v4_claude/tests` (or the project's configured runner)
   — confirm nothing else regresses.
3. **Manual end-to-end:** replay a multi-turn flow like the logs (search cake → add to cart →
   "proceed to checkout" → place order). Watch the `[master_router] output` log lines and
   confirm routing decisions are unchanged/correct on each turn (e.g. cart edits still →
   `product_agent`, "proceed to checkout" → `order_agent`), with the router now blind to the
   intervening tool JSON.
4. **Optional sanity log:** temporarily log `len(state["messages"])` vs
   `len(_router_visible_messages(...))` to confirm tool messages are actually being dropped
   for turns that had tool activity.
