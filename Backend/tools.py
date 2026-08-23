"""Local (non-MCP) tools and deterministic wrappers around the Kapruka MCP tools.

Cart tools let product_agent/order_agent mutate ShoppingState["cart"] directly during a
normal conversation (typed "add 2 of that cake to my cart"), not only via the UI-action
endpoints — both paths call the same cart.py functions underneath.

The Kapruka tool wrappers force response_format="json" unconditionally (we need to parse
results deterministically for cards/history — never left to the LLM remembering to ask for
json) and, for search, write to the cross-thread Store regardless of what the agent says.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import date, datetime, timezone
from typing import Annotated

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.prebuilt import InjectedState, InjectedStore
from langgraph.store.base import BaseStore
from langgraph.types import Command

from . import cart as cart_ops
from . import checkout as checkout_ops
from .cart import CartError
from .schemas import CartItem, CheckoutData

logger = logging.getLogger(__name__)

MAX_RECENT_SEARCHES = 20

# User-facing fallbacks when a Kapruka MCP call fails outright (server down, timeout,
# malformed response). The customer must never see a raw exception or stack trace — these
# read as something Kavi would actually say.
SEARCH_UNAVAILABLE_MSG = (
    "Aiyo, I'm having a little trouble reaching our product catalogue right now. 😅 "
    "Could you try that search again in a moment?"
)
PRODUCT_UNAVAILABLE_MSG = (
    "I couldn't pull up that product's full details just now (catalogue unavailable). "
    "If you already have basic information about this product from search results, "
    "you may offer to add it to their cart anyway."
)
TRACKING_UNAVAILABLE_MSG = (
    "I couldn't reach our order-tracking system just now. Please try again in a little "
    "while, and I'll check on it for you."
)
DELIVERY_CHECK_UNAVAILABLE_MSG = (
    "I couldn't reach our delivery system to check that just now — could you try again "
    "in a moment?"
)
PLACE_ORDER_UNAVAILABLE_MSG = (
    "Something hiccupped while placing your order and it did NOT go through — nothing has "
    "been charged. Could you try once more in a moment?"
)


def _safe_json(text) -> dict | None:
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


async def _timed_ainvoke(tool, payload: dict, label: str):
    """Invoke an MCP tool and log its latency under the greppable [timing] prefix.

    Uses try/finally so the timing is recorded even when the call fails (the caller's
    own try/except still sees the re-raised exception and returns its friendly message).
    This is what makes the Kapruka network round-trips visible in the logs — previously
    the only timing was per-node (which excludes the ToolNode/MCP time)."""
    start = time.monotonic()
    try:
        return await tool.ainvoke(payload)
    finally:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.info(f"[timing] mcp={label} ms={elapsed_ms:.0f}")


# =========================
# Local cart tools (Command-based state updates)
# =========================


def make_cart_tools() -> list[BaseTool]:
    """The 4 local cart-mutation tools — bound into both product_tools and order_tools."""

    @tool
    def add_to_cart(
        product_id: str,
        quantity: int,
        tool_call_id: Annotated[str, InjectedToolCallId],
        cart: Annotated[list[CartItem], InjectedState("cart")],
        viewed_products: Annotated[dict, InjectedState("viewed_products")] = {},
        icing_text: str | None = None,
    ) -> Command:
        """Add a product to the customer's cart. You must use the exact product_id from the most recent kapruka_get_product result."""
        detail = viewed_products.get(product_id)
        if detail:
            variants = detail.get("variants") or []
            # Only a genuine multi-option product needs the customer to choose. A single
            # "default" variant (most Kapruka products) must NOT trigger a size question —
            # resolve straight to that variant's own id and add it silently.
            if len(variants) > 1:
                return Command(
                    update={
                        "messages": [
                            ToolMessage(
                                content="This product has variants (e.g. sizes). Please ask the customer which one they want, and then call add_to_cart using the specific variant's 'id'.",
                                tool_call_id=tool_call_id,
                            )
                        ]
                    }
                )
            if len(variants) == 1:
                product_id = variants[0].get("id") or product_id

        resolved = cart_ops.resolve_catalog_item(viewed_products, product_id)
        if resolved is None:
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content="Details for this product aren't loaded yet. Please call kapruka_get_product first to load its exact price and stock.",
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )

        try:
            new_cart = cart_ops.add_item(
                cart or [],
                product_id=resolved["id"],
                name=resolved["name"],
                quantity=quantity,
                unit_price=resolved["price"].get("amount"),
                currency=resolved["price"].get("currency", "LKR"),
                image_url=resolved["images"][0] if resolved["images"] else None,
                icing_text=icing_text,
                in_stock=resolved["in_stock"],
            )
            message = f"Added {quantity} x {resolved['name']} to the cart."
        except CartError as exc:
            new_cart = cart or []
            message = str(exc)

        return Command(
            update={
                "cart": new_cart,
                "messages": [ToolMessage(content=message, tool_call_id=tool_call_id)],
            }
        )

    @tool
    def remove_from_cart(
        product_id: str,
        tool_call_id: Annotated[str, InjectedToolCallId],
        cart: Annotated[list[CartItem], InjectedState("cart")],
    ) -> Command:
        """Remove a product from the customer's cart by product_id."""
        try:
            new_cart = cart_ops.remove_item(cart or [], product_id)
            message = "Removed that item from the cart."
        except CartError as exc:
            new_cart = cart or []
            message = str(exc)

        return Command(
            update={
                "cart": new_cart,
                "messages": [ToolMessage(content=message, tool_call_id=tool_call_id)],
            }
        )

    @tool
    def update_cart_quantity(
        product_id: str,
        quantity: int,
        tool_call_id: Annotated[str, InjectedToolCallId],
        cart: Annotated[list[CartItem], InjectedState("cart")],
    ) -> Command:
        """Change the quantity of an item already in the cart. Setting quantity to 0
        removes it."""
        try:
            new_cart = cart_ops.set_quantity(cart or [], product_id, quantity)
            message = (
                f"Updated quantity to {quantity}."
                if quantity > 0
                else "Removed that item from the cart."
            )
        except CartError as exc:
            new_cart = cart or []
            message = str(exc)

        return Command(
            update={
                "cart": new_cart,
                "messages": [ToolMessage(content=message, tool_call_id=tool_call_id)],
            }
        )

    @tool
    def clear_cart(
        tool_call_id: Annotated[str, InjectedToolCallId],
        cart: Annotated[list[CartItem], InjectedState("cart")],
    ) -> Command:
        """Empty the customer's cart completely."""
        # Clearing the cart also ends any in-progress checkout — there's nothing left to
        # check out, so checkout/delivery_confirmed must reset too (None resets checkout via
        # reduce_checkout), otherwise the delivery form would linger over an empty cart.
        return Command(
            update={
                "cart": [],
                "checkout": None,
                "delivery_confirmed": False,
                "cross_sold_categories": [],
                "messages": [
                    ToolMessage(content="Cart cleared.", tool_call_id=tool_call_id)
                ],
            }
        )

    return [add_to_cart, remove_from_cart, update_cart_quantity, clear_cart]


