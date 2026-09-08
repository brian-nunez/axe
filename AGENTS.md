# Working in this repo

An agent that audits a page state for accessibility by driving the axe DevTools extension, so a human reviews findings instead of producing them.

## Read in this order

1. **[CONTEXT.md](CONTEXT.md)** — why this exists, the governing constraint, the licence posture, and every design rule. *What we have* is settled fact: do not question it and do not ask about anything it already states.
2. **[wayfinder/MAP.md](wayfinder/MAP.md)** — one line per decision, linking the ticket that holds the detail.
3. **[wayfinder/tickets/](wayfinder/tickets/)** — the reasoning. A ticket's Resolution is the single source of truth for its decision; several carry amendments from later tickets that found them wrong.
4. **[reference/README.md](reference/README.md)** — Deque's own material: the 16 page state tests, and the hand-built mapping from checklist branches to catalog entries.

Do not re-derive research these hold. Several tickets are *corrections* to earlier ones — read a ticket's amendments before trusting its body.

**Everything here was measured against `axe.deque.com` on a free trial account.** [MIGRATION.md](MIGRATION.md) is the runbook onto the enterprise instance, and until it is done no measurement in this repo describes the real one.

## Running it

```bash
make v0             # both units against the bundled target, with the model
make v0-scripted    # the same graph with a scripted leaf — deterministic ground truth
make igt            # the Structure IGT alone, no model, no graph
make check-mapping  # verify the mapping against the checklist, catalog and skills/
make help           # everything else
```

Anything touching credentials runs as `sh -c 'set -a && . ./.env && set +a && <command>'`.

**Python goes through `uv`, never bare `python3`.** `pyproject.toml` plus `uv.lock` pin the graph's dependencies and their whole transitive tree; `.python-version` pins the interpreter. The graph runs under `uv run`, which resolves against whatever index the environment names — `UV_INDEX`, `UV_DEFAULT_INDEX` and the proxy variables are respected rather than overridden. **`uv.lock` in this repo was resolved against public PyPI**, so on a network with a corporate index, run `uv lock` once and commit the result: the URLs it records must be reachable from where the build runs, and `--frozen` would insist on the wrong ones. The stdlib-only scripts — the extension build, the policy renderer, the provenance writer, the target server — run under `uv run --no-project`, which skips the sync. The container sets `UV_PYTHON_DOWNLOADS=never` and uses its own `python3`: it holds no graph and no dependencies, so fetching an interpreter at build time would be a network reach a locked-down build host would fail on. `make image` forwards `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NPM_CONFIG_REGISTRY` and `NODE_EXTRA_CA_CERTS` from the environment as build args — they are args and not baked values, so the image carries no proxy URL and no credentials.

## Operating rules

These cost hours to learn. Each one has a scar.

**One model runtime, one Deque account, one browser at a time.** Docker Model Runner serves a single llama.cpp instance and `.env` holds one login. Two `make v0` runs on this host contend, and contention does not look like contention — it looks like a unit stalling for forty minutes with no error. **Before any measured run, check nothing else is running:** `pgrep -f graph.run`. Peer Claude sessions on this repo count.

**A `make v0` run outlasts a 600s foreground timeout.** Background it and watch for a condition, or it gets moved out from under you mid-run.

**Clean up every watcher you arm.** A background wait loop whose parent agent exits keeps polling forever — seven of them once ran for nine hours against a log nothing was writing any more. If you arm one, kill it. If you find one, kill it.

**Never refresh or close the extension.** Refreshing does *not* destroy the saved test — it orphans the panel, which then accepts a complete Add Manual Issue flow, reports no error, and silently drops it. `chrome.runtime.id` reading `null` is the only tell.

**Git is read-only.** Commits, branches and pushes are Brian's to run. Never `git commit`, `git push`, or `git checkout`.

**Production-ready only.** No stubs, no placeholders, no TODO comments, no illustrative examples.

## Where things live

| Path | What |
|---|---|
| `fixture/` | the MCP server that *is* the fixture — launches the browser, logs in, holds the panel, scans, saves, keeps the session alive, then serves tools |
| `graph/` | LangGraph. Three deterministic tiers over one model tier; only the leaves hold a model |
| `skills/` | what a sub-agent reads. `page-state/` is the manual path, `igt/` the guided one |
| `reference/` | Deque's material, captured. The one place that copies their content |
| `tools/` | the pinned-extension build, and the mapping checker |
| `docker/` | the fixture container, its policy renderer, and `replay.sh` |
| `prototype/` | throwaway probes, kept as evidence for the tickets that cite them |

## Writing a skill file

Read [ticket 012](wayfinder/tickets/012-skill-file-format.md) for the format, and `skills/page-state/12-tables.md` as the worked example. Two findings from real failures shape it:

**The most concrete copyable object in the file is the one the model reaches for.** An early version put a complete fill-in-the-blank *abort* report in step 1. The model copied it verbatim — including a leaf named `ledger-lost` when no ledger was lost — the first time anything went wrong. Whatever is most finished in your file is what you will get.

**Prefer a measurement to a judgement.** Handing `find_elements` a selector that answers a branch turns a judgement into a verdict without adding a predicate tool. One branch converted that way went from a false negative in half its runs to correct in five of five.
