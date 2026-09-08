# axedevtools — fixture and tool layer
#
# `make login` is the whole path from a clean checkout: install dependencies,
# unpack the pinned extension, launch a browser with it already signed in.

# uv owns the Python side: it resolves the graph's dependencies from
# pyproject.toml against uv.lock, and pins the interpreter via .python-version.
# `uv run --no-project` is for the stdlib-only scripts, which need no sync.
UV            ?= uv
PY            ?= $(UV) run --no-project --quiet python
NODE          ?= node
NPM           ?= npm
LOCK          ?= vendor/axe-devtools/axe-extension.lock.json
EXTENSION_DIR ?= build/axe-extension
ENV_FILE      ?= .env

# The v0 run: the MCP server that is the fixture, and the graph that drives it.
TARGET_DIR    ?= fixture/target
TARGET_PORT   ?= 8731
AXE_TARGET_URL ?= http://127.0.0.1:$(TARGET_PORT)/
# The development model is served by Docker Model Runner, which is llama.cpp
# behind an OpenAI-compatible API. So the provider is `openai:` with the base URL
# moved, not a runtime-specific binding — the model id is the full repository
# name the endpoint lists, `docker.io/ai/<name>:<tag>`. The key is required by
# the client and ignored by the server.
AXE_MODEL     ?= openai:docker.io/ai/gemma4:e2b
# Whatever the provider needs said to it. Nothing here sets a context window:
# Docker Model Runner loads this model with 131072 tokens per slot and takes the
# size from `docker model configure --context-size`, not from the request.
AXE_MODEL_KWARGS ?= {"base_url": "$(MODEL_RUNNER_URL)", "api_key": "docker"}
# Host-side, because the model is host-side: the container is the fixture and
# holds no model, so nothing in docker/ reaches this URL. If the graph is ever
# moved inside a container it will need `--add-host
# model-runner.docker.internal:host-gateway` and the port kept — the bare
# `http://model-runner.docker.internal/engines/v1` does not resolve under a
# plain `docker run` on this machine.
MODEL_RUNNER_URL ?= http://localhost:12434/engines/v1
IMAGE         ?= axedevtools-fixture:005
RUNS_DIR      ?= build/runs

# Sourced per-recipe rather than `include`d, so values with spaces or `#`
# survive: the shell parses them, not make.
LOAD_ENV = set -a; . ./$(ENV_FILE); set +a;

.DEFAULT_GOAL := help

## help: list the available targets
help:
	@echo "axedevtools"
	@echo
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  make /' | column -t -s ':'
	@echo
	@echo "Requires $(ENV_FILE) with AXE_SERVER_URL, AXE_USER_EMAIL_ADDRESS, AXE_USER_PASSWORD."

## install: install pinned node dependencies
install: node_modules

node_modules: package.json
	$(NPM) install --no-audit --no-fund
	@touch node_modules

## extension: unpack the pinned axe extension, keeping its store ID
extension: $(EXTENSION_DIR)/manifest.json

$(EXTENSION_DIR)/manifest.json: $(LOCK) tools/build-axe-extension.py
	$(PY) tools/build-axe-extension.py --lock $(LOCK) --dest $(EXTENSION_DIR)

## env: check the environment the fixture needs
env:
	@test -f $(ENV_FILE) || { echo "missing $(ENV_FILE)"; exit 1; }
	@$(LOAD_ENV) for v in AXE_SERVER_URL AXE_USER_EMAIL_ADDRESS AXE_USER_PASSWORD; do \
		eval "test -n \"\$$$$v\"" || { echo "$$v is not set in $(ENV_FILE)"; exit 1; }; \
	done; echo "environment ok"

## model: check the runtime behind AXE_MODEL is up and serving that model
# Only meaningful for Docker Model Runner, so the check runs only when the
# kwargs still point at it — overriding AXE_MODEL to a hosted provider silently
# skips it rather than failing on a runtime that is not in play.
model:
	@case '$(AXE_MODEL_KWARGS)' in \
	*$(MODEL_RUNNER_URL)*) \
		curl -sf $(MODEL_RUNNER_URL)/models >/dev/null \
			|| { echo "Docker Model Runner is not answering at $(MODEL_RUNNER_URL)"; \
			     echo "start it with 'docker desktop enable model-runner'"; exit 1; }; \
		curl -sf $(MODEL_RUNNER_URL)/models \
			| grep -q '"$(patsubst openai:%,%,$(AXE_MODEL))"' \
			|| { echo "$(patsubst openai:%,%,$(AXE_MODEL)) is not pulled"; \
			     echo "pull it with 'docker model pull $(patsubst openai:docker.io/ai/%,%,$(AXE_MODEL))'"; exit 1; }; \
		echo "model ok — $(AXE_MODEL) on $(MODEL_RUNNER_URL)";; \
	*) echo "model check skipped — AXE_MODEL_KWARGS does not name $(MODEL_RUNNER_URL)";; \
	esac

## login: launch a browser with the extension signed in, and verify
login: install extension env
	$(LOAD_ENV) $(NODE) fixture/cli.js --extension=$(EXTENSION_DIR)

## login-headed: same, with a visible browser window
login-headed: install extension env
	$(LOAD_ENV) $(NODE) fixture/cli.js --extension=$(EXTENSION_DIR) --headed --keep-open

## keepalive: prove the harness sustains the session without touching the panel
keepalive: install extension env
	$(LOAD_ENV) $(NODE) fixture/cli.js --extension=$(EXTENSION_DIR) --prove-keepalive

