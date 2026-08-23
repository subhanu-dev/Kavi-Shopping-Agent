"""Deterministic checkout logic — pure functions, no LangGraph/FastAPI dependency.

Mirrors cart.py's philosophy: the LLM extracts *what* the customer said, but every
decision that has to be reliably correct (canonical city resolution, whether the order
is actually ready to place, what a failure code means) is a plain function here, not
something trusted to LLM judgment turn after turn.
"""

from __future__ import annotations

import re
from datetime import date as _date, datetime as _datetime, timezone as _timezone, timedelta as _timedelta

_SL_TZ = _timezone(_timedelta(hours=5, minutes=30))

from .schemas import CartItem, CheckoutData, get_missing_checkout_fields

PERISHABLE_PREFIXES = ("CAKE", "FLOWER", "COMBO")

FIELD_LABELS = {
    "recipient.name": "recipient's name",
    "recipient.phone": "recipient's phone number",
    "delivery.address": "delivery address",
    "delivery.city": "delivery city",
    "delivery.date": "delivery date",
    "sender.name": "your name (as sender)",
}


def describe_missing_fields(checkout: CheckoutData | None) -> list[str]:
    """Human-readable labels for get_missing_checkout_fields, for prompts/messages."""
    return [FIELD_LABELS.get(f, f) for f in get_missing_checkout_fields(checkout)]


def find_perishable_product_id(cart: list[CartItem]) -> str | None:
    """First cake/flower/combo item in the cart, used for check_delivery's freshness
    warning. Only one item is checked even if there are several — see TASKS.md."""
    for item in cart:
        product_id = item.get("product_id", "")
        if product_id.upper().startswith(PERISHABLE_PREFIXES):
            return product_id
    return None


def resolve_canonical_city(raw_query: str, cities: list[dict]) -> tuple[str | None, list[str]]:
    """Pick the canonical city name from list_delivery_cities' results.

    Returns (canonical_name_or_None, candidate_names). canonical is only set when
    confident: either there's exactly one result, or exactly one result's name/alias is
    an exact case-insensitive match for what the customer typed — never guessed.
    """
    if not cities:
        return None, []

    candidates = [c.get("name", "") for c in cities if c.get("name")]

    normalized_query = raw_query.strip().lower()
    exact_matches = [
        c.get("name", "")
        for c in cities
        if c.get("name", "").strip().lower() == normalized_query
        or normalized_query in [a.strip().lower() for a in c.get("aliases", [])]
    ]
    if len(exact_matches) == 1:
        return exact_matches[0], candidates

    if len(candidates) == 1:
        return candidates[0], candidates

    return None, candidates


def merge_checkout(checkout: CheckoutData | None, patch: dict) -> CheckoutData:
    """Deep-merge a partial patch (e.g. {"recipient": {"name": "..."}}) into the current
    checkout dict. Only provided, non-None leaf fields are updated — sections are never
    wholesale-replaced, since fields usually arrive one at a time across several turns."""
    result: dict = {k: (dict(v) if isinstance(v, dict) else v) for k, v in (checkout or {}).items()}
    for section, fields in patch.items():
        if fields is None:
            continue
        if isinstance(fields, dict):
            existing = dict(result.get(section, {}))
            for key, value in fields.items():
                if value is not None:
                    existing[key] = value
            result[section] = existing
        else:
            result[section] = fields
    return result


def reduce_checkout(left: CheckoutData | None, right: CheckoutData | None) -> CheckoutData | None:
    """Reducer for the `checkout` state channel.

    An explicit `None` write RESETS checkout to None — this is what `place_order` (on
    success) and the cart-clear paths use to end a checkout. We deliberately do NOT treat
    `None` as "keep the current value": every node/tool writes the *full* intended checkout
    value (not a partial), so the only reason a `None` ever reaches this reducer is an
    intentional reset. (The previous version returned `left` on a `None` write, which made
    it impossible to ever clear checkout — a stale checkout would persist for the whole
    thread, e.g. the delivery form lingering after the cart was emptied.)

    Two non-None dict writes landing in one step are deep-merged (defense against parallel
    tool calls in a single AIMessage)."""
    if right is None:
        return None
    return merge_checkout(left, right)


def is_ready_for_order(
    cart: list[CartItem], checkout: CheckoutData | None, delivery_confirmed: bool
) -> tuple[bool, str | None]:
    """The gate `place_order` enforces before ever calling the real create_order API.
    Returns (ready, reason_if_not)."""
    if not cart:
        return False, "Your cart is empty — let's add something first!"

    missing = describe_missing_fields(checkout)
    if missing:
        return False, f"I still need: {', '.join(missing)}."

    phone = (checkout or {}).get("recipient", {}).get("phone")
    if phone and normalize_phone(phone) is None:
        return False, "The recipient's phone number doesn't look right — please use a 10-digit Sri Lankan number (e.g. 0712345678)."

    if not delivery_confirmed:
        return False, "Let's confirm delivery is available for your city and date first."

    return True, None


