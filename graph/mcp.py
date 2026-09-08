"""One MCP client for the whole run.

Stated because getting it wrong is catastrophic and easy: **the server is the
fixture**, so a per-agent MCP session would launch a browser, mint a session and
run a scan per sub-agent. One client, one stdio session, one browser, for the
life of the run. Per-unit narrowing is a filter over that one tool list, never a
second connection.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools

REPO = Path(__file__).resolve().parent.parent


def server_command() -> dict[str, Any]:
    extension = os.environ.get("AXE_EXTENSION_DIR", str(REPO / "build" / "axe-extension"))
    url = os.environ.get("AXE_TARGET_URL", "http://127.0.0.1:8731/")
    args = [str(REPO / "fixture" / "mcp-server.js"), f"--extension={extension}", f"--url={url}"]
    if name := os.environ.get("AXE_TEST_NAME"):
        args.append(f"--name={name}")
    if os.environ.get("AXE_HEADED") == "1":
        args.append("--headed")
    return {
        "transport": "stdio",
        "command": os.environ.get("AXE_NODE", "node"),
        "args": args,
        "env": dict(os.environ),
        "cwd": str(REPO),
    }


def build_client() -> MultiServerMCPClient:
    return MultiServerMCPClient({"axe": server_command()})


def open_session(client: MultiServerMCPClient):
    """One stdio session, held open for the life of the run.

    `client.get_tools()` is the wrong door here: it opens a **new session per
    tool call**, and a new session against this server means a new browser, a
    new login, a new scan and a new saved test. Every tool must come off one
    live session.
    """
    return client.session("axe")


async def tools_for(session) -> list[BaseTool]:
    return await load_mcp_tools(session)


def unwrap(raw: Any) -> dict[str, Any]:
    """Every tool answers with one JSON envelope, and images ride beside it.

    A tool that raised inside the server is already an `ok: false` envelope by
    the time it gets here; anything this cannot parse is reported as one rather
    than propagated as an exception, because no tool result may end a run.
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (list, tuple)):
        for block in raw:
            if isinstance(block, dict) and block.get("type") == "text":
                return unwrap(block.get("text", ""))
            if isinstance(block, str):
                return unwrap(block)
        return {"ok": False, "error": "rejected", "detail": "no text content in the result"}
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"ok": False, "error": "rejected", "detail": raw[:400]}
    return {"ok": False, "error": "rejected", "detail": f"unreadable result of type {type(raw)}"}


async def call(tools: dict[str, BaseTool], name: str, **args: Any) -> dict[str, Any]:
    """A parent-tier tool call: an ordinary coroutine, with no model anywhere near it."""
    tool = tools.get(name)
    if tool is None:
        return {"ok": False, "error": "not_found", "detail": f"the server does not serve {name}"}
    try:
        return unwrap(await tool.ainvoke(args))
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": "panel_unavailable", "detail": str(error), "retryable": True}