# =========================
# Deterministic wrappers around Kapruka MCP tools
# =========================


def _minify_json(data: dict) -> str:
    """Strip out verbose SEO/UI fields so the LLM context window isn't bloated.
    Leaves only id, name, price, in_stock, stock_level, variants."""
    if not data:
        return "{}"

    minified = {}

    # Handle search results array
    if "results" in data and isinstance(data["results"], list):
        minified_results = []
        for item in data["results"]:
            mini_item = {
                "id": item.get("id"),
                "name": item.get("name"),
                "price": item.get("price"),
                "in_stock": item.get("in_stock"),
                "stock_level": item.get("stock_level"),
            }
            # drop none values to save more space
            minified_results.append(
                {k: v for k, v in mini_item.items() if v is not None}
            )
        minified["results"] = minified_results
        if "next_cursor" in data:
            minified["next_cursor"] = data["next_cursor"]

    # Handle single product (get_product)
    elif "id" in data:
        mini_item = {
            "id": data.get("id"),
            "name": data.get("name"),
            "price": data.get("price"),
            "in_stock": data.get("in_stock"),
            "stock_level": data.get("stock_level"),
        }

        if "variants" in data and isinstance(data["variants"], list):
            mini_variants = []
            for v in data["variants"]:
                mini_v = {
                    "id": v.get("id"),
                    "name": v.get("name"),
                    "price": v.get("price"),
                    "in_stock": v.get("in_stock"),
                    "stock_level": v.get("stock_level"),
                    "attributes": v.get("attributes"),
                }
                mini_variants.append({k: v for k, v in mini_v.items() if v is not None})
            mini_item["variants"] = mini_variants

        minified = {k: v for k, v in mini_item.items() if v is not None}
    else:
        # Fallback if unknown structure
        minified = data

    return json.dumps(minified)


