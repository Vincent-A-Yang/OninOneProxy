# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

# Use Chinese Alpine mirror to avoid Clash proxy CONNECT issues on dl-cdn.alpinelinux.org.
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories && \
  apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="oninoneproxy"

ENV NODE_ENV=production
ENV PORT=20130
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
# Stage 11.3.3: Limit V8 old-space heap to 1GB. The container caps at ~1.5GB
# resident RAM by default; capping old-space at 1GB gives Node headroom for
# new-space allocation + external (undici / Buffer / TLS) before V8's
# aggressive GC kicks in. Prevents unbounded growth from a slow leak in a
# third-party provider from OOM-killing the container. Operators can override
# at runtime via `docker run -e NODE_OPTIONS=--max-old-space-size=2048`.
ENV NODE_OPTIONS=--max-old-space-size=1024

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# hnswlib-node is dynamically imported (import()) so Next.js tracing may miss it.
COPY --from=builder /app/node_modules/hnswlib-node ./node_modules/hnswlib-node
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
# Use Chinese Alpine mirror to avoid Clash proxy CONNECT issues on dl-cdn.alpinelinux.org.
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories && \
  apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20130

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
