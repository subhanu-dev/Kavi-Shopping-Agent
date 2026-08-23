from langchain_mcp_adapters.client import MultiServerMCPClient
import logging

logger = logging.getLogger(__name__)

mcp_client = None


async def mcp_lifespan(app):
    global mcp_client

    # Initialize MCP client
    mcp_client = MultiServerMCPClient(
        {
            "kapruka": {
                "url": "https://mcp.kapruka.com/mcp",
                "transport": "streamable_http",
                "headers": {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            }
        }
    )

    try:
        # Load tools ONCE at startup
        tools = await mcp_client.get_tools()

        app.state.mcp_client = mcp_client
        app.state.mcp_tools = tools
        logging.debug("connected to MCP")
        logging.info(f"Loaded tools: {len(tools)}")

    except Exception as e:
        logging.error("Failed to initialize MCP: {e}")
        raise