def _extract_text(raw) -> str:
    """MCP tool results come back as a list of content blocks: [{"type": "text", "text": "..."}]."""
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "text" in raw[0]:
        return raw[0]["text"]
    if isinstance(raw, str):
        return raw
    return str(raw)


async def _record_search(store: BaseStore, user_id: str, query: str) -> None:
    try:
        namespace = (user_id, "searches")
        existing = await store.aget(namespace, "recent")
        queries = list(existing.value.get("queries", [])) if existing else []
        if query in queries:
            queries.remove(query)
        queries.insert(0, query)
        queries = queries[:MAX_RECENT_SEARCHES]
        await store.aput(namespace, "recent", {"queries": queries})
    except Exception:
        logger.warning("Failed to record search history (non-fatal).", exc_info=True)


async def _record_order(
    store: BaseStore, user_id: str, order_data: dict, cart: list[CartItem] | None = None
) -> None:
    try:
        namespace = (user_id, "orders")
        order_ref = order_data.get("order_ref", "unknown")
        record = {
            "order_ref": order_ref,
            "checkout_url": order_data.get("checkout_url"),
            "summary": order_data.get("summary"),
            "expires_at": order_data.get("expires_at"),
            # Persist the cart items, not just the receipt — this is what lets Kavi make
            # personalized suggestions based on what the customer bought before (the
            # item names feed personalization.summarize_user_context).
            "cart": [dict(item) for item in (cart or [])],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await store.aput(namespace, order_ref, record)
        await store.aput(namespace, "latest", record)
    except Exception:
        logger.warning("Failed to record order history (non-fatal).", exc_info=True)


def wrap_search_products_tool(search_tool: BaseTool) -> BaseTool:
    """Forces response_format='json' and writes (user_id, 'searches') history on every
    call — independent of whether the agent remembers to ask for json or mention the
    search in its reply."""

    @tool
    async def kapruka_search_products(
        q: str,
        user_id: Annotated[str, InjectedState("user_id")],
        store: Annotated[BaseStore, InjectedStore()],
        tool_call_id: Annotated[str, InjectedToolCallId],
        limit: int = 10,
        currency: str = "LKR",
        min_price: float | None = None,
        max_price: float | None = None,
        sort: str = "relevance",
    ) -> Command:
        """Search Kapruka products by keyword, with optional price filters."""
        # `category` is intentionally NOT exposed as a tool argument: the upstream
        # category filter is brittle (search tags almost everything cat_general, so a real
        # taxonomy label like "Electronic" returns zero results). Hardcoding None makes it
        # impossible for the model to pass it — a prompt rule alone was occasionally ignored.
        params = {
            "q": q,
            "category": None,
            "limit": limit,
            "cursor": None,
            "currency": currency,
            "min_price": min_price,
            "max_price": max_price,
            "in_stock_only": True,
            "sort": sort,
            "include_stubs": False,
            "response_format": "json",
        }
        try:
            raw = await _timed_ainvoke(
                search_tool, {"params": params}, "search_products"
            )
        except Exception:
            logger.warning(
                "kapruka_search_products MCP call failed (non-fatal).", exc_info=True
            )
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=SEARCH_UNAVAILABLE_MSG, tool_call_id=tool_call_id
                        )
                    ]
                }
            )
        text = _extract_text(raw)
        data = _safe_json(text)
        minified_text = _minify_json(data) if data else text

        if user_id:
            await _record_search(store, user_id, q)

        update_dict = {
            "messages": [
                ToolMessage(
                    content=minified_text, artifact=data, tool_call_id=tool_call_id
                )
            ]
        }

        if data and "results" in data:
            viewed = {}
            for item in data["results"]:
                if "id" in item:
                    viewed[item["id"]] = {
                        "id": item["id"],
                        "name": item.get("name"),
                        "price": item.get("price", {}),
                        "images": [item.get("image_url")] if item.get("image_url") else [],
                        "in_stock": item.get("in_stock", True),
                        "variants": [],
                    }
            if viewed:
                update_dict["viewed_products"] = viewed

        return Command(update=update_dict)

    kapruka_search_products.name = search_tool.name
    return kapruka_search_products


