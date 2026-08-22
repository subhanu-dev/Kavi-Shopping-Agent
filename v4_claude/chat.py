"""Chat entry points: the buffered /chat endpoint and the SSE /chat/stream endpoint.

Both share the same first-turn personalization (load the returning customer's history
from the cross-thread Store once, on a brand-new thread) and the same graceful
error handling — a customer never sees a raw exception, only a friendly Kavi message.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, RemoveMessage, ToolMessage
from pydantic import BaseModel, Field

from .cards import message_text, shape_chat_response
from .locks import get_thread_lock
from .observability import turn_config
from .personalization import load_user_context

logger = logging.getLogger(__name__)

router = APIRouter()

# Shown verbatim to the customer if the whole turn fails — never a stack trace.
GRACEFUL_ERROR_TEXT = "Aiyo! 😅 Something hiccupped on our side just now. Could you try that again in a moment?"

# Generous upper bound on a single turn (well above every measured total in PERFORMANCE.md,
# including observed spikes to ~34s) — only meant to catch a genuine hang, not normal LLM/MCP
# variance. Bounds how long the per-thread lock (locks.py) and any DB connection a turn holds
# can ever be tied up, instead of relying on the client giving up first.
MAX_TURN_SECONDS = 120

# Friendly, frontend-facing labels for the only nodes a streaming client should hear
# about. Tool nodes (product_tools/order_tools/support_tools) are deliberately absent —
# their internals (raw tool calls/results) must never reach the frontend.
NODE_STATUS = {
    "master_router": "thinking",
    "product_agent": "browsing_products",
    "order_agent": "working_on_checkout",
    "support_agent": "checking_order",
    "kavi_agent": "writing_reply",
}

_TOOL_NODES = {"product_tools", "order_tools", "support_tools"}


def _preview(text: str, limit: int = 500) -> str:
    """Single-line, length-capped view of a user message for logging — so a turn's prompt
    is visible in the logs alongside the agent's actions, without letting a pasted essay
    (or newlines) bloat/break the log line. Customer-entered content; truncation limits how
    much ever lands in the logs."""
    if text is None:
        return ""
    flattened = " ".join(text.split())
    return flattened if len(flattened) <= limit else flattened[:limit] + "…"


class ChatRequest(BaseModel):
    user_id: str
    thread_id: str
    message: str = Field(..., max_length=500)


async def _build_initial_state(graph, store, payload: ChatRequest) -> dict:
    """Graph input for one turn. On the first turn of a brand-new thread, enrich it with
    the customer's cross-thread history (orders/searches) so the agents can personalize;
    on later turns that context is already carried in checkpointed state, so we don't
    re-query the Store."""
    state: dict = {
        "messages": [{"role": "user", "content": payload.message}],
        "user_id": payload.user_id,
    }

    try:
        _t = time.monotonic()
        snapshot = await graph.aget_state(
            {"configurable": {"thread_id": payload.thread_id}}
        )
        logger.info(f"[timing] aget_state ms={(time.monotonic() - _t) * 1000:.0f}")
        is_first_turn = not snapshot.values
    except Exception:
        # If we can't tell, treat it as not-first — worst case we skip a welcome-back,
        # never a crash.
        logger.warning(
            "Could not read thread state for first-turn check.", exc_info=True
        )
        is_first_turn = False

    if is_first_turn:
        ctx = await load_user_context(store, payload.user_id)
        if ctx:
            state["user_context"] = ctx
            logger.info(
                f"[chat] loaded returning-customer context for user_id={payload.user_id}"
            )

    return state


# =========================
# Buffered response endpoint
# =========================

# @router.post("/chat")
# async def chat(payload: ChatRequest, request: Request):
#     graph = request.app.state.shopping_graph
#     store = getattr(request.app.state, "store", None)
#     config = turn_config(
#         payload.thread_id,
#         payload.user_id,
#         getattr(request.app.state, "langfuse_handler", None),
#     )

#     logger.info(
#         f"[/chat] enter | user_id={payload.user_id} | thread_id={payload.thread_id} | "
#         f"message={_preview(payload.message)}"
#     )
#     _turn_start = time.monotonic()

#     async with get_thread_lock(payload.thread_id):
#         try:
#             initial_state = await _build_initial_state(graph, store, payload)
#             result = await asyncio.wait_for(
#                 graph.ainvoke(initial_state, config=config), timeout=MAX_TURN_SECONDS
#             )
#         except Exception:
#             logger.exception("[/chat] graph invocation failed")
#             return {
#                 "user_id": payload.user_id,
#                 "thread_id": payload.thread_id,
#                 "text": GRACEFUL_ERROR_TEXT,
#                 "cards": [],
#                 "suggested_next_step": None,
#                 "selected_agent": None,
#                 "language": None,
#             }

#     logger.info(
#         f"[timing] endpoint=/chat total_ms={(time.monotonic() - _turn_start) * 1000:.0f} | "
#         f"thread_id={payload.thread_id}"
#     )
#     return shape_chat_response(payload.user_id, payload.thread_id, result)


# =========================
# Streaming (SSE) endpoint
# =========================


def _sse(event: dict) -> str:
    """One Server-Sent Event frame. Each event is a self-describing JSON object with an
    `event` field the frontend switches on (status | token | final | error)."""
    return f"data: {json.dumps(event, default=str)}\n\n"


async def _repair_thread_state(graph, config: dict) -> None:
    """Heal corrupt message history so the next turn on this thread doesn't hit a
    provider 400 forever.

    Two cases handled:
    1. Dangling tool call — turn died after the AI issued tool_calls but before the
       result arrived: strip tool_calls so the provider sees a plain AI message.
    2. Orphaned tool result — a previous repair stripped tool_calls from message N
       while the in-flight MCP call later appended a ToolMessage at N+1. The provider
       rejects this because the ToolMessage has no preceding tool_calls. Remove it.
    """
    try:
        snapshot = await graph.aget_state(config)
    except Exception:
        return
    messages = snapshot.values.get("messages") or []
    if not messages:
        return
    last = messages[-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        await graph.aupdate_state(
            config,
            {"messages": [AIMessage(id=last.id, content=last.content, tool_calls=[])]},
        )
    elif isinstance(last, ToolMessage) and len(messages) >= 2:
        prev = messages[-2]
        if not (isinstance(prev, AIMessage) and prev.tool_calls):
            await graph.aupdate_state(
                config,
                {"messages": [RemoveMessage(id=last.id)]},
            )


@router.post("/chat/stream")
async def chat_stream(payload: ChatRequest, request: Request):
    """SSE stream. Emits:
      - {event: "status", agent, status}  — lightweight progress, one per node entered
      - {event: "token", text}            — incremental text of the FINAL reply only
      - {event: "final", cards, suggested_next_step, selected_agent, language}
      - {event: "error", text}            — graceful failure

    Crucially, only kavi_agent's tokens are streamed as `token` events — the specialist
    agents' private drafts and every raw tool call/result are filtered out, so the
    frontend only ever sees the polished, user-facing reply, never internal reasoning.
    """
    graph = request.app.state.shopping_graph
    store = getattr(request.app.state, "store", None)
    config = turn_config(
        payload.thread_id,
        payload.user_id,
        getattr(request.app.state, "langfuse_handler", None),
    )

    logger.info(
        f"[/chat/stream] enter | user_id={payload.user_id} | thread_id={payload.thread_id} | "
        f"message={_preview(payload.message)}"
    )

    async def event_generator():
        _turn_start = time.monotonic()
        _first_token_logged = False
        async with get_thread_lock(payload.thread_id):
            cards: list[dict] = []
            suggested_next_step = None
            selected_agent = None
            language = None

            try:
                # Immediate ack so the frontend can show "Kavi is thinking…" right away —
                # otherwise the first byte only arrives after the router's LLM call returns,
                # since stream_mode="updates" emits a node's event only once it has finished.
                yield _sse(
                    {"event": "status", "agent": "master_router", "status": "received"}
                )

                initial_state = await _build_initial_state(graph, store, payload)

                # Manual iteration (instead of a plain `async for`) so each individual
                # "wait for the next chunk" pull is itself time-boxed to the remaining
                # turn budget. A plain per-chunk check inside the loop body wouldn't catch
                # a hang inside a single node whose model call never streams an
                # intermediate token (e.g. master_router's structured-output call) — this
                # bounds the wait regardless of where the stall is.
                stream_iter = graph.astream(
                    initial_state,
                    config=config,
                    stream_mode=["updates", "messages"],
                ).__aiter__()
                while True:
                    remaining = MAX_TURN_SECONDS - (time.monotonic() - _turn_start)
                    if remaining <= 0:
                        raise TimeoutError(f"Turn exceeded {MAX_TURN_SECONDS}s")
                    try:
                        mode, chunk = await asyncio.wait_for(
                            stream_iter.__anext__(), timeout=remaining
                        )
                    except StopAsyncIteration:
                        break

                    if mode == "updates":
                        for node_name, update in (chunk or {}).items():
                            if node_name in _TOOL_NODES:
                                continue  # never leak raw tool internals to the frontend
                            status = NODE_STATUS.get(node_name)
                            if status:
                                yield _sse(
                                    {
                                        "event": "status",
                                        "agent": node_name,
                                        "status": status,
                                    }
                                )
                            if not update:
                                continue
                            if update.get("selected_agent"):
                                selected_agent = update["selected_agent"]
                            if update.get("language"):
                                language = update["language"]
                            if node_name == "kavi_agent":
                                cards = update.get("cards", cards)
                                suggested_next_step = update.get(
                                    "suggested_next_step", suggested_next_step
                                )

                    elif mode == "messages":
                        message_chunk, metadata = chunk
                        node_name = metadata.get("langgraph_node")
                        
                        if node_name != "kavi_agent":
                            # Intercept tool calls from specialist agents to emit rich UI status updates
                            for call in getattr(message_chunk, "tool_calls", []) or []:
                                t_name = call.get("name")
                                args = call.get("args", {})
                                if t_name == "kapruka_search_products":
                                    q = args.get("q", "items")
                                    yield _sse({"event": "status", "agent": node_name, "status": f"Searching for '{q}'..."})
                                elif t_name == "kapruka_get_product":
                                    yield _sse({"event": "status", "agent": node_name, "status": "Loading product details..."})
                                elif t_name in ("add_to_cart", "remove_from_cart", "update_cart_quantity", "clear_cart"):
                                    yield _sse({"event": "status", "agent": node_name, "status": "Updating your cart..."})
                                elif t_name == "check_delivery_for_city":
                                    city = args.get("city", "your city")
                                    yield _sse({"event": "status", "agent": node_name, "status": f"Checking delivery availability for {city}..."})
                                elif t_name == "kapruka_track_order":
                                    ref = args.get("order_number", "your order")
                                    yield _sse({"event": "status", "agent": node_name, "status": f"Looking up order {ref}..."})
                                elif t_name == "place_order":
                                    yield _sse({"event": "status", "agent": node_name, "status": "Placing your order..."})
                            continue

                        text = message_text(getattr(message_chunk, "content", ""))
                        if text:
                            if not _first_token_logged:
                                logger.info(
                                    f"[timing] endpoint=/chat/stream ttft_ms="
                                    f"{(time.monotonic() - _turn_start) * 1000:.0f}"
                                )
                                _first_token_logged = True
                            yield _sse({"event": "token", "text": text})

                final_state = await graph.aget_state(config)
                cart = final_state.values.get("cart", [])

                yield _sse(
                    {
                        "event": "final",
                        "user_id": payload.user_id,
                        "thread_id": payload.thread_id,
                        "cards": cards,
                        "cart": cart,
                        "suggested_next_step": suggested_next_step,
                        "selected_agent": selected_agent,
                        "language": language,
                    }
                )
                logger.info(
                    f"[timing] endpoint=/chat/stream total_ms="
                    f"{(time.monotonic() - _turn_start) * 1000:.0f} | thread_id={payload.thread_id}"
                )

            except Exception:
                logger.exception("[/chat/stream] streaming failed")
                await _repair_thread_state(graph, config)
                yield _sse({"event": "error", "text": GRACEFUL_ERROR_TEXT})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
