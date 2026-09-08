# src — two languages, one seam

Two runtimes, and the boundary between them is a protocol rather than a
convention. That is the whole reason the split is tolerable, and it is why the
directories are named for the job rather than the language.

```
        src/graph            Python          LangGraph: the agent
             │
             │   MCP over stdio             ← the seam
             ▼
        src/fixture          Node            Playwright: the browser
```

## Why Python on one side

**LangGraph.** The agent is a graph of deterministic tiers over one model tier,
and LangGraph is the Python library that expresses it. Brian's requirement is
that the run works with any model, which rules out a vendor SDK and lands on
LangChain — and its graph half is Python-first.

## Why Node on the other

**The axe DevTools panel is a Chrome extension's DevTools page**, and driving it
needs a specific, undocumented Playwright path: `PW_CHROMIUM_ATTACH_TO_OTHER`,
`tabbedPane.selectTab`, an ES-module `import()` evaluated inside the DevTools
frontend, and out-of-process iframe input routing. That was proven in JS, and
Deque's own `axe-mcp-server` drives the same panel from Node with the same
environment variable.

`playwright-python` exposes the same API, so this is not a capability argument.
It is a risk one: `src/fixture` is the part of this project that took longest to
make reliable, and a port would re-run that work to remove a boundary the next
section says costs almost nothing.

## Why the seam makes it fine

They meet at **MCP over stdio** — a language-agnostic protocol with a typed tool
contract. That is not a workaround; it is the same interface any other client
would use, and it is what makes the pairing structural rather than accidental:

- **The contract is the tool list, not a shared object model.** Nothing crosses
  the boundary except JSON-RPC calls and results, so neither side can reach into
  the other's internals and neither language constrains the other's design.
- **Either side is replaceable without touching the other.** A Python driver
  would serve the same 17 tools; a different agent framework would call them.
- **The deployable artefact is already one process.** `src/fixture` is what the
  container runs, and it holds the browser, the extension and the policy. The
  Python side is a client — it can run on the host, in another container, or
  anywhere that can spawn `docker run -i`.

## Where the boundary is defined

| | |
|---|---|
| the tool contract | [ticket 011](../wayfinder/tickets/011-tool-inventory.md), plus its amendments |
| the transport decision | [ticket 005](../wayfinder/tickets/005-container-spec.md), §5 |
| what the graph does with the tools | [ticket 013](../wayfinder/tickets/013-agent-graph.md) |

## What is in here

| | |
|---|---|
| `fixture/` | the MCP server that *is* the fixture: launches Chromium, signs in, holds the panel through its lifecycle traps, scans, saves, keeps the session alive, then serves tools |
| `graph/` | the LangGraph run: three deterministic tiers over one model tier, one `bind_tools` per sub-agent |
| `tools/` | build and verification — the pinned-extension build, the issue-mapping checker |