def wrap_get_product_tool(get_product_tool: BaseTool) -> BaseTool:
    """Forces response_format='json' so product details can be deterministically parsed
    into a product card."""

    @tool
    async def kapruka_get_product(
        product_id: str,
        tool_call_id: Annotated[str, InjectedToolCallId],
        currency: str = "LKR",
        type: str | None = None,
    ) -> Command:
        """Fetch full details for a single Kapruka product by its product ID."""
        params = {
            "product_id": product_id,
            "currency": currency,
            "type": type,
            "response_format": "json",
        }
        try:
            raw = await _timed_ainvoke(
                get_product_tool, {"params": params}, "get_product"
            )
        except Exception:
            logger.warning(
                "kapruka_get_product MCP call failed (non-fatal).", exc_info=True
            )
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=PRODUCT_UNAVAILABLE_MSG, tool_call_id=tool_call_id
                        )
                    ]
                }
            )

        text = _extract_text(raw)
        data = _safe_json(text)
        minified_text = _minify_json(data) if data else text

        update_dict = {
            "messages": [
                ToolMessage(
                    content=minified_text, artifact=data, tool_call_id=tool_call_id
                )
            ]
        }

        if data and data.get("id"):
            update_dict["viewed_products"] = {data["id"]: data}

        return Command(update=update_dict)

    kapruka_get_product.name = get_product_tool.name
    return kapruka_get_product


def wrap_track_order_tool(track_order_tool: BaseTool) -> BaseTool:
    """Forces response_format='json' so tracking details can be deterministically parsed
    into a tracking card."""

    @tool
    async def kapruka_track_order(order_number: str) -> str:
        """Look up status and delivery progress for a Kapruka order by its order number
        (from the customer's confirmation email — this is NOT the pre-payment order_ref
        returned by place_order)."""
        params = {"order_number": order_number, "response_format": "json"}
        try:
            raw = await _timed_ainvoke(
                track_order_tool, {"params": params}, "track_order"
            )
        except Exception:
            logger.warning(
                "kapruka_track_order MCP call failed (non-fatal).", exc_info=True
            )
            return TRACKING_UNAVAILABLE_MSG
        return _extract_text(raw)

    kapruka_track_order.name = track_order_tool.name
    return kapruka_track_order


# =========================
# Checkout tools (order_agent only) — the strict gate lives here, not in the prompt
# =========================


