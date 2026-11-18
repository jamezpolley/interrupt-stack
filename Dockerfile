# syntax=docker/dockerfile:1

# Where the code in the image comes from:
#   context (default): this build context, as always.
#   git: a clone of INTERRUPT_STACK_REPO at INTERRUPT_STACK_REF, with its .git. The running server can then read its
#        own version from git, and at start-up try to update itself from GitHub (see the README).
ARG SOURCE=context

FROM oven/bun:1 AS src-context
WORKDIR /src
COPY server/ ./server/
COPY web/ ./web/
COPY scripts/ ./scripts/
# The build context's .git is optional: the glob matches nothing when there is none, and the build carries on
# (the commit is then recorded as unknown). Only the small result is kept, never the history.
COPY .gi[t]/ /ctx-git/
RUN bun scripts/write-version.ts /ctx-git /src/build-info.json && rm -rf /ctx-git

FROM oven/bun:1 AS src-git
ARG INTERRUPT_STACK_REPO
ARG INTERRUPT_STACK_REF=main
# Docker re-fetches this whenever the ref moves, so a cached build can never hold stale code.
ADD --keep-git-dir=true ${INTERRUPT_STACK_REPO}#${INTERRUPT_STACK_REF} /src

FROM src-${SOURCE:-context} AS src

FROM oven/bun:1
ARG INTERRUPT_STACK_REF=main

# git is used to read the version, to check GitHub, and for the start-up update. The code directory belongs to root
# but runs as bun, so git must be told it is safe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

WORKDIR /app
COPY --from=src /src /app

# A clone made by the build is shallow: fetch the rest, with the tags, so versions can be described (v1.2.0-3-g5a7581b).
# If GitHub cannot be reached the build still succeeds, and the version falls back to the short commit.
RUN if [ -d .git ]; then git fetch --unshallow --tags --force origin || git fetch --tags --force origin || true; fi

# The app icons are generated here and are not stored in git. Tests and the scripts are not needed at runtime
# (an updated copy gets them back from git).
RUN bun scripts/make-icons.ts \
 && rm -rf scripts server/*.test.ts web/*.test.js \
 && mkdir -p /data && chown bun:bun /data

ENV PORT=9958 DATA_DIR=/data INTERRUPT_STACK_REF=$INTERRUPT_STACK_REF
VOLUME /data
EXPOSE 9958
USER bun

# The start period covers a start-up update: fetching from GitHub, then up to 30 seconds for updated code to answer.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 9958) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/entrypoint.ts"]
