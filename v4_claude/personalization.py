"""Cross-thread personalization — reading a user's prior orders/searches from the Store
and turning them into a compact context block the agents can use on the first turn of a
new thread (a "welcome back", history-biased suggestions, "order the usual").

Same philosophy as cart.py/checkout.py: the pure summarization/reconstruction logic is
separated from the async Store I/O so it's unit-testable without a live Postgres/Store.
"""

from __future__ import annotations

import logging

from langgraph.store.base import BaseStore

logger = logging.getLogger(__name__)

MAX_CONTEXT_SEARCHES = 5


def summarize_user_context(
    latest_order: dict | None, recent_searches: list[str] | None
) -> dict:
    """Compact, prompt-friendly view of a returning customer's history. Pure — takes the
    already-read Store values, returns a small dict. `is_returning` is the single flag the
    callers gate on (no point personalizing for a brand-new customer with no history)."""
    searches = [s for s in (recent_searches or []) if s][:MAX_CONTEXT_SEARCHES]

    last_order = None
    if latest_order:
        items = latest_order.get("cart") or []
        item_names = [i.get("name") for i in items if i.get("name")]
        last_order = {
            "order_ref": latest_order.get("order_ref"),
            "item_names": item_names,
            "created_at": latest_order.get("created_at"),
            "has_cart": bool(items),
        }

    return {
        "is_returning": bool(last_order or searches),
        "recent_searches": searches,
        "last_order": last_order,
    }


def describe_user_context(ctx: dict | None) -> str:
    """Render the context as a short fact list for a system prompt — never raw JSON."""
    if not ctx or not ctx.get("is_returning"):
        return "(new customer — no prior history on record)"

    lines: list[str] = []
    last = ctx.get("last_order")
    if last and last.get("item_names"):
        lines.append(f"- Their last order included: {', '.join(last['item_names'])}")
    if ctx.get("recent_searches"):
        lines.append(f"- They've recently searched for: {', '.join(ctx['recent_searches'])}")
    return "\n".join(lines) if lines else "(returning customer)"


async def load_user_context(store: BaseStore | None, user_id: str | None) -> dict | None:
    """Read (user_id, 'orders')/'latest' and (user_id, 'searches')/'recent' from the
    cross-thread Store and summarize. Returns None for a brand-new customer (nothing to
    personalize with) or on any failure — personalization is best-effort, never fatal."""
    if store is None or not user_id:
        return None
    try:
        order_item = await store.aget((user_id, "orders"), "latest")
        latest_order = order_item.value if order_item else None

        search_item = await store.aget((user_id, "searches"), "recent")
        recent_searches = search_item.value.get("queries") if search_item else None

        ctx = summarize_user_context(latest_order, recent_searches)
        return ctx if ctx["is_returning"] else None
    except Exception:
        logger.warning("Failed to load user context (non-fatal).", exc_info=True)
        return None
