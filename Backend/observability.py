"""Langfuse tracing wiring — additive to the existing [timing] logs / log_node.

Attaches a Langfuse callback handler to each graph-turn invocation; LangGraph
propagates the run config (callbacks + metadata) down to every node, LLM, and tool
run, so no per-node wiring in agent.py is needed. thread_id maps to a Langfuse
session, user_id to a Langfuse user.

No-ops cleanly when the LANGFUSE_* env vars are absent (local dev) — `turn_config`
then returns exactly the plain {"configurable": {"thread_id": ...}} used before.
"""

import logging
import os

logger = logging.getLogger(__name__)


def langfuse_configured() -> bool:
    return bool(os.getenv("LANGFUSE_PUBLIC_KEY") and os.getenv("LANGFUSE_SECRET_KEY"))


def build_langfuse_handler():
    """One shared, process-wide handler (stored on app.state). Returns None when keys
    are unset or init fails — callers gate on that. Never calls auth_check() (it can
    raise when keys are absent)."""
    if not langfuse_configured():
        logger.info("[langfuse] keys not set — tracing disabled (no-op).")
        return None
    try:
        from langfuse.langchain import CallbackHandler

        handler = CallbackHandler()
        logger.info(
            "[langfuse] tracing enabled host=%s", os.getenv("LANGFUSE_HOST", "default")
        )
        return handler
    except Exception:
        logger.exception("[langfuse] init failed — continuing without tracing.")
        return None


def turn_config(thread_id: str, user_id: str, handler=None) -> dict:
    """Build the per-turn run config. With a handler, attaches the Langfuse callback and
    maps thread_id->session_id / user_id->user_id via run-config metadata (Langfuse v3).
    Without one, returns the same plain config used before Langfuse existed."""
    config: dict = {"configurable": {"thread_id": thread_id}}
    if handler is not None:
        config["callbacks"] = [handler]
        config["metadata"] = {
            "langfuse_session_id": thread_id,
            "langfuse_user_id": user_id,
        }
    return config


def flush_langfuse() -> None:
    """Drain batched traces on shutdown so a Railway redeploy (SIGTERM) doesn't lose the
    last batch. No-ops when tracing is off."""
    if not langfuse_configured():
        return
    try:
        from langfuse import get_client

        get_client().flush()
        logger.info("[langfuse] flushed pending traces.")
    except Exception:
        logger.exception("[langfuse] flush failed.")
