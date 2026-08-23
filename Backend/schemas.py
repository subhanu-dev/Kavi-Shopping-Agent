"""Shared contracts: cart/checkout shapes, ui_action events, suggested_next_step, and frontend cards.

These are the data shapes every node and endpoint reads/writes — defined once here so
ShoppingState, the cart/checkout tools, and the FastAPI response payloads all agree.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field
from typing_extensions import NotRequired, TypedDict

# =========================
# Cart & checkout shapes (mirror kapruka_create_order's expected payload)
# =========================


class CartItem(TypedDict):
    product_id: str
    name: str
    quantity: int
    image_url: NotRequired[str | None]
    unit_price: NotRequired[float | None]
    currency: NotRequired[str]
    icing_text: NotRequired[str | None]
    in_stock: NotRequired[bool]


class Recipient(TypedDict):
    name: NotRequired[str]
    phone: NotRequired[str]


class Delivery(TypedDict):
    address: NotRequired[str]
    city: NotRequired[str]
    date: NotRequired[str]
    location_type: NotRequired[str]
    instructions: NotRequired[str | None]


class Sender(TypedDict):
    name: NotRequired[str]
    anonymous: NotRequired[bool]


class CheckoutData(TypedDict):
    recipient: NotRequired[Recipient]
    delivery: NotRequired[Delivery]
    sender: NotRequired[Sender]
    gift_message: NotRequired[str | None]


CHECKOUT_REQUIRED_FIELDS = (
    "recipient.name",
    "recipient.phone",
    "delivery.address",
    "delivery.city",
    "delivery.date",
    "sender.name",
)


def get_missing_checkout_fields(checkout: CheckoutData | None) -> list[str]:
    """Deterministic single source of truth for 'what's still needed' — used by
    order_agent (to decide what to ask next) and the checkout form card (to flag
    incomplete fields), so the two never disagree."""
    checkout = checkout or {}
    missing: list[str] = []
    for dotted in CHECKOUT_REQUIRED_FIELDS:
        section, field = dotted.split(".")
        if not checkout.get(section, {}).get(field):
            missing.append(dotted)
    return missing


# =========================
# UI action events (button/form-driven, resumed via master_router)
# =========================

UiActionType = Literal[
    "view_details",
    "add_to_cart",
    "remove_from_cart",
    "update_qty",
    "clear_cart",
    "checkout_form_submit",
    "place_order",
    "track_order_submit",
]

_UI_ACTION_PREFIX = "[ui_action:"


class UiAction(BaseModel):
    action_type: UiActionType
    payload: dict = Field(default_factory=dict)

    def to_event_message(self) -> str:
        return f"{_UI_ACTION_PREFIX}{self.action_type}] {json.dumps(self.payload, default=str)}"


def parse_ui_action_type(content: str) -> str | None:
    """Inverse of UiAction.to_event_message — extract the action type from an event
    message string (e.g. "[ui_action:add_to_cart] {...}" -> "add_to_cart"). Returns None
    for anything that isn't a ui_action message, so the router can fall through to its
    normal LLM routing for typed messages."""
    if not isinstance(content, str) or not content.startswith(_UI_ACTION_PREFIX):
        return None
    inner = content[len(_UI_ACTION_PREFIX) :]
    action_type = inner.split("]", 1)[0].strip()
    return action_type or None


# =========================
# Suggested next step (deterministic, computed in kavi_agent)
# =========================

SuggestedNextStep = Literal[
    "add_more",
    "proceed_to_checkout",
    "continue_checkout",
    "browse_categories",
    "track_order",
]


# =========================
# Frontend-facing cards
# =========================


class searchCard(BaseModel):
    type: Literal["product"] = "product"
    product_id: str
    name: str
    image_url: str | None = None
    price: float | None = None
    compare_at_price: float | None = None
    currency: str = "LKR"
    in_stock: bool = True
    stock_level: str | None = None
    summary: str | None = None
    url: str | None = None


class ProductCard(BaseModel):
    type: Literal["product"] = "product"
    product_id: str
    name: str
    image_url: str | None = None
    price: float | None = None
    compare_at_price: float | None = None
    currency: str = "LKR"
    in_stock: bool = True
    stock_level: str | None = None
    summary: str | None = None
    url: str | None = None


class ProductVariant(BaseModel):
    id: str
    name: str
    sku: str | None = None
    price: float | None = None
    currency: str = "LKR"
    in_stock: bool = True
    stock_level: str | None = None
    attributes: dict = Field(default_factory=dict)


class ProductDetailCard(BaseModel):
    type: Literal["product_detail"] = "product_detail"
    product_id: str
    name: str
    image_url: str | None = None
    price: float | None = None
    compare_at_price: float | None = None
    currency: str = "LKR"
    in_stock: bool = True
    stock_level: str | None = None
    summary: str | None = None
    url: str | None = None
    images: list[str] = Field(default_factory=list)
    variants: list[ProductVariant] = Field(default_factory=list)
    category: str | None = None
    attributes: dict = Field(default_factory=dict)
    shipping: dict | None = None



class CartLineCard(BaseModel):
    product_id: str
    name: str
    image_url: str | None = None
    unit_price: float | None = None
    quantity: int
    line_total: float | None = None
    in_stock: bool = True


class CartSummaryCard(BaseModel):
    type: Literal["cart_summary"] = "cart_summary"
    items: list[CartLineCard] = Field(default_factory=list)
    items_total: float | None = None
    currency: str = "LKR"


class CheckoutFormCard(BaseModel):
    type: Literal["checkout_form"] = "checkout_form"
    fields: CheckoutData
    missing_fields: list[str] = Field(default_factory=list)


class CheckoutConfirmationCard(BaseModel):
    type: Literal["checkout_confirmation"] = "checkout_confirmation"
    checkout_url: str
    order_ref: str
    items_total: float
    delivery_fee: float
    addons_total: float
    grand_total: float
    currency: str = "LKR"
    expires_at: str


class OrderTrackingItem(BaseModel):
    product_id: str
    name: str
    quantity: int = 1
    selling_price: float | None = None


class OrderTrackingCard(BaseModel):
    type: Literal["order_tracking"] = "order_tracking"
    order_number: str
    status: str
    status_display: str
    progress: list[dict] = Field(default_factory=list)
    has_delivery_photo: bool = False
    has_delivery_video: bool = False
    live_tracking_available: bool = False
    order_date: str | None = None        # Raw string from Kapruka e.g. "Tue Jun 23 07:10:46 EDT 2026"
    delivery_date: str | None = None     # Requested delivery date e.g. "24 / JUNE / 2026"
    shipped_date: str | None = None      # Dispatch timestamp e.g. "24 Jun 2026 05:11:27 GMT"
    order_total: float | None = None     # e.g. 26060.0
    order_currency: str = "LKR"
    comments: str | None = None          # Final status note e.g. "Delivery successfully completed."
    items: list[OrderTrackingItem] = Field(default_factory=list)  # What was ordered


class TrackOrderFormCard(BaseModel):
    type: Literal["track_order_form"] = "track_order_form"


Card = (
    ProductCard
    | ProductDetailCard
    | CartSummaryCard
    | CheckoutFormCard
    | CheckoutConfirmationCard
    | OrderTrackingCard
    | TrackOrderFormCard
)
