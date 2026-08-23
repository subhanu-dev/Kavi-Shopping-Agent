"""Kavi's Picks — standalone bestseller carousel endpoint.

Completely outside the LangGraph chat flow: fetches kapruka_search_products
directly from the raw MCP tool, formats results as ProductCard[], and caches
for 4 hours (bestsellers change on the scale of hours, not seconds, and the
query is always identical so every user would hit the same MCP call without caching).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Request
from langchain_core.messages import HumanMessage
from pydantic import BaseModel

from .cards import (
    _is_storefront_result,
    _product_card_from_search_result,
    shape_chat_response,
)
from .chat import GRACEFUL_ERROR_TEXT, MAX_TURN_SECONDS, _repair_thread_state
from .locks import get_thread_lock
from .observability import turn_config
from .personalization import load_user_context

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 4 * 60 * 60  # 4 hours

_picks_cache: list[dict] | None = None
_picks_cache_time: float = 0.0

_dynamic_picks_cache: dict[str, tuple[float, list[dict]]] = {}
_DYNAMIC_CACHE_TTL = 60 * 60  # 1 hour



async def _fetch_picks(mcp_tools: list, query: str = "bestsellers") -> list[dict]:
    tool = next((t for t in mcp_tools if t.name == "kapruka_search_products"), None)
    if tool is None:
        logger.warning("[picks] kapruka_search_products tool not found in mcp_tools")
        return []

    start = time.monotonic()
    # Sort by relevance if it's a specific search, bestseller if it's the fallback
    sort_order = "bestseller" if query == "bestsellers" else "relevance"
    raw = await tool.ainvoke(
        {
            "params": {
                "q": query,
                "sort": sort_order,
                "limit": 10,
                "in_stock_only": True,
                "response_format": "json",
            }
        }
    )
    elapsed_ms = (time.monotonic() - start) * 1000
    logger.info(f"[timing] mcp=picks_fetch ms={elapsed_ms:.0f}")

    try:
        data = json.loads(raw[0]["text"])
        results = [
            r for r in data.get("results", []) if not _is_storefront_result(r)
        ]
        return [_product_card_from_search_result(item).model_dump() for item in results]
    except Exception:
        logger.warning("[picks] failed to parse MCP search results", exc_info=True)
        return []


picks_router = APIRouter(prefix="/products")


@picks_router.get("/picks")
async def get_picks(request: Request, user_id: str | None = None, thread_id: str | None = None) -> dict:
    """Return up to 10 bestseller product cards for the Kavi's Picks sidebar.

    Cached for 4 hours — returns stale cache on MCP error rather than failing.
    If user_id or thread_id is provided, fetches dynamic picks based on recent searches.
    Response: {"picks": [ProductCard, ...]}
    """
    global _picks_cache, _picks_cache_time, _dynamic_picks_cache

    searches = []
    direct_tool_result_cards = None
    
    # Check thread state for current searches and existing tool results
    if thread_id:
        graph = getattr(request.app.state, "shopping_graph", None)
        if graph:
            try:
                snapshot = await graph.aget_state({"configurable": {"thread_id": thread_id}})
                if snapshot and snapshot.values and "messages" in snapshot.values:
                    messages = snapshot.values["messages"]
                    
                    # Look backwards for kapruka_search_products ToolMessages and AIMessage tool calls
                    for msg in reversed(messages):
                        if getattr(msg, "name", None) == "kapruka_search_products" and not direct_tool_result_cards:
                            if hasattr(msg, "content") and isinstance(msg.content, str):
                                try:
                                    data = json.loads(msg.content)
                                    results = [r for r in data.get("results", []) if not _is_storefront_result(r)]
                                    if results:
                                        direct_tool_result_cards = [_product_card_from_search_result(item).model_dump() for item in results[:10]]
                                        logger.info("[picks] using results directly from recent ToolMessage")
                                except Exception:
                                    pass

                        if hasattr(msg, "tool_calls") and msg.tool_calls:
                            for tc in msg.tool_calls:
                                if tc.get("name") == "kapruka_search_products":
                                    q = tc.get("args", {}).get("q")
                                    if q and q not in searches:
                                        searches.append(q)
            except Exception:
                logger.warning("[picks] Failed to read thread state for dynamic picks", exc_info=True)

    # Check user context for past searches
    if user_id:
        store = getattr(request.app.state, "store", None)
        if store is not None:
            try:
                ctx = await load_user_context(store, user_id)
                if ctx and ctx.get("recent_searches"):
                    for q in ctx["recent_searches"]:
                        if q not in searches:
                            searches.append(q)
            except Exception:
                logger.warning("[picks] Failed to load user context for dynamic picks", exc_info=True)

    # Dynamic picks based on the most recent search
    if searches:
        query = searches[0]
        
        # 1. First, if we got cards straight from the chat's tool result, use them! (Zero network calls)
        if direct_tool_result_cards:
            return {"picks": direct_tool_result_cards}
            
        # 2. Check the dynamic cache
        now = time.monotonic()
        cached = _dynamic_picks_cache.get(query)
        if cached and (now - cached[0]) < _DYNAMIC_CACHE_TTL:
            logger.info(f"[picks] dynamic cache hit for: {query}")
            return {"picks": cached[1]}
            
        # 3. Otherwise, fetch it from MCP and cache it
        logger.info(f"[picks] Found recent search: {query} — fetching dynamic picks")
        try:
            cards = await _fetch_picks(request.app.state.mcp_tools, query=query)
            if cards:
                _dynamic_picks_cache[query] = (now, cards)
                return {"picks": cards}
        except Exception:
            logger.warning("[picks] Dynamic MCP fetch failed, falling back to bestsellers", exc_info=True)

    # Fallback to general bestsellers
    now = time.monotonic()
    if _picks_cache is not None and (now - _picks_cache_time) < _CACHE_TTL_SECONDS:
        logger.info("[picks] cache hit (fallback)")
        return {"picks": _picks_cache}

    logger.info("[picks] cache miss — fetching bestsellers from MCP (fallback)")
    try:
        cards = await _fetch_picks(request.app.state.mcp_tools, query="bestsellers")
    except Exception:
        logger.warning("[picks] MCP fetch failed, returning stale/empty", exc_info=True)
        cards = _picks_cache or []

    if cards:
        _picks_cache = cards
        _picks_cache_time = now

    return {"picks": cards}


class SelectPickRequest(BaseModel):
    user_id: str
    thread_id: str
    product_id: str
    name: str


@picks_router.post("/select")
async def select_pick(payload: SelectPickRequest, request: Request) -> dict:
    """Kavi's Picks card click — opens a natural conversation turn for the chosen product.

    Injects a real human message ("Tell me more about {name}") into the thread so it shows
    up in chat history like the customer typed it, and sets `pending_product_view` so the
    router goes straight to product_agent (no LLM routing call) and product_agent fetches
    that exact verified product_id via kapruka_get_product. Works on a brand-new thread —
    graph.ainvoke creates it implicitly, no prior state needed.

    Returns the standard chat response shape (text + cards incl. the product_detail card).
    """
    graph = request.app.state.shopping_graph
    config = turn_config(
        payload.thread_id,
        payload.user_id,
        getattr(request.app.state, "langfuse_handler", None),
    )
    message = f"Tell me more about {payload.name}."

    logger.info(
        f"[/products/select] enter | user_id={payload.user_id} | "
        f"thread_id={payload.thread_id} | product_id={payload.product_id}"
    )

    async with get_thread_lock(payload.thread_id):
        initial_state: dict = {
            "user_id": payload.user_id,
            "messages": [HumanMessage(content=message)],
            "pending_product_view": payload.product_id,
        }

        # If a returning customer's very first interaction is a pick click (brand-new
        # thread), seed user_context here — otherwise it's lost for the whole thread, since
        # /chat's first-turn loader only fires when the thread has no prior state and this
        # turn will already have populated it. Mirrors chat.py:_build_initial_state.
        store = getattr(request.app.state, "store", None)
        if store is not None:
            try:
                snapshot = await graph.aget_state(
                    {"configurable": {"thread_id": payload.thread_id}}
                )
                if not snapshot.values:
                    ctx = await load_user_context(store, payload.user_id)
                    if ctx:
                        initial_state["user_context"] = ctx
            except Exception:
                logger.warning(
                    "[/products/select] first-turn context load skipped", exc_info=True
                )

        try:
            result = await asyncio.wait_for(
                graph.ainvoke(initial_state, config),
                timeout=MAX_TURN_SECONDS,
            )
        except Exception:
            logger.exception("[/products/select] graph invocation failed")
            await _repair_thread_state(graph, config)
            return {
                "user_id": payload.user_id,
                "thread_id": payload.thread_id,
                "text": GRACEFUL_ERROR_TEXT,
                "cards": [],
                "cart": [],
                "suggested_next_step": None,
                "selected_agent": None,
                "language": None,
            }

    return shape_chat_response(payload.user_id, payload.thread_id, result)


router = APIRouter()
router.include_router(picks_router)