## venv: sync the Python environment the graph runs in, from uv.lock
venv: .venv/pyvenv.cfg

.venv/pyvenv.cfg: pyproject.toml uv.lock .python-version
	$(UV) sync --frozen --quiet
	@touch .venv/pyvenv.cfg

## serve-target: serve the bundled v0 page state, in the foreground
serve-target:
	$(PY) -m http.server $(TARGET_PORT) --directory $(TARGET_DIR)

## mcp-server: run the MCP server alone, on stdio, for a client of your own
mcp-server: install extension env
	$(LOAD_ENV) $(NODE) fixture/mcp-server.js --extension=$(EXTENSION_DIR) --url=$(AXE_TARGET_URL) $(MCP_ARGS)

# Both v0 targets serve the bundled page state for the life of the run and take
# it down afterwards, so the proof is one command. Point AXE_TARGET_URL at a real
# page state to audit that instead; the local server is then unused.
V0_RUN = \
	$(PY) -m http.server $(TARGET_PORT) --directory $(TARGET_DIR) >/dev/null 2>&1 & \
	server=$$!; trap "kill $$server 2>/dev/null" EXIT INT TERM; sleep 1; \
	AXE_EXTENSION_DIR=$(EXTENSION_DIR) AXE_TARGET_URL=$(AXE_TARGET_URL)

## v0: run both v0 units end to end against AXE_MODEL, and print the draft
v0: install extension env venv model
	@$(LOAD_ENV) $(V0_RUN) AXE_MODEL=$(AXE_MODEL) AXE_MODEL_KWARGS='$(AXE_MODEL_KWARGS)' \
		$(UV) run --frozen --quiet python -m graph.run $(V0_ARGS)

## v0-scripted: the same run with a scripted leaf in place of the model
v0-scripted: install extension env venv
	@$(LOAD_ENV) $(V0_RUN) AXE_SCRIPT=$(TARGET_DIR)/answers.json \
		$(UV) run --frozen --quiet python -m graph.run --leaf scripted $(V0_ARGS)

## probe: survey what the axe panel offers as automation hooks (throwaway)
probe: install extension env
	$(LOAD_ENV) $(NODE) prototype/panel-probe.js --extension=$(EXTENSION_DIR)

## probe-headed: same, with a visible browser window
probe-headed: install extension env
	$(LOAD_ENV) $(NODE) prototype/panel-probe.js --extension=$(EXTENSION_DIR) --headed

## igt: drive the Structure IGT end to end against a target page (throwaway)
igt: install extension env
	$(LOAD_ENV) $(NODE) prototype/igt-structure.js --extension=$(EXTENSION_DIR) $(IGT_ARGS)

## manual-issue: file manual issues from CSS selectors, end to end (throwaway)
manual-issue: install extension env
	$(LOAD_ENV) $(NODE) prototype/manual-issue.js --extension=$(EXTENSION_DIR) $(ISSUE_ARGS)

## catalog: dump the manual issue catalog as JSON (throwaway)
catalog: install extension env
	$(LOAD_ENV) $(NODE) prototype/manual-issue.js --extension=$(EXTENSION_DIR) --catalog $(ISSUE_ARGS)

## ledger-check: prove the ledger-loss check catches a broken ledger (throwaway)
ledger-check: install extension env
	$(LOAD_ENV) $(NODE) prototype/ledger-check.js --extension=$(EXTENSION_DIR) $(LEDGER_ARGS)

## check-mapping: verify reference/issue-mapping.json against the checklist, the catalog dump and skills/
check-mapping:
	$(NODE) tools/check-issue-mapping.mjs

## crx-latest: download the current extension release, to pin a new version
crx-latest:
	$(PY) tools/build-axe-extension.py --dest build/crx-check --save-crx build/axe-latest.crx
	@echo
	@echo "To pin it: move build/axe-latest.crx into vendor/axe-devtools/ named for its"
	@echo "version, update crx/version/sha256/retrieved in $(LOCK), then run 'make extension'."
	@echo "See vendor/axe-devtools/README.md."

## image: build the fixture container
image:
	docker build -f docker/Dockerfile \
		--build-arg AXE_SOURCE_REVISION=$$(git rev-parse --short HEAD 2>/dev/null || echo unknown) \
		-t $(IMAGE) .

## fixture: run the fixture container for a human to watch through noVNC
fixture: env
	@test -n "$(TARGET_URL)" || { echo "TARGET_URL=<page state under audit> is required"; exit 1; }
	docker run --rm -i --env-file $(ENV_FILE) \
		-e AXE_TARGET_URL=$(TARGET_URL) \
		-e AXE_IMAGE_REF=$(IMAGE) \
		-e AXE_VNC_PASSWORD=$${AXE_VNC_PASSWORD:?set AXE_VNC_PASSWORD to open the watch console} \
		-p 127.0.0.1:6080:6080 \
		-v $(PWD)/$(RUNS_DIR):/opt/axe/runs \
		$(IMAGE)

## replay: re-run a recorded fixture — RUN=build/runs/<id> [ARGS="--check|--print|--unit ID"]
replay:
	@test -n "$(RUN)" || { echo "RUN=build/runs/<id> is required"; exit 1; }
	docker/replay.sh $(RUN) $(ARGS)

## clean: remove build output
clean:
	rm -rf build

## distclean: remove build output and installed dependencies
distclean: clean
	rm -rf node_modules

.PHONY: help install extension env model login login-headed keepalive probe probe-headed igt manual-issue catalog ledger-check check-mapping crx-latest image fixture replay clean distclean
