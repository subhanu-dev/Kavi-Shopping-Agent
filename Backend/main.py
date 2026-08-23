from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from dotenv import load_dotenv
import logging
import json
import os
import sys

# Checkpointer + cross-thread store, sharing one Postgres connection pool
from psycopg_pool import AsyncConnectionPool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres.aio import AsyncPostgresStore


load_dotenv()

from v4_claude.mcp_client import mcp_lifespan
import v4_claude.chat as chat
import v4_claude.actions as actions
import v4_claude.picks as picks
from v4_claude.agent import build_shopping_graph
from v4_claude.observability import build_langfuse_handler, flush_langfuse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    stream=sys.stdout,
)

NOISY = (
    "httpx",
    "mcp",
    "mcp.client.streamable_http",
    "mcp.client.stdio",
    "langchain",
    "langchain_mcp_adapters",
    "langgraph.checkpoint.postgres",
    "langgraph.store.postgres",
    "psycopg",
    "psycopg_pool",
)

for name in NOISY:
    logging.getLogger(name).setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await mcp_lifespan(app)

    category_tool = next(
        t for t in app.state.mcp_tools if t.name == "kapruka_list_categories"
    )

    raw_categories = await category_tool.ainvoke(
        {"params": {"depth": 1, "response_format": "json"}}
    )

    json_str = raw_categories[0]["text"]
    data = json.loads(json_str)

    # extract only the category names
    names = [item["name"] for item in data.get("categories", [])]

    # Initialize Checkpointer in Postgress
    # checkpointer = InMemorySaver()
    # Database connection setup for postgress
    # DB_URI = os.getenv("PUBLIC_DB_URL")
    DB_URI = os.getenv("DATABASE_URL")

    pool = AsyncConnectionPool(
        conninfo=DB_URI,
        min_size=2,  # warm connections ready immediately
        max_size=40,  # Railway allows up to 100; this leaves headroom before our own pool
        # becomes the bottleneck (raised from 20 after a live exhaustion incident)
        max_idle=300,  # recycle connections idle longer than this (seconds)
        timeout=8.0,  # how long a request waits for a free connection (default 30.0) — fail
        # fast and surface a graceful error instead of stacking multiple 30s
        # waits across a single turn's several DB round-trips
        kwargs={
            "autocommit": True,
            "prepare_threshold": None,
        },
        open=False,  # we open manually so errors surface cleanly
        check=AsyncConnectionPool.check_connection,
    )

    try:
        await pool.open()
    except Exception:
        logger.exception("Failed to open Postgres connection pool.")
        raise

    checkpointer = AsyncPostgresSaver(pool)
    await checkpointer.setup()

    # Cross-thread memory (orders/searches per user_id) — shares the same pool as the
    # checkpointer rather than opening a second one, to stay within Railway's connection limits.
    store = AsyncPostgresStore(pool)
    await store.setup()

    shopping_graph = build_shopping_graph(
        mcp_tools=app.state.mcp_tools,
        checkpointer=checkpointer,
        store=store,
        categories=names,
    )

    app.state.checkpointer = checkpointer
    app.state.store = store
    app.state.shopping_graph = shopping_graph
    app.state.langfuse_handler = build_langfuse_handler()

    logger.info("Shopping graph initialized and stored in app.state")

    yield

    flush_langfuse()
    await pool.close()


app = FastAPI(
    title="Kapruka Shopping Agent API",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        # Local development — all variants the browser may use
        "http://localhost:5000",
        "http://127.0.0.1:5000",
        "http://[::1]:5000",
        # Production
        "https://kapruka.axisdatatech.com",
        "https://kapruka-ai-agent-frontend.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(actions.router)
app.include_router(picks.router)


@app.get("/")
def read_root():
    return {"message": "Welcome to the Kapruka Shopping Agent API!"}


@app.get("/health")
def health_check():
    print()
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
