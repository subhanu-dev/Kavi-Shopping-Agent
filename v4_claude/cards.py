"""Deterministic extraction of frontend cards from tool results — kept separate from the
LLM synthesis step (kavi_agent) so card content is never something the model has to get
right; it only has to talk *around* what's already been built here.
"""

from __future__ import annotations

import json
import logging
import re

_SYS_PREFIX_RE = re.compile(r"^\[System\][^.\n]*\.\s*")

from langchain_core.messages import AnyMessage

from .cart import cart_items_total
from .schemas import (
    CartItem,
    CartLineCard,
    CartSummaryCard,
    CheckoutConfirmationCard,
    CheckoutData,
    CheckoutFormCard,
    OrderTrackingCard,
    OrderTrackingItem,
    ProductCard,
    ProductDetailCard,
    ProductVariant,
    TrackOrderFormCard,
    get_missing_checkout_fields,
)

logger = logging.getLogger(__name__)

MAX_PRODUCT_CARDS_PER_SEARCH = 20


def message_text(content) -> str:
    """Normalize a LangChain message's .content — Gemini sometimes returns a list of
    content parts (e.g. [{"type": "text", "text": "..."}]) instead of a plain string."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and "text" in part:
                parts.append(part["text"])
        text = "".join(parts)
    elif content is None:
        return ""
    else:
        text = str(content)
    # Strip leading [System] coordination prefix if kavi_agent accidentally echoes it.
    return _SYS_PREFIX_RE.sub("", text)


def _safe_json(content) -> dict | None:
    if not isinstance(content, str):
        return None
    try:
        return json.loads(content)
    except ValueError:
        return None


_PARTNER_PLACEHOLDER_IMAGE = "brand_creator/logo/kap_parter_default.png"


def _is_storefront_result(item: dict) -> bool:
    """True for brand/partner landing pages (e.g. kapruka.com/partner/<slug>)
    that search returns alongside real products — not purchasable items.
    Confirmed shape: normal-looking id (no CATSYM prefix), url containing
    "/partner/", and a generic placeholder image_url."""
    url = item.get("url") or ""
    image_url = item.get("image_url") or ""
    product_id = item.get("id") or ""
    return (
        "/partner/" in url
        or _PARTNER_PLACEHOLDER_IMAGE in image_url
        or product_id.upper().startswith("CATSYM")
    )


def _product_card_from_search_result(item: dict) -> ProductCard:
    price = item.get("price") or {}
    compare = item.get("compare_at_price") or {}
    return ProductCard(
        product_id=item.get("id", ""),
        name=item.get("name", ""),
        image_url=item.get("image_url"),
        price=price.get("amount"),
        compare_at_price=compare.get("amount"),
        currency=price.get("currency", "LKR"),
        in_stock=item.get("in_stock", True),
        stock_level=item.get("stock_level"),
        url=item.get("url"),
    )


def _product_detail_card(detail: dict) -> ProductDetailCard:
    price = detail.get("price") or {}
    compare = detail.get("compare_at_price") or {}
    images = detail.get("images") or []
    
    variants = []
    for v in detail.get("variants") or []:
        v_price = v.get("price") or {}
        variants.append(ProductVariant(
            id=v.get("id", ""),
            name=v.get("name", ""),
            sku=v.get("sku"),
            price=v_price.get("amount"),
            currency=v_price.get("currency", "LKR"),
            in_stock=v.get("in_stock", True),
            stock_level=v.get("stock_level"),
            attributes=v.get("attributes") or {}
        ))

    return ProductDetailCard(
        product_id=detail.get("id", ""),
        name=detail.get("name", ""),
        image_url=images[0] if images else None,
        price=price.get("amount"),
        compare_at_price=compare.get("amount"),
        currency=price.get("currency", "LKR"),
        in_stock=detail.get("in_stock", True),
        stock_level=detail.get("stock_level"),
        summary=detail.get("summary") or detail.get("description"),
        url=detail.get("url"),
        images=images,
        variants=variants,
        category=detail.get("category").get("name") if isinstance(detail.get("category"), dict) else detail.get("category"),
        attributes=detail.get("attributes") or {},
        shipping=detail.get("shipping"),
    )


def _cart_summary_card(cart: list[CartItem]) -> CartSummaryCard:
    lines = [
        CartLineCard(
            product_id=item["product_id"],
            name=item["name"],
            image_url=item.get("image_url"),
            unit_price=item.get("unit_price"),
            quantity=item["quantity"],
            line_total=(
                item["unit_price"] * item["quantity"]
                if item.get("unit_price") is not None
                else None
            ),
            in_stock=item.get("in_stock", True),
        )
        for item in cart
    ]
    return CartSummaryCard(
        items=lines,
        items_total=cart_items_total(cart),
        currency=cart[0].get("currency", "LKR") if cart else "LKR",
    )


def _checkout_confirmation_card(data: dict) -> CheckoutConfirmationCard:
    summary = data.get("summary") or {}
    return CheckoutConfirmationCard(
        checkout_url=data["checkout_url"],
        order_ref=data.get("order_ref", ""),
        items_total=summary.get("items_total", 0),
        delivery_fee=summary.get("delivery_fee", 0),
        addons_total=summary.get("addons_total", 0),
        grand_total=summary.get("grand_total", 0),
        currency=summary.get("currency", "LKR"),
        expires_at=data.get("expires_at", ""),
    )


def _order_tracking_card(data: dict) -> OrderTrackingCard:
    # `amount` varies by API version: dict {"value": "26060", "currency": "LKR"} or plain str "15500.00"
    amount_raw = data.get("amount")
    if isinstance(amount_raw, dict):
        total_str = amount_raw.get("value")
        order_currency = amount_raw.get("currency", "LKR")
    elif isinstance(amount_raw, str):
        total_str = amount_raw
        order_currency = "LKR"
    else:
        total_str = None
        order_currency = "LKR"

    try:
        order_total = float(total_str) if total_str else None
    except (ValueError, TypeError):
        order_total = None

    comments = data.get("comments") or None
    if comments == "":
        comments = None

    items = []
    for raw in data.get("items") or []:
        try:
            items.append(OrderTrackingItem(
                product_id=raw.get("product_id", ""),
                name=raw.get("name", ""),
                quantity=int(raw.get("quantity", 1)),
                selling_price=float(raw["selling_price"]) if raw.get("selling_price") is not None else None,
            ))
        except Exception:
            logger.warning("Failed to parse order tracking item.", exc_info=True)

    return OrderTrackingCard(
        order_number=data.get("order_number", ""),
        status=data.get("status", ""),
        status_display=data.get("status_display", data.get("status", "")),
        progress=data.get("progress") or [],
        has_delivery_photo=data.get("has_delivery_photo", False),
        has_delivery_video=data.get("has_delivery_video", False),
        live_tracking_available=data.get("live_tracking_available", False),
        order_date=data.get("order_date") or None,
        delivery_date=data.get("delivery_date") or None,
        shipped_date=data.get("shipped_date") or None,
        order_total=order_total,
        order_currency=order_currency,
        comments=comments,
        items=items,
    )


def _checkout_form_card(checkout: CheckoutData) -> CheckoutFormCard:
    return CheckoutFormCard(
        fields=checkout, missing_fields=get_missing_checkout_fields(checkout)
    )


def extract_cards_from_messages(
    messages: list[AnyMessage],
    cart: list[CartItem] | None = None,
    checkout: CheckoutData | None = None,
    show_tracking_form: bool = False,
    last_order_data: dict | None = None,
) -> list[dict]:
    """Find this turn's tool results and turn them into cards: products (search),
    a checkout confirmation (place_order success), or an order tracking card (track_order) —
    plus a cart summary card if the cart is non-empty, and a checkout form card whenever
    checkout is in progress (`checkout is not None`), regardless of which tool ran.

    Tool results aren't necessarily the last messages — the specialist node often adds
    its own follow-up text after seeing a tool result, before handing off to kavi_agent.
    So we scan back to the most recent HumanMessage (the start of this turn) and collect
    every tool result found anywhere in that span, not just a contiguous tail.
    """
    cards: list[dict] = []

    idx = len(messages) - 1
    turn_messages = []
    while idx >= 0 and getattr(messages[idx], "type", None) != "human":
        turn_messages.append(messages[idx])
        idx -= 1

    for msg in turn_messages:
        if getattr(msg, "type", None) != "tool":
            continue
        name = getattr(msg, "name", None)
        
        artifact = getattr(msg, "artifact", None)
        if isinstance(artifact, dict):
            data = artifact
        elif isinstance(artifact, str):
            data = _safe_json(artifact)
        else:
            data = _safe_json(getattr(msg, "content", None))

        if not data:
            continue

        try:
            if name == "kapruka_search_products" and isinstance(
                data.get("results"), list
            ):
                results = [
                    r for r in data["results"] if not _is_storefront_result(r)
                ]
                for result in results[:MAX_PRODUCT_CARDS_PER_SEARCH]:
                    cards.append(_product_card_from_search_result(result).model_dump())
            elif name == "kapruka_get_product" and data.get("id"):
                card = _product_detail_card(data).model_dump()
                # Deduplicate by product_id in case the LLM stuttered and called the tool twice
                if not any(c.get("type") == "product_detail" and c.get("product_id") == card.get("product_id") for c in cards):
                    cards.append(card)
            elif name == "place_order" and data.get("checkout_url"):
                cards.append(_checkout_confirmation_card(data).model_dump())
            elif name == "kapruka_track_order" and data.get("order_number"):
                cards.append(_order_tracking_card(data).model_dump())
        except Exception:
            logger.warning("Failed to build card from tool result.", exc_info=True)

    # Filter out generic search cards if we already have a specific product detail card in the same turn
    has_product_detail = any(c.get("type") == "product_detail" for c in cards)
    if has_product_detail:
        cards = [c for c in cards if c.get("type") != "product"]

    if cart is not None:
        try:
            cards.append(_cart_summary_card(cart).model_dump())
        except Exception:
            logger.warning("Failed to build cart summary card.", exc_info=True)

    # Only show the checkout form when there's actually something to check out. Guarding on
    # `cart` too means a stale/non-None checkout can never render a delivery form over an
    # empty cart (e.g. right after the cart is cleared).
    if checkout is not None and cart:
        try:
            cards.append(_checkout_form_card(checkout).model_dump())
        except Exception:
            logger.warning("Failed to build checkout form card.", exc_info=True)

    if show_tracking_form:
        cards.append(TrackOrderFormCard().model_dump())

    # Checkout confirmation from Smart Interceptor path (place_order_core sets this on
    # success; kavi_agent resets it to None after this turn so it doesn't persist).
    if last_order_data and last_order_data.get("checkout_url"):
        try:
            cards.append(_checkout_confirmation_card(last_order_data).model_dump())
        except Exception:
            logger.warning("Failed to build checkout confirmation card from last_order_data.", exc_info=True)

    return cards


def summarize_cards_for_prompt(cards: list[dict]) -> str:
    """Compact, human-readable list of facts already visible on the cards — fed to
    kavi_agent so it knows what NOT to repeat in its own text."""
    if not cards:
        return "(none yet)"

    lines = []
    for card in cards:
        card_type = card.get("type")
        if card_type == "product":
            price = card.get("price")
            price_str = (
                f"{price} {card.get('currency', 'LKR')}"
                if price is not None
                else "price n/a"
            )
            stock = "in stock" if card.get("in_stock", True) else "out of stock"
            lines.append(f"- {card.get('name')} — {price_str}, {stock}")
        elif card_type == "product_detail":
            price = card.get("price")
            price_str = (
                f"{price} {card.get('currency', 'LKR')}"
                if price is not None
                else "price n/a"
            )
            stock = "in stock" if card.get("in_stock", True) else "out of stock"
            variant_count = len(card.get("variants", []))
            variants_str = f", {variant_count} variant(s)" if variant_count > 0 else ""
            lines.append(f"- {card.get('name')} — {price_str}, {stock}{variants_str} (details shown)")
        elif card_type == "cart_summary":
            total = card.get("items_total")
            total_str = (
                f"{total} {card.get('currency', 'LKR')}"
                if total is not None
                else "total n/a"
            )
            lines.append(
                f"- Cart: {len(card.get('items', []))} item(s), total {total_str}"
            )
        elif card_type == "checkout_form":
            missing = card.get("missing_fields") or []
            lines.append(
                f"- Checkout form is shown (still missing: {', '.join(missing)})"
                if missing
                else "- Checkout form is shown, all required fields are filled"
            )
        elif card_type == "checkout_confirmation":
            lines.append(
                f"- Order confirmed: ref {card.get('order_ref')}, total {card.get('grand_total')} "
                f"{card.get('currency', 'LKR')}, pay link shown on card"
            )
        elif card_type == "order_tracking":
            lines.append(
                f"- Order {card.get('order_number')} status: {card.get('status_display')}"
            )
        elif card_type == "track_order_form":
            lines.append(
                "- The Order Tracking form is shown. Invite the user to enter their order number."
            )

    return "\n".join(lines) if lines else "(none yet)"


def shape_chat_response(user_id: str, thread_id: str, result: dict) -> dict:
    """Common response shape for /chat and every UI-action endpoint, so the frontend
    never needs to special-case a button-triggered reply vs a typed one."""
    return {
        "user_id": user_id,
        "thread_id": thread_id,
        "text": message_text(result["messages"][-1].content),
        "cards": result.get("cards", []),
        "cart": result.get("cart", []),
        "suggested_next_step": result.get("suggested_next_step"),
        "selected_agent": result.get("selected_agent"),
        "language": result.get("language"),
    }
