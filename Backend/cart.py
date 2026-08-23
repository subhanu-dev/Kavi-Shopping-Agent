"""Shared cart mutation logic

Both the local LLM-callable tools (tools.py) and the UI-action endpoints call these same
functions, so a typed "add 2 of that cake" and a clicked "Add to cart" button can never
disagree about what a valid cart mutation looks like.
"""

from __future__ import annotations

from .schemas import (
    CartItem,
    CheckoutData,
    SuggestedNextStep,
    get_missing_checkout_fields,
)

MAX_QUANTITY = 99


class CartError(Exception):
    """Invalid cart operation (bad quantity, item not found, out of stock, ...).

    Caught by tools/endpoints and turned into a friendly message — never surfaced raw.
    """


def _find_index(cart: list[CartItem], product_id: str) -> int | None:
    for i, item in enumerate(cart):
        if item["product_id"] == product_id:
            return i
    return None


def add_item(
    cart: list[CartItem],
    *,
    product_id: str,
    name: str,
    quantity: int = 1,
    unit_price: float | None = None,
    currency: str = "LKR",
    image_url: str | None = None,
    icing_text: str | None = None,
    in_stock: bool = True,
) -> list[CartItem]:
    if quantity < 1:
        raise CartError(f"Quantity must be at least 1 (got {quantity}).")
    if not in_stock:
        raise CartError(f"{name} is currently out of stock.")

    new_cart = [dict(item) for item in cart]
    idx = _find_index(new_cart, product_id)

    if idx is None:
        if quantity > MAX_QUANTITY:
            raise CartError(f"Maximum quantity per item is {MAX_QUANTITY}.")
        item: CartItem = {
            "product_id": product_id,
            "name": name,
            "quantity": quantity,
            "currency": currency,
            "in_stock": in_stock,
        }
        if unit_price is not None:
            item["unit_price"] = unit_price
        if image_url is not None:
            item["image_url"] = image_url
        if icing_text is not None:
            item["icing_text"] = icing_text
        new_cart.append(item)
    else:
        combined_qty = new_cart[idx]["quantity"] + quantity
        if combined_qty > MAX_QUANTITY:
            raise CartError(f"Maximum quantity per item is {MAX_QUANTITY}.")
        new_cart[idx]["quantity"] = combined_qty
        if icing_text is not None:
            new_cart[idx]["icing_text"] = icing_text

    return new_cart


def remove_item(cart: list[CartItem], product_id: str) -> list[CartItem]:
    idx = _find_index(cart, product_id)
    if idx is None:
        raise CartError(f"That item isn't in the cart.")
    return [item for item in cart if item["product_id"] != product_id]


def set_quantity(
    cart: list[CartItem], product_id: str, quantity: int
) -> list[CartItem]:
    idx = _find_index(cart, product_id)
    if idx is None:
        raise CartError("That item isn't in the cart.")
    if quantity <= 0:
        return remove_item(cart, product_id)
    if quantity > MAX_QUANTITY:
        raise CartError(f"Maximum quantity per item is {MAX_QUANTITY}.")

    new_cart = [dict(item) for item in cart]
    new_cart[idx]["quantity"] = quantity
    return new_cart


def clear(cart: list[CartItem]) -> list[CartItem]:
    return []


def cart_items_total(cart: list[CartItem]) -> float | None:
    """Sum of line totals, or None if any item is missing a unit_price (can't be sure)."""
    total = 0.0
    for item in cart:
        price = item.get("unit_price")
        if price is None:
            return None
        total += price * item["quantity"]
    return total


def compute_suggested_next_step(
    cart: list[CartItem],
    checkout: CheckoutData | None = None,
    delivery_confirmed: bool = False,
    has_fresh_product_cards: bool = False,
) -> SuggestedNextStep | None:
    """Deterministic, rule-based — never left to LLM judgment, so the suggestion always
    matches actual state (and kavi_agent's phrasing can never drift from it).

    has_fresh_product_cards: True when this turn surfaced new product cards (a search
    result or a cross-sell suggestion). A 2+-item cart would otherwise always return
    "proceed_to_checkout", which master_router's disambiguation hint routes an ambiguous
    "yes" to order_agent — wrong when the customer actually meant "yes, add that" in
    reaction to a card just shown. Takes priority over the cart-size check, but never over
    an in-progress checkout (that branch is evaluated first, unconditionally)."""
    # An empty cart has no next step, even if a stale checkout dict is still hanging around
    # (checked first so we never suggest "continue_checkout" with nothing to buy).
    if not cart:
        return None

    if checkout:
        if delivery_confirmed and not get_missing_checkout_fields(checkout):
            return None
        return "continue_checkout"

    if len(cart) >= 2 and not has_fresh_product_cards:
        return "proceed_to_checkout"

    return "add_more"


# product_id prefix -> (search term for the complementary item, display label). Mirrors
# checkout.py's PERISHABLE_PREFIXES trick (CartItem has no clean `category` field). CAKE/
# FLOWER/COMBO prefixes are already trusted via PERISHABLE_PREFIXES; CHOCOLATES/GREETING
# were confirmed live against the real Kapruka MCP server (kapruka_search_products with
# category="Chocolates"/"GreetingCards" returns ids like CHOCOLATES001947/GREETING00Z2857).
COMPLEMENTARY_AFFINITY: dict[str, tuple[str, str]] = {
    "CAKE": ("flowers", "Flowers"),
    "FLOWER": ("chocolates", "Chocolates"),
    "COMBO": ("greeting card", "Greeting Cards"),
    "CHOCOLATES": ("flowers", "Flowers"),
    "GREETING": ("chocolates", "Chocolates"),
}


def find_complementary_suggestion(
    cart: list[CartItem], already_suggested: set[str]
) -> tuple[str, str, str] | None:
    """First cart item whose product_id prefix has a COMPLEMENTARY_AFFINITY entry not
    already in already_suggested. Returns (prefix, search_term, label), or None.

    Deterministic, not LLM-judged — the only way to unit-test the decision and guarantee
    a valid (non-stopword) search term for kapruka_search_products every time."""
    for item in cart:
        product_id = item.get("product_id", "").upper()
        for prefix, (search_term, label) in COMPLEMENTARY_AFFINITY.items():
            if product_id.startswith(prefix) and prefix not in already_suggested:
                return prefix, search_term, label
    return None


def resolve_catalog_item(viewed_products: dict, product_id: str) -> dict | None:
    viewed_products = viewed_products or {}
    
    if product_id in viewed_products:
        return viewed_products[product_id]

    for base_id, detail in viewed_products.items():
        variants = detail.get("variants") or []
        for variant in variants:
            if variant.get("id") == product_id:
                parent_name = detail.get("name", "")
                variant_name = variant.get("name", "")
                images = detail.get("images") or []
                v_price = variant.get("price") or {}
                
                return {
                    "id": product_id,
                    "name": f"{parent_name} ({variant_name})" if variant_name else parent_name,
                    "price": v_price,
                    "images": [images[0]] if images else [],
                    "in_stock": variant.get("in_stock", True),
                }
    return None
