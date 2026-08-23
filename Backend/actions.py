"""UI-action endpoints (button clicks, form submits) — the non-chat half of the app.

Each endpoint applies a deterministic state mutation, then runs a normal graph turn with a
synthetic [ui_action:...] message (the same `graph.ainvoke(patch, config)` call /chat uses).
master_router sees that message and short-circuits to the right specialist agent without an
LLM call (see agent.py: master_router_node / _UI_ACTION_AGENT), so the specialist actually
runs and reacts in natural language instead of the state being silently mutated.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from langchain_core.messages import HumanMessage
from pydantic import BaseModel

from . import cart as cart_ops
from . import checkout as checkout_ops
from .cards import shape_chat_response
from .cart import CartError
from .chat import GRACEFUL_ERROR_TEXT, MAX_TURN_SECONDS, _repair_thread_state
from .locks import get_thread_lock
from .observability import turn_config
from .schemas import UiAction, UiActionType

logger = logging.getLogger(__name__)

cart_router = APIRouter(prefix="/cart")
checkout_router = APIRouter(prefix="/checkout")
product_router = APIRouter(prefix="/product")
support_router = APIRouter(prefix="/support")
user_router = APIRouter(prefix="/user")


class AddToCartRequest(BaseModel):
    user_id: str
    thread_id: str
    product_id: str
    name: str
    quantity: int = 1
    unit_price: float | None = None
    currency: str = "LKR"
    image_url: str | None = None
    icing_text: str | None = None
    in_stock: bool = True


class RemoveFromCartRequest(BaseModel):
    user_id: str
    thread_id: str
    product_id: str


class UpdateCartQuantityRequest(BaseModel):
    user_id: str
    thread_id: str
    product_id: str
    quantity: int


class ClearCartRequest(BaseModel):
    user_id: str
    thread_id: str


class ViewDetailsRequest(BaseModel):
    user_id: str
    thread_id: str
    product_id: str


class TrackOrderRequest(BaseModel):
    user_id: str
    thread_id: str
    order_id: str


class CheckoutSubmitRequest(BaseModel):
    user_id: str
    thread_id: str
    recipient_name: str | None = None
    recipient_phone: str | None = None
    delivery_address: str | None = None
    delivery_city: str | None = None
    delivery_date: str | None = None
    delivery_location_type: str | None = None
    delivery_instructions: str | None = None
    sender_name: str | None = None
    sender_anonymous: bool | None = None
    gift_message: str | None = None


class CheckDeliveryRequest(BaseModel):
    city: str
    delivery_date: str
    product_id: str | None = None


async def _get_existing_state(graph, config: dict) -> dict:
    snapshot = await graph.aget_state(config)
    if not snapshot.values:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found — start chatting before using this action.",
        )
    return snapshot.values


async def _run_ui_action_turn(
    request: Request,
    user_id: str,
    thread_id: str,
    state_patch: dict,
    action_type: UiActionType,
    payload: dict,
) -> dict:
    graph = request.app.state.shopping_graph
    config = turn_config(
        thread_id, user_id, getattr(request.app.state, "langfuse_handler", None)
    )
    event_message = UiAction(action_type=action_type, payload=payload).to_event_message()

    logger.info(
        f"[ui_action:{action_type}] enter | user_id={user_id} | thread_id={thread_id}"
    )

    async def _run() -> dict:
        # Same call shape as /chat: feed the synthetic event as input and let the graph run
        # from START. master_router_node short-circuits the [ui_action:...] message to the
        # right specialist (no LLM call) — see agent.py: _UI_ACTION_AGENT.
        return await graph.ainvoke(
            {
                "user_id": user_id,
                "messages": [HumanMessage(content=event_message)],
                **state_patch,
            },
            config,
        )

    try:
        # Bounds the whole resume sequence (state patch + graph run) — same MAX_TURN_SECONDS
        # ceiling as /chat, so a stuck turn or an exhausted DB pool fails fast with a
        # friendly message instead of hanging the request (and the per-thread lock) indefinitely.
        result = await asyncio.wait_for(_run(), timeout=MAX_TURN_SECONDS)
    except Exception:
        logger.exception(f"[ui_action:{action_type}] graph invocation failed")
        await _repair_thread_state(graph, config)
        return {
            "user_id": user_id,
            "thread_id": thread_id,
            "text": GRACEFUL_ERROR_TEXT,
            "cards": [],
            "suggested_next_step": None,
            "selected_agent": None,
            "language": None,
        }

    return shape_chat_response(user_id, thread_id, result)


async def _resume_cart_action(
    request: Request,
    user_id: str,
    thread_id: str,
    mutate,
    action_type: UiActionType,
    payload: dict,
    extra_state_patch: dict | None = None,
) -> dict:
    graph = request.app.state.shopping_graph
    config = {"configurable": {"thread_id": thread_id}}

    async with get_thread_lock(thread_id):
        values = await _get_existing_state(graph, config)
        cart = values.get("cart", [])

        # remove_from_cart/update_qty requests only carry product_id (unlike
        # AddToCartRequest, which carries name) — look the name up from the pre-mutation
        # cart so kavi_agent (which now handles these directly, no product_agent draft in
        # between) can name the specific item instead of falling back to "that item".
        existing_item = next(
            (item for item in cart if item.get("product_id") == payload.get("product_id")),
            None,
        )

        try:
            new_cart = mutate(cart)
            event_payload = {**payload, "status": "ok"}
        except CartError as exc:
            new_cart = cart
            event_payload = {**payload, "status": "error", "error": str(exc)}

        if existing_item is not None and "name" not in event_payload:
            event_payload["name"] = existing_item["name"]

        cart_summary = (
            ", ".join(f"{item['name']} x{item['quantity']}" for item in new_cart)
            if new_cart
            else "empty"
        )
        logger.info(
            f"[ui_action:{action_type}] mutation | payload={payload} | "
            f"status={event_payload['status']} | cart={cart_summary}"
            + (
                f" | error={event_payload['error']}"
                if event_payload["status"] == "error"
                else ""
            )
        )

        state_patch = {"cart": new_cart, **(extra_state_patch or {})}
        return await _run_ui_action_turn(
            request, user_id, thread_id, state_patch, action_type, event_payload
        )


@cart_router.post("/add")
async def cart_add(payload: AddToCartRequest, request: Request):
    def mutate(cart):
        return cart_ops.add_item(
            cart,
            product_id=payload.product_id,
            name=payload.name,
            quantity=payload.quantity,
            unit_price=payload.unit_price,
            currency=payload.currency,
            image_url=payload.image_url,
            icing_text=payload.icing_text,
            in_stock=payload.in_stock,
        )

    return await _resume_cart_action(
        request,
        payload.user_id,
        payload.thread_id,
        mutate,
        "add_to_cart",
        {"product_id": payload.product_id, "name": payload.name, "quantity": payload.quantity},
    )


@cart_router.post("/remove")
async def cart_remove(payload: RemoveFromCartRequest, request: Request):
    def mutate(cart):
        return cart_ops.remove_item(cart, payload.product_id)

    return await _resume_cart_action(
        request, payload.user_id, payload.thread_id, mutate, "remove_from_cart", {"product_id": payload.product_id}
    )


@cart_router.post("/update_qty")
async def cart_update_qty(payload: UpdateCartQuantityRequest, request: Request):
    def mutate(cart):
        return cart_ops.set_quantity(cart, payload.product_id, payload.quantity)

    return await _resume_cart_action(
        request,
        payload.user_id,
        payload.thread_id,
        mutate,
        "update_qty",
        {"product_id": payload.product_id, "quantity": payload.quantity},
    )


@cart_router.post("/clear")
async def cart_clear(payload: ClearCartRequest, request: Request):
    def mutate(cart):
        return cart_ops.clear(cart)

    return await _resume_cart_action(
        request,
        payload.user_id,
        payload.thread_id,
        mutate,
        "clear_cart",
        {"cleared": True},
        # Clearing the cart also ends any in-progress checkout (mirrors the clear_cart tool)
        # so the delivery form can't linger over an empty cart. None resets checkout via
        # reduce_checkout.
        extra_state_patch={
            "cross_sold_categories": [],
            "checkout": None,
            "delivery_confirmed": False,
        },
    )


@checkout_router.post("/submit")
async def checkout_submit(payload: CheckoutSubmitRequest, request: Request):
    graph = request.app.state.shopping_graph
    config = {"configurable": {"thread_id": payload.thread_id}}

    async with get_thread_lock(payload.thread_id):
        values = await _get_existing_state(graph, config)
        checkout = values.get("checkout") or {}

        # delivery_city is deliberately NOT merged directly — it must go through
        # check_delivery_for_city's canonical resolution, the same as a typed city would,
        # so a form submission can't bypass that gate. order_agent sees it flagged below
        # and is instructed to resolve it itself.
        patch = {
            "recipient": {"name": payload.recipient_name, "phone": payload.recipient_phone},
            "delivery": {
                "address": payload.delivery_address,
                "date": checkout_ops.normalize_date(payload.delivery_date) or payload.delivery_date,
                "location_type": payload.delivery_location_type,
                "instructions": payload.delivery_instructions,
            },
            "sender": {"name": payload.sender_name, "anonymous": payload.sender_anonymous},
            "gift_message": payload.gift_message,
        }
        new_checkout = checkout_ops.merge_checkout(checkout, patch)

        event_payload = {k: v for k, v in patch.items() if v}
        if payload.delivery_city:
            event_payload["city_to_resolve"] = payload.delivery_city

        logger.info(
            f"[ui_action:checkout_form_submit] mutation | checkout={new_checkout} | "
            f"city_to_resolve={payload.delivery_city}"
        )

        return await _run_ui_action_turn(
            request,
            payload.user_id,
            payload.thread_id,
            {"checkout": new_checkout},
            "checkout_form_submit",
            event_payload,
        )


@checkout_router.post("/check_delivery")
async def checkout_check_delivery(payload: CheckDeliveryRequest, request: Request):
    """Functionally separate from the LLM workflow: checks delivery availability directly."""
    import json
    
    # 1. Get MCP tools
    list_cities_tool = next(t for t in request.app.state.mcp_tools if t.name == "kapruka_list_delivery_cities")
    check_delivery_tool = next(t for t in request.app.state.mcp_tools if t.name == "kapruka_check_delivery")

    def _extract_text(raw) -> str:
        if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "text" in raw[0]:
            return raw[0]["text"]
        if isinstance(raw, str):
            return raw
        return str(raw)

    # 2. Resolve canonical city
    try:
        cities_raw = await list_cities_tool.ainvoke(
            {"params": {"query": payload.city, "response_format": "json"}}
        )
        cities_data = json.loads(_extract_text(cities_raw))
    except Exception as e:
        logger.warning(f"kapruka_list_delivery_cities MCP call failed (non-fatal).", exc_info=True)
        cities_data = {}

    canonical, candidates = checkout_ops.resolve_canonical_city(payload.city, cities_data.get("cities", []))
    if not canonical:
        return {
            "available": False, 
            "message": "City not found or ambiguous.",
            "suggestions": candidates
        }

    # 3. Normalize date
    normalized_date = checkout_ops.normalize_date(payload.delivery_date)
    if not normalized_date:
        return {"available": False, "message": "Invalid date format.", "suggestions": []}

    # 4. Check delivery
    try:
        check_raw = await check_delivery_tool.ainvoke(
            {
                "params": {
                    "city": canonical,
                    "delivery_date": normalized_date,
                    "product_id": payload.product_id,
                    "response_format": "json",
                }
            }
        )
        check_data = json.loads(_extract_text(check_raw))
    except Exception as e:
        logger.warning("kapruka_check_delivery MCP call failed (non-fatal).", exc_info=True)
        return {"available": False, "message": "Delivery check failed.", "suggestions": []}

    return {
        "available": bool(check_data.get("available")),
        "canonical_city": canonical,
        "delivery_date": normalized_date,
        "rate": check_data.get("rate"),
        "reason": check_data.get("reason"),
        "next_available_date": check_data.get("next_available_date"),
        "perishable_warning": check_data.get("perishable_warning"),
        "suggestions": [],
    }


class PlaceOrderRequest(BaseModel):
    user_id: str
    thread_id: str


@checkout_router.post("/place_order")
async def checkout_place_order(payload: PlaceOrderRequest, request: Request):
    """Confirm & place order button — goes straight to the order_agent interceptor.
    No state mutation needed here: order_agent reads cart/checkout/delivery_confirmed
    from the persisted state and gates the actual API call itself."""
    return await _run_ui_action_turn(
        request,
        payload.user_id,
        payload.thread_id,
        {},
        "place_order",
        {},
    )


@support_router.post("/track")
async def support_track(payload: TrackOrderRequest, request: Request):
    logger.info(f"[ui_action:track_order_submit] payload={{'order_id': payload.order_id}}")
    return await _run_ui_action_turn(
        request,
        payload.user_id,
        payload.thread_id,
        {"extracted_order_id": payload.order_id},
        "track_order_submit",
        {"order_id": payload.order_id},
    )


@product_router.post("/details")
async def product_details(payload: ViewDetailsRequest, request: Request):
    logger.info(f"[ui_action:view_details] payload={{'product_id': payload.product_id}}")
    return await _run_ui_action_turn(
        request,
        payload.user_id,
        payload.thread_id,
        {},
        "view_details",
        {"product_id": payload.product_id},
    )


@user_router.get("/{user_id}/history")
async def get_user_history(user_id: str, request: Request, limit: int = 5):
    """Return the user's past orders for the frontend to display in a suggestion card."""
    store = getattr(request.app.state, "store", None)
    if not store:
        raise HTTPException(status_code=500, detail="Store not configured")
    
    try:
        namespace = (user_id, "orders")
        items = await store.asearch(namespace, limit=limit)
        orders = []
        for item in items:
            if item.key == "latest":
                continue
            orders.append(item.value)
            
        # Sort by created_at descending
        orders.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return {"orders": orders}
    except Exception as e:
        logger.error(f"Failed to fetch user history for {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch history")


# Combined router for main.py to mount in one call.
router = APIRouter()
router.include_router(cart_router)
router.include_router(checkout_router)
router.include_router(product_router)
router.include_router(support_router)
router.include_router(user_router)
