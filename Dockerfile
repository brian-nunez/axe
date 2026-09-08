# The fixture container: a browser that is already correct.
#
# Base is Playwright's own image, pinned by digest to v1.58.0. That pin is load
# bearing twice over: PW_CHROMIUM_ATTACH_TO_OTHER is undocumented Playwright
# internals, and the browser this tag ships is Chromium revision 1208. Extensions
# do not load in the bundled headless shell, so the fixture runs the full browser
# headful behind Xvfb — which the panel needs anyway, because an unlaid-out panel
# reports a 0x0 document and every action against it fails as "not visible".
FROM mcr.microsoft.com/playwright:v1.58.0-noble@sha256:35c7d48b4ccaf3aca5018f5f1bf7f50c7da7d61d176c530741f4f2e9ca336c34

# Xvfb, xauth and Chrome for Testing's own dependencies are already in the base
# image. x11vnc and noVNC are not, and they are what lets a human watch a run.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        tini=0.19.0-1 \
        x11vnc=0.9.16-10 \
        novnc=1:1.3.0-2 \
        websockify=0.10.0+dfsg1-5build2 \
        x11-utils=7.7+6build2 \
    && rm -rf /var/lib/apt/lists/*

# uv runs the two stdlib-only scripts here, so one runner drives Python
# everywhere. It does NOT install an interpreter: the container holds no graph
# and no dependencies, the base image already ships python3, and downloading a
# CPython at build time is the unpinned network fetch this build exists to
# avoid. UV_PYTHON_DOWNLOADS=never makes that a hard failure rather than a
# silent reach for the network.
COPY --from=ghcr.io/astral-sh/uv:0.9.3 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

# A corporate network reaches the outside through a proxy and an internal index.
# These are build args rather than baked values: the image must not carry a
# proxy URL or credentials, and a build host outside that network passes none.
ARG HTTP_PROXY=
ARG HTTPS_PROXY=
ARG NO_PROXY=
ARG NPM_CONFIG_REGISTRY=
ARG NODE_EXTRA_CA_CERTS=
ENV HTTP_PROXY=${HTTP_PROXY} HTTPS_PROXY=${HTTPS_PROXY} NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY} no_proxy=${NO_PROXY} \
    NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY} \
    NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS}

# The source revision is a build argument because a running image cannot read
# the repository it was built from, and a run's provenance is worthless if it
# cannot name the code that produced it.
ARG AXE_SOURCE_REVISION=unknown

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    AXE_EXTENSION_DIR=/opt/axe/extension \
    AXE_POLICY_FILE=/etc/chromium/policies/managed/axe-devtools.json \
    DISPLAY=:99 \
    AXE_SCREEN=1920x1080x24 \
    AXE_NOVNC_PORT=6080 \
    AXE_RUNS_DIR=/opt/axe/runs \
    AXE_ACCESSIBILITY_STANDARD=wcag22aa \
    AXE_CORE_VERSION=latest \
    AXE_ISSUE_SCREENSHOTS=1 \
    AXE_BASE_IMAGE=mcr.microsoft.com/playwright:v1.58.0-noble@sha256:35c7d48b4ccaf3aca5018f5f1bf7f50c7da7d61d176c530741f4f2e9ca336c34 \
    AXE_SOURCE_REVISION=${AXE_SOURCE_REVISION}

# PW_CHROMIUM_ATTACH_TO_OTHER must be set before Chromium attaches, so it is set
# in the image rather than by the process that launches the browser.
ENV PW_CHROMIUM_ATTACH_TO_OTHER=1

WORKDIR /opt/axe

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The extension is built into the image from the vendored CRX, so the running
# container never fetches one. build-axe-extension.py verifies the digest and the
# version against the lock, recovers the publisher key from the CRX3 header and
# injects it, which is what keeps the loaded ID lhdoppojpmngadmnindnejefpokejbdd.
# Without that ID, managed policy silently does nothing.
COPY src/tools/ ./tools/
COPY vendor/ ./vendor/
RUN uv run --no-project --python python3 tools/build-axe-extension.py \
        --lock vendor/axe-devtools/axe-extension.lock.json \
        --dest "${AXE_EXTENSION_DIR}" \
    && test -s "${AXE_EXTENSION_DIR}/schema.json"

COPY src/fixture/ ./fixture/
COPY reference/ ./reference/
COPY docker/render-policy.py docker/record-provenance.py \
     docker/entrypoint.sh docker/vnc-event.sh /opt/axe/docker/

# The managed-policy directory is created here so the entrypoint can write into
# it as root before dropping privileges. Empirically — see wayfinder ticket 005 —
# this is the only directory Playwright's Linux Chromium reads: it is an
# unbranded Chromium build, not the branded Chrome for Testing that Playwright
# ships on macOS, and /etc/opt/chrome, /etc/opt/chrome_for_testing and
# /etc/chromium-browser are all ignored.
RUN mkdir -p /etc/chromium/policies/managed \
    && install -d -o pwuser -g pwuser /home/pwuser/.axe \
    && install -d -o pwuser -g pwuser /opt/axe/runs \
    && chmod +x /opt/axe/docker/entrypoint.sh /opt/axe/docker/vnc-event.sh

# Only the watch console listens. The tool layer speaks MCP over stdio — the
# graph runs `docker run -i` and owns the container's lifetime — so there is no
# second port and nothing to authenticate on one.
EXPOSE 6080

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/axe/docker/entrypoint.sh"]
CMD ["node", "fixture/mcp-server.js"]
