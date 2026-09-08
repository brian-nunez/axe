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
import pathlib
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools

# src/graph/<file> -> the repository root is two levels up.
REPO = Path(__file__).resolve().parents[2]


def server_command() -> dict[str, Any]:
    """How the graph starts the MCP server that is the fixture.

    Two shapes, one transport. `AXE_FIXTURE=docker` runs the built image with
    `docker run -i`, which is what ticket 005 settled: the container holds the
    browser, the extension and the pinned policy, and speaks JSON-RPC over the
    stdio it was started on. Anything else runs `node` against the working tree,
    which is faster to iterate on and needs no rebuild.

    The container is the deployable artefact. The host path is a development
    convenience, and the two are not interchangeable — only the container
    carries the managed policy, so only the container reflects production
    settings.
    """
    url = os.environ.get("AXE_TARGET_URL", "http://127.0.0.1:8731/")
    name = os.environ.get("AXE_TEST_NAME")
    headed = os.environ.get("AXE_HEADED") == "1"

    if os.environ.get("AXE_FIXTURE", "host") == "docker":
        image = os.environ.get("AXE_IMAGE", "axedevtools-fixture:005")
        runs = pathlib.Path(os.environ.get("AXE_RUNS_DIR", REPO / "build" / "runs")).resolve()
        runs.mkdir(parents=True, exist_ok=True)
        args = ["run", "--rm", "-i", "--env-file", str(REPO / ".env")]
        for var in ("AXE_TARGET_URL", "AXE_TEST_NAME", "AXE_HEADED",
                    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"):
            if os.environ.get(var):
                args += ["-e", f"{var}={os.environ[var]}"]

        # A CA bundle is a host path, and passing the variable without the file
        # gives Node a path it cannot read — which it reports as a warning and
        # then proceeds without the certificate, so an internal TLS endpoint
        # fails later and somewhere else. Mount the file, then point at it.
        if bundle := os.environ.get("NODE_EXTRA_CA_CERTS"):
            source = pathlib.Path(bundle).expanduser()
            if source.is_file():
                args += ["-v", f"{source.resolve()}:/etc/ssl/certs/corp-ca.pem:ro"]
                args += ["-e", "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem"]
        # The target may be served on the host; a container reaches it by name.
        args += ["--add-host", "host.docker.internal:host-gateway"]
        # The watch console is opt-in: publishing a port and running x11vnc
        # costs nothing when nobody is looking, but a port bound by default is
        # a surprise. Setting a password is the opt-in, and it binds to
        # loopback so the console is never reachable off this machine.
        if password := os.environ.get("AXE_VNC_PASSWORD"):
            port = os.environ.get("AXE_VNC_PORT", "6080")
            args += ["-e", f"AXE_VNC_PASSWORD={password}"]
            args += ["-p", f"127.0.0.1:{port}:6080"]
        args += ["-e", f"AXE_IMAGE_REF={image}"]
        args += ["-v", f"{runs}:/opt/axe/runs"]
        args.append(image)
        return {
            "transport": "stdio",
            "command": os.environ.get("AXE_DOCKER", "docker"),
            "args": args,
            "env": dict(os.environ),
            "cwd": str(REPO),
        }

    extension = os.environ.get("AXE_EXTENSION_DIR", str(REPO / "build" / "axe-extension"))
    args = [str(REPO / "fixture" / "mcp-server.js"), f"--extension={extension}", f"--url={url}"]
    if name:
        args.append(f"--name={name}")
    if headed:
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