def make_checkout_tools(
    list_delivery_cities_tool: BaseTool,
    check_delivery_tool: BaseTool,
    create_order_tool: BaseTool,
) -> list[BaseTool]:
    """update_checkout_info (free-form field collection), check_delivery_for_city
    (composite resolve+check, sets delivery_confirmed), and place_order (zero-arg,
    gated — reads cart/checkout/delivery_confirmed from state so the LLM never has to
    reconstruct the order payload itself)."""

    @tool
    def update_checkout_info(
        tool_call_id: Annotated[str, InjectedToolCallId],
        checkout: Annotated[CheckoutData | None, InjectedState("checkout")],
        recipient_name: str | None = None,
        recipient_phone: str | None = None,
        delivery_address: str | None = None,
        delivery_date: str | None = None,
        delivery_location_type: str | None = None,
        delivery_instructions: str | None = None,
        sender_name: str | None = None,
        sender_anonymous: bool | None = None,
        gift_message: str | None = None,
    ) -> Command:
        """Record checkout details the customer just gave you (recipient name/phone,
        delivery address/date/instructions, sender name, gift message). Do NOT pass a
        delivery city here — use check_delivery_for_city instead, which resolves it to a
        real deliverable city rather than storing whatever the customer typed."""
        # Normalize the date to ISO YYYY-MM-DD at write time — users say things like
        # "28th June" and the LLM echoes them verbatim; the MCP tools require strict ISO.
        normalized_date = (
            checkout_ops.normalize_date(delivery_date) if delivery_date else None
        )
        patch = {
            "recipient": {"name": recipient_name, "phone": recipient_phone},
            "delivery": {
                "address": delivery_address,
                "date": normalized_date
                if normalized_date is not None
                else delivery_date,
                "location_type": delivery_location_type,
                "instructions": delivery_instructions,
            },
            "sender": {"name": sender_name, "anonymous": sender_anonymous},
            "gift_message": gift_message,
        }
        new_checkout = checkout_ops.merge_checkout(checkout, patch)
        missing = checkout_ops.describe_missing_fields(new_checkout)
        message = (
            f"Got it. Still need: {', '.join(missing)}."
            if missing
            else "Got it, that covers the delivery details I need."
        )
        update = {
            "checkout": new_checkout,
            "messages": [ToolMessage(content=message, tool_call_id=tool_call_id)],
        }
        # Changing the date invalidates any prior delivery confirmation — it was only
        # ever confirmed for the date in effect at the time. Force a re-check rather than
        # risk place_order firing against a stale confirmation for a different date.
        if delivery_date is not None:
            update["delivery_confirmed"] = False
        return Command(update=update)

    @tool
    async def check_delivery_for_city(
        city: str,
        tool_call_id: Annotated[str, InjectedToolCallId],
        cart: Annotated[list[CartItem], InjectedState("cart")],
        checkout: Annotated[CheckoutData | None, InjectedState("checkout")],
    ) -> Command:
        """Resolve the customer's city to a real Kapruka delivery city (saving it right
        away) and, once a delivery date is on file, check availability for that date. Safe
        to call as soon as the customer names a city — if no date has been collected yet it
        saves the canonical city and asks for a date, rather than refusing."""
        # Resolve the canonical city FIRST, regardless of whether a date exists yet — so a
        # stated city actually gets saved into checkout (and drops out of the missing-fields
        # list) instead of being stuck unsatisfiable until a date appears.
        try:
            cities_raw = await _timed_ainvoke(
                list_delivery_cities_tool,
                {"params": {"query": city, "response_format": "json"}},
                "list_delivery_cities",
            )
        except Exception:
            logger.warning(
                "kapruka_list_delivery_cities MCP call failed (non-fatal).",
                exc_info=True,
            )
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=DELIVERY_CHECK_UNAVAILABLE_MSG,
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        cities_data = _safe_json(_extract_text(cities_raw)) or {}
        canonical, candidates = checkout_ops.resolve_canonical_city(
            city, cities_data.get("cities", [])
        )

        if not canonical:
            if candidates:
                message = f"I couldn't find an exact match for '{city}'. Did you mean: {', '.join(candidates[:5])}?"
            else:
                message = f"I couldn't find '{city}' in our delivery area. Could you double-check the city name?"
            return Command(
                update={
                    "messages": [
                        ToolMessage(content=message, tool_call_id=tool_call_id)
                    ]
                }
            )

        # City resolved — save it now. delivery_confirmed stays False until we've actually
        # checked a date against it.
        new_checkout = checkout_ops.merge_checkout(
            checkout, {"delivery": {"city": canonical}}
        )

        raw_date = (checkout or {}).get("delivery", {}).get("date")
        delivery_date = checkout_ops.normalize_date(raw_date)
        if delivery_date and delivery_date != raw_date:
            # Write the normalized form back so all future operations (including
            # build_create_order_payload) see a clean YYYY-MM-DD, not "28th June".
            new_checkout = checkout_ops.merge_checkout(
                new_checkout, {"delivery": {"date": delivery_date}}
            )

        if not delivery_date:
            return Command(
                update={
                    "checkout": new_checkout,
                    "delivery_confirmed": False,
                    "messages": [
                        ToolMessage(
                            content=f"Great news — we deliver to {canonical}! What date would you like it delivered?",
                            tool_call_id=tool_call_id,
                        )
                    ],
                }
            )

        if delivery_date < date.today().isoformat():
            return Command(
                update={
                    "checkout": new_checkout,
                    "delivery_confirmed": False,
                    "messages": [
                        ToolMessage(
                            content=f"That date has already passed — could you pick a date from today onwards?",
                            tool_call_id=tool_call_id,
                        )
                    ],
                }
            )

        perishable_id = checkout_ops.find_perishable_product_id(cart or [])
        try:
            check_raw = await _timed_ainvoke(
                check_delivery_tool,
                {
                    "params": {
                        "city": canonical,
                        "delivery_date": delivery_date,
                        "product_id": perishable_id,
                        "response_format": "json",
                    }
                },
                "check_delivery",
            )
        except Exception:
            logger.warning(
                "kapruka_check_delivery MCP call failed (non-fatal).", exc_info=True
            )
            # The city was resolved successfully — keep it saved even though the
            # availability check itself failed, so we don't lose that progress.
            return Command(
                update={
                    "checkout": new_checkout,
                    "messages": [
                        ToolMessage(
                            content=DELIVERY_CHECK_UNAVAILABLE_MSG,
                            tool_call_id=tool_call_id,
                        )
                    ],
                }
            )
        check_data = _safe_json(_extract_text(check_raw)) or {}
        available = bool(check_data.get("available"))

        if available:
            rate = check_data.get("rate")
            warning = check_data.get("perishable_warning")
            message = (
                f"Great news — we can deliver to {canonical} on {delivery_date}"
                + (f" (delivery fee: {rate} LKR)." if rate is not None else ".")
            )
            if warning:
                message += f" Note: {warning}"
            return Command(
                update={
                    "checkout": new_checkout,
                    "delivery_confirmed": True,
                    "messages": [
                        ToolMessage(content=message, tool_call_id=tool_call_id)
                    ],
                }
            )

        # Unavailable on the requested date — adopt the next available date if the API offers
        # one (mirrors check_delivery_core; see TASKS.md Sprint 16 for why a message-only date
        # traps checkout in a "confirm delivery first" loop).
        reason = check_data.get("reason") or "that date isn't available"
        raw_next = check_data.get("next_available_date")
        next_date = checkout_ops.normalize_date(raw_next) or raw_next
        if next_date and next_date != delivery_date:
            rescheduled = checkout_ops.merge_checkout(
                new_checkout, {"delivery": {"date": next_date}}
            )
            message = (
                f"{delivery_date} isn't available for {canonical} ({reason}), "
                f"so I've moved your delivery to {next_date}."
            )
            return Command(
                update={
                    "checkout": rescheduled,
                    "delivery_confirmed": True,
                    "messages": [
                        ToolMessage(content=message, tool_call_id=tool_call_id)
                    ],
                }
            )

        message = f"We can't deliver to {canonical} on {delivery_date} — {reason}."
        return Command(
            update={
                "checkout": new_checkout,
                "delivery_confirmed": False,
                "messages": [ToolMessage(content=message, tool_call_id=tool_call_id)],
            }
        )

    @tool
    async def place_order(
        tool_call_id: Annotated[str, InjectedToolCallId],
        cart: Annotated[list[CartItem], InjectedState("cart")],
        checkout: Annotated[CheckoutData | None, InjectedState("checkout")],
        delivery_confirmed: Annotated[bool, InjectedState("delivery_confirmed")],
        user_id: Annotated[str, InjectedState("user_id")],
        store: Annotated[BaseStore, InjectedStore()],
    ) -> Command:
        """Place the order using everything collected so far. Only call this once the
        customer has confirmed they're ready — there are no parameters; it uses the
        current cart and checkout details directly, never reconstructed by you."""
        ready, reason = checkout_ops.is_ready_for_order(
            cart or [], checkout, delivery_confirmed
        )
        if not ready:
            return Command(
                update={
                    "messages": [ToolMessage(content=reason, tool_call_id=tool_call_id)]
                }
            )

        payload = checkout_ops.build_create_order_payload(cart, checkout)
        try:
            raw = await _timed_ainvoke(
                create_order_tool, {"params": payload}, "create_order"
            )
        except Exception:
            logger.warning(
                "kapruka_create_order MCP call failed (non-fatal).", exc_info=True
            )
            return Command(
                update={
                    "messages": [
                        ToolMessage(
                            content=PLACE_ORDER_UNAVAILABLE_MSG,
                            tool_call_id=tool_call_id,
                        )
                    ]
                }
            )
        text = _extract_text(raw)
        data = _safe_json(text)

        if data and data.get("checkout_url"):
            if user_id:
                await _record_order(store, user_id, data, cart)
            # Raw JSON, not a pre-written sentence — same pattern as search/get_product:
            # the agent's LLM phrases the reply from this, and cards.py parses the same
            # JSON to build the CheckoutConfirmationCard. Never invent these numbers.
            return Command(
                update={
                    "cart": [],
                    "checkout": None,
                    "delivery_confirmed": False,
                    "cross_sold_categories": [],
                    "messages": [ToolMessage(content=text, tool_call_id=tool_call_id)],
                }
            )

        _code, friendly_message = checkout_ops.parse_create_order_error(text)
        return Command(
            update={
                "messages": [
                    ToolMessage(content=friendly_message, tool_call_id=tool_call_id)
                ]
            }
        )

    return [update_checkout_info, check_delivery_for_city, place_order]


