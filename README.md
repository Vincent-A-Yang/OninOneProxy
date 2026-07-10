<div align="center">

# OninOneProxy

**Unified AI API Gateway — Multi-provider routing, token saving, and intelligent fallback.**

Connect all your AI coding tools to 40+ providers through a single endpoint with automatic format translation, quota tracking, and cost optimization.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Vincent-A-Yang/OninOneProxy/blob/main/LICENSE)
[![Based on 9Router](https://img.shields.io/badge/Based%20on-9Router-blue)](https://github.com/decolua/9router)

**A derivative distribution of [9Router](https://github.com/decolua/9router) by [decolua](https://github.com/decolua)**

</div>

---

## Attribution & License

OninOneProxy is a **derivative distribution** based on [9Router](https://github.com/decolua/9router) by decolua, distributed under the [MIT License](./LICENSE).

- The original 9Router copyright belongs to `decolua and contributors`
- OninOneProxy adds configuration, provider integration, and operational enhancements
- This is **not** an official 9Router fork — it is an independent derivative distribution

---

## Features

### 9Router Base Features (inherited)

- **40+ Provider Support** — Connect to OpenRouter, GLM, Kimi, DeepSeek, and many more
- **OpenAI-Compatible API** — Single endpoint (`/v1/*`) for all your AI tools
- **Format Translation** — Automatic OpenAI ↔ Claude ↔ Gemini format conversion
- **Multi-Account Fallback** — Round-robin between accounts per provider
- **OAuth Credential Management** — Claude Code, Codex, Cursor, GitHub OAuth support
- **Token Refresh** — Automatic OAuth token refresh
- **Quota & Usage Tracking** — Track subscription quota, usage per provider/account
- **RTK Token Saver** — Auto-compress tool_result content, save 20-40% tokens
- **Model Combo Fallback** — Subscription → Cheap → Free tier auto-fallback
- **Dashboard** — Web UI for provider management, usage stats, and testing
- **SQLite Persistence** — Reliable data storage with adapter fallback chain

### OninOneProxy Extensions

- **Multi-APIKEY Aggregation** — Aggregate multiple API keys per provider for higher rate limits
- **Provider Velocity Pooling** — Combine rate limits across accounts (e.g., 7×5RPM = 35RPM)
- **HNSW Semantic Cache** — Vector-based response caching with HNSW indexing for cache hit rate optimization
- **Temperature Bucket Guard** — Temperature-bucketed cache to protect output correctness
- **Tools Detection** — Smart cache bypass when tools are detected in requests
- **LRU Memory Management** — O(1) eviction with memory monitoring and `--max-old-space-size=1024`
- **Automatic Data Cleanup** — 24-hour cleanup timer with Dashboard UI control
- **Domestic Direct Connection** — Direct connection bypass for China mainland providers
- **Poe Tool Call Support** — Fail-open parameter stripping for Poe provider compatibility
- **Provider Naming Validation** — `normalizeProviderId` with HTTP 400 error for invalid names

---

## Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# Build and run with Docker
docker build -t oninoneproxy .
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.oninoneproxy:/app/data" \
  -e DATA_DIR=/app/data \
  --name oninoneproxy \
  oninoneproxy:latest
```

Or use docker-compose:

```bash
docker-compose up -d
```

### Option 2: Run from Source

```bash
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# Install dependencies
cp .env.example .env
npm install

# Development mode
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev

# Production mode
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

### Access Points

- **Dashboard**: http://localhost:20128/dashboard
- **OpenAI-Compatible API**: http://localhost:20128/v1

### Connect Your AI Tool

Configure your AI coding tool (Claude Code, Codex, Cursor, etc.):

```
Endpoint: http://localhost:20128/v1
API Key: [copy from dashboard]
Model: [select from dashboard provider list]
```

---

## Supported CLI Tools

OninOneProxy works with all major AI coding tools:

| Tool | Status |
|------|--------|
| Claude Code | ✅ Supported |
| Codex | ✅ Supported |
| Cursor | ✅ Supported |
| OpenCode | ✅ Supported |
| Cline | ✅ Supported |
| Copilot | ✅ Supported |
| Antigravity | ✅ Supported |
| OpenClaw | ✅ Supported |
| Continue | ✅ Supported |
| Roo / Kilo Code | ✅ Supported |

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | Session cookie signing secret | Generate your own |
| `INITIAL_PASSWORD` | Initial admin password | Override required |
| `API_KEY_SECRET` | API key generation secret | Generate your own |
| `MACHINE_ID_SALT` | Machine ID generation salt | Generate your own |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `20128` |
| `HOSTNAME` | Server hostname | `0.0.0.0` |
| `DATA_DIR` | Data directory path | `~/.oninoneproxy/` |
| `DEBUG` | Debug mode | `false` |
| `HEADROOM_URL` | Headroom token saver URL | (disabled) |
| `NEXT_PUBLIC_BASE_URL` | Public base URL | `http://localhost:20128` |

> **Security**: Never commit your `.env` file. The `.gitignore` already excludes `.env*` files (except `.env.example`).

---

## Architecture

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, Cursor, Cline...)
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────────────────┐
│           OninOneProxy (Smart Router)               │
│  • RTK Token Saver (cut tool_result tokens)        │
│  • HNSW Semantic Cache (vector-based caching)      │
│  • Format translation (OpenAI ↔ Claude ↔ Gemini)   │
│  • Multi-APIKEY aggregation                        │
│  • Quota tracking + auto fallback                  │
│  • Auto token refresh                              │
└──────┬──────────────────────────────────────────────┘
       │
       ├─→ [Tier 1: SUBSCRIPTION] Claude Code, Codex, GitHub Copilot
       │   ↓ quota exhausted
       ├─→ [Tier 2: CHEAP] GLM ($0.6/1M), MiniMax ($0.2/1M)
       │   ↓ budget limit
       └─→ [Tier 3: FREE] Kiro, OpenCode Free, Vertex ($300 credits)
```

For full architecture details, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Relationship with 9Router

OninOneProxy is a **derivative distribution** of [9Router](https://github.com/decolua/9router):

- **Not an official fork** — This project is independently maintained
- **Preserves attribution** — Original 9Router copyright (`decolua and contributors`) is retained in the LICENSE
- **Adds operational extensions** — Multi-APIKEY aggregation, HNSW caching, memory management, etc.
- **Shares upstream improvements** — General improvements may be contributed back to 9Router

### Contributing Back to 9Router

General improvements that benefit both projects are welcome to be contributed back to the upstream 9Router repository via Pull Requests. OninOneProxy-specific extensions (caching, aggregation) may remain in this distribution.

---

## Development

### Prerequisites

- Node.js ≥ 18
- npm or bun

### Build

```bash
npm install
npm run build
```

### Tests

```bash
# Install test dependencies
cd tests && npm install && cd ..

# Run tests (from repo root)
npx vitest run
```

> The test suite is not expected to be all-green on a plain checkout. See `tests/__baseline__/` for regression baselines.

### Lint

```bash
npx eslint .
```

---

## License

[MIT License](./LICENSE) — Copyright (c) 2024-2026 decolua and contributors

---

## Acknowledgments

- **[9Router](https://github.com/decolua/9router)** by [decolua](https://github.com/decolua) — The original project this distribution is based on
- All 9Router contributors who built the foundation