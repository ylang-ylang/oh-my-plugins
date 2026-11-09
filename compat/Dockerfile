# syntax=docker/dockerfile:1
ARG BUN_IMAGE=oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM ${BUN_IMAGE} AS bun-runtime
FROM ${NODE_IMAGE} AS harness-dependencies
ARG NPM_REGISTRY

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

ENV CI=1 \
    HOME=/tmp/compat-home \
    XDG_CACHE_HOME=/tmp/compat-state/cache \
    XDG_CONFIG_HOME=/tmp/compat-state/config \
    XDG_DATA_HOME=/tmp/compat-state/data \
    XDG_STATE_HOME=/tmp/compat-state/state \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    npm_config_registry=${NPM_REGISTRY} \
    npm_config_replace_registry_host=npmjs \
    npm_config_fetch_retries=3 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=60000 \
    npm_config_fetch_timeout=30000 \
    npm_config_maxsockets=4 \
    NO_COLOR=1

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY plugins/ plugins/
RUN --mount=type=cache,target=/tmp/compat-home/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY compat/install.mjs compat/
COPY compat/locks/ compat/locks/
RUN --mount=type=cache,target=/tmp/compat-home/.npm node compat/install.mjs /opt/harness --dependencies-only \
    && test "$(node --version)" = "v22.22.0" \
    && test "$(bun --version)" = "1.4.4"

FROM harness-dependencies AS compat-runtime
COPY . .
RUN node compat/install.mjs /opt/harness --plugin-only

USER node
ENTRYPOINT ["node", "compat/run.mjs"]
CMD ["--all", "--report", "/tmp/compat-report.json"]