# =========================
# Standalone core functions (used by the Smart Interceptor in order_agent_node)
# =========================


async def check_delivery_core(
    city: str,
    cart: list,
    checkout: dict | None,
    list_cities_tool,
    check_delivery_tool,
) -> tuple[dict | None, bool, str]:
    """Resolve a delivery city and check availability — same logic as
    check_delivery_for_city but called directly from the node interceptor
    (no LangChain tool wrapper). Returns (new_checkout_or_None, delivery_confirmed, message).
    new_checkout is None when city resolution fails — caller should not update state."""
    try:
        cities_raw = await _timed_ainvoke(
            list_cities_tool,
            {"params": {"query": city, "response_format": "json"}},
            "list_delivery_cities",
        )
    except Exception:
        logger.warning(
            "kapruka_list_delivery_cities MCP call failed (non-fatal).", exc_info=True
        )
        return None, False, DELIVERY_CHECK_UNAVAILABLE_MSG

    cities_data = _safe_json(_extract_text(cities_raw)) or {}
    canonical, candidates = checkout_ops.resolve_canonical_city(
        city, cities_data.get("cities", [])
    )

    if not canonical:
        if candidates:
            message = f"I couldn't find an exact match for '{city}'. Did you mean: {', '.join(candidates[:5])}?"
        else:
            message = f"I couldn't find '{city}' in our delivery area. Could you double-check the city name?"
        return None, False, message

    new_checkout = checkout_ops.merge_checkout(
        checkout, {"delivery": {"city": canonical}}
    )

    raw_delivery_date = (checkout or {}).get("delivery", {}).get("date")
    delivery_date = checkout_ops.normalize_date(raw_delivery_date)
    if not delivery_date and raw_delivery_date:
        return (
            new_checkout,
            False,
            f"'{raw_delivery_date}' isn't a date I can use for delivery scheduling — please ask the user for a specific date like '30th June 2026'.",
        )
    if not delivery_date:
        return (
            new_checkout,
            False,
            f"Great news — we deliver to {canonical}! What date would you like it delivered?",
        )
    # Persist normalized date back into checkout if it changed
    if delivery_date != raw_delivery_date:
        new_checkout = checkout_ops.merge_checkout(
            new_checkout, {"delivery": {"date": delivery_date}}
        )

    perishable_id = checkout_ops.find_perishable_product_id(cart or [])
    try:
        check_raw = await _timed_ainvoke(
            check_delivery_tool,
            {
                "params": {
                    "city": canonical,
                    "delivery_date": delivery_date,
                    "product_id": perishable_id,
                    "response_format": "json",
                }
            },
            "check_delivery",
        )
    except Exception as exc:
        logger.warning(
            "kapruka_check_delivery MCP call failed (non-fatal).", exc_info=True
        )
        _err = str(exc)
        if "delivery_date" in _err or "YYYY-MM-DD" in _err:
            return (
                new_checkout,
                False,
                f"The date '{delivery_date}' isn't valid for delivery scheduling — please ask the user for a specific date like '30th June 2026'.",
            )
        return new_checkout, False, DELIVERY_CHECK_UNAVAILABLE_MSG

    check_data = _safe_json(_extract_text(check_raw)) or {}
    available = bool(check_data.get("available"))

    if available:
        rate = check_data.get("rate")
        warning = check_data.get("perishable_warning")
        message = f"Great news — we can deliver to {canonical} on {delivery_date}" + (
            f" (delivery fee: {rate} LKR)." if rate is not None else "."
        )
        if warning:
            message += f" Note: {warning}"
        return new_checkout, True, message

    # Unavailable on the requested date. If the API offers a next available date, ADOPT it
    # into checkout and treat delivery as confirmed for that date — otherwise the offered
    # date only ever lives in a message string while checkout stays stuck on an undeliverable
    # date with delivery_confirmed=False, so place_order can never pass and the customer is
    # trapped in a "Let's confirm delivery first" loop (see TASKS.md Sprint 16).
    reason = check_data.get("reason") or "that date isn't available"
    raw_next = check_data.get("next_available_date")
    next_date = checkout_ops.normalize_date(raw_next) or raw_next
    if next_date and next_date != delivery_date:
        rescheduled = checkout_ops.merge_checkout(
            new_checkout, {"delivery": {"date": next_date}}
        )
        message = (
            f"{delivery_date} isn't available for {canonical} ({reason}), "
            f"so I've moved your delivery to {next_date}."
        )
        return rescheduled, True, message

    message = f"We can't deliver to {canonical} on {delivery_date} — {reason}."
    return new_checkout, False, message