def _strip_default_variant(product_id: str) -> str:
    """Strip the frontend's _default variant suffix before sending to Kapruka.

    The frontend appends _default to product IDs that have no real variants so it
    can treat all cart items uniformly. The Kapruka create_order API only knows the
    bare product ID (e.g. cake00KA001827), never the fabricated _default form."""
    return product_id[:-8] if product_id.endswith("_default") else product_id


def normalize_date(raw: str | None) -> str | None:
    """Normalize a delivery date string to ISO YYYY-MM-DD.

    Handles natural-language dates like "28th June", "June 28", "28 Jun 2026",
    "28/06/2026", etc.  Assumes the current calendar year when no year is given.
    Returns None for unrecognizable input so callers can prompt the user to re-enter.
    """
    if not raw:
        return None
    text = raw.strip()

    # Already ISO — fast path.
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text

    # Strip ordinal suffixes: "28th" → "28", "1st" → "1"
    text = re.sub(r"(\d+)(?:st|nd|rd|th)\b", r"\1", text, flags=re.IGNORECASE)

    current_year = _datetime.now(_SL_TZ).date().year

    _FORMATS_WITH_YEAR = (
        "%d %B %Y", "%d %b %Y", "%B %d %Y", "%b %d %Y",
        "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y",
        "%Y/%m/%d", "%d.%m.%Y", "%d.%m.%y",
    )
    _FORMATS_NO_YEAR = (
        "%d %B", "%d %b", "%B %d", "%b %d",
        "%d/%m", "%d-%m", "%d.%m",
    )

    for fmt in _FORMATS_WITH_YEAR:
        try:
            return _datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass

    for fmt in _FORMATS_NO_YEAR:
        try:
            dt = _datetime.strptime(text, fmt)
            return _date(current_year, dt.month, dt.day).isoformat()
        except ValueError:
            pass

    return None


def normalize_phone(raw: str | None) -> str | None:
    """Normalize a Sri Lankan phone number to E.164 format (+94XXXXXXXXX).

    Accepts:
      - 10-digit local  (07XXXXXXXX)     → +94 + digits[1:]
      - 11-digit no-plus (94XXXXXXXXX)   → + + digits
      - Already E.164  (+94XXXXXXXXX)    → unchanged
    Returns None for anything else so callers can reject invalid numbers early.
    """
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10 and digits.startswith("0"):
        return "+94" + digits[1:]
    if len(digits) == 11 and digits.startswith("94"):
        return "+" + digits
    if raw.startswith("+") and len(digits) == 11 and digits.startswith("94"):
        return "+" + digits
    return None


def build_create_order_payload(cart: list[CartItem], checkout: CheckoutData, currency: str = "LKR") -> dict:
    """Assemble kapruka_create_order's exact expected shape from accumulated state —
    the LLM never has to reconstruct this nested structure itself."""
    recipient = checkout.get("recipient", {})
    delivery = checkout.get("delivery", {})
    sender = checkout.get("sender", {})

    raw_phone = recipient.get("phone")
    normalized_phone = normalize_phone(raw_phone) or raw_phone

    raw_date = delivery.get("date")
    normalized_date = normalize_date(raw_date) or raw_date

    return {
        "cart": [
            {
                "product_id": _strip_default_variant(item["product_id"]),
                "quantity": item["quantity"],
                **({"icing_text": item["icing_text"]} if item.get("icing_text") else {}),
            }
            for item in cart
        ],
        "recipient": {"name": recipient.get("name"), "phone": normalized_phone},
        "delivery": {
            "address": delivery.get("address"),
            "city": delivery.get("city"),
            "date": normalized_date,
            "location_type": delivery.get("location_type", "house"),
            **({"instructions": delivery["instructions"]} if delivery.get("instructions") else {}),
        },
        "sender": {"name": sender.get("name"), "anonymous": sender.get("anonymous", False)},
        **({"gift_message": checkout["gift_message"]} if checkout.get("gift_message") else {}),
        "currency": currency,
        "response_format": "json",
    }


CREATE_ORDER_ERROR_MESSAGES = {
    "empty_cart": "Your cart is empty — let's add something first!",
    "missing_field": "I still need a bit more information before I can place this order.",
    "past_delivery_date": "That delivery date has already passed — could you pick a date from today onwards?",
    "product_not_found": "One of the items in your cart isn't available anymore — let me help you find an alternative.",
    "product_out_of_stock": "One of the items in your cart just went out of stock. Want me to suggest something similar?",
    "city_not_deliverable": "We're not able to deliver to that city right now — want to try a nearby one?",
    "date_not_deliverable": "That date isn't available for delivery — would another date work?",
}

_ERROR_CODE_PATTERN = re.compile(r"^Error \(([\w_]+)\):\s*(.*)$")


def parse_create_order_error(text: str) -> tuple[str | None, str]:
    """kapruka_create_order errors look like 'Error (<code>): <message>'. Returns
    (code_or_None, a friendly message — never the raw API text)."""
    match = _ERROR_CODE_PATTERN.match(text.strip())
    if not match:
        return None, "Something went wrong placing the order — let's try again in a moment."

    code, _raw_message = match.group(1), match.group(2)
    return code, CREATE_ORDER_ERROR_MESSAGES.get(
        code, "Something went wrong placing the order — let's try again in a moment."
    )