async def place_order_core(
    cart: list,
    checkout: dict | None,
    delivery_confirmed: bool,
    create_order_tool,
    store: "BaseStore | None",
    user_id: str,
) -> tuple[dict, str]:
    """Place the order — same logic as the place_order tool but called directly from the
    node interceptor. Returns (state_updates, ack_message).
    On success: state_updates resets cart/checkout/delivery_confirmed/cross_sold_categories
    and includes last_order_data for card rendering. On failure: state_updates is empty."""
    ready, reason = checkout_ops.is_ready_for_order(
        cart or [], checkout, delivery_confirmed
    )
    if not ready:
        return {}, reason

    payload = checkout_ops.build_create_order_payload(cart, checkout)
    try:
        raw = await _timed_ainvoke(
            create_order_tool, {"params": payload}, "create_order"
        )
    except Exception:
        logger.warning(
            "kapruka_create_order MCP call failed (non-fatal).", exc_info=True
        )
        return {}, PLACE_ORDER_UNAVAILABLE_MSG

    text = _extract_text(raw)
    data = _safe_json(text)

    if data and data.get("checkout_url"):
        if user_id and store:
            await _record_order(store, user_id, data, cart)
        summary = data.get("summary") or {}
        ack = (
            f"Order placed successfully! "
            f"order_ref={data.get('order_ref')} "
            f"grand_total={summary.get('grand_total', 'N/A')} LKR. "
            f"Payment link is ready for the customer."
        )
        return {
            "cart": [],
            "checkout": None,
            "delivery_confirmed": False,
            "cross_sold_categories": [],
            "last_order_data": data,
        }, ack

    _code, friendly_message = checkout_ops.parse_create_order_error(text)
    return {}, friendly_message
