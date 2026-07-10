<div align="center">

# OninOneProxy

**Unified AI API Gateway — Multi-provider routing, token saving, semantic cache, and intelligent fallback.**

Connect all your AI coding tools (Claude Code, Cursor, Codex, Cline) to 40+ providers through a single OpenAI-compatible endpoint.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Vincent-A-Yang/OninOneProxy/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub Stars](https://img.shields.io/github/stars/Vincent-A-Yang/OninOneProxy?style=social)](https://github.com/Vincent-A-Yang/OninOneProxy)

**A derivative distribution of [9Router](https://github.com/decolua/9router) by [decolua](https://github.com/decolua)**

</div>

---

## Table of Contents

- [Why OninOneProxy?](#why-oninoneproxy)
- [Features](#features)
- [Feature Comparison](#feature-comparison)
- [Quick Start](#quick-start)
- [Supported CLI Tools](#supported-cli-tools)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Relationship with 9Router](#relationship-with-9router)
- [Contributing](#contributing)
- [Development](#development)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Why OninOneProxy?

OninOneProxy is a unified **AI gateway** and **LLM proxy** that turns a tangle of API keys, OAuth tokens, and incompatible request formats into one clean, OpenAI-compatible endpoint. Below are the differentiators that set it apart from generic multi-provider routers.

### 1. Multi-Protocol Unification

Stop wrestling with provider-specific SDKs. OninOneProxy translates between OpenAI, Anthropic (Claude), and Gemini request formats transparently, so your **Claude Code proxy**, **Cursor proxy**, and Codex setup all speak the same `/v1/*` API. Whether your tool emits `messages` (Anthropic), `contents` (Gemini), or `chat/completions` (OpenAI), the gateway normalizes it on the fly and translates the response back to the format your client expects.

### 2. Token Saving by Design

Every request passes through an RTK (Result Token Kit) pipeline that compresses verbose `tool_result` payloads, plus optional Headroom, Caveman, and Ponytail savers. Combined, these cut token consumption by **20–40%** without altering the semantic content your model sees — lowering latency and subscription burn on every call.

### 3. Semantic Cache with Correctness Guards

A vector-based **semantic cache** (HNSW index) serves repeated and near-duplicate prompts from cache, slashing cost on reruns. Two guards keep correctness intact:

- **Temperature bucket guard** — caches only within strict temperature buckets, so `temperature=0.2` and `temperature=0.9` never collide.
- **Tools detection** — when a request contains `tools`, the cache is automatically bypassed, so tool-calling turns are always fresh.

### 4. Intelligent Routing & Fusion Collaboration

The **smart router** picks the cheapest healthy provider per request, with tiered fallback from subscription → cheap → free. OninOneProxy also introduces **Fusion multi-model collaboration**: a single request can be dispatched across multiple models in parallel, then synthesized and reviewed by a judge model — giving you consensus-style answers without orchestrating multiple clients.

### 5. Multi-Account Aggregation & Rate Pooling

Pool multiple API keys per provider and aggregate their rate limits. Seven accounts at 5 RPM each become a single **35 RPM** budget — ideal for bursty workloads that would otherwise hit per-key ceilings. OAuth credential rotation and anti-ban logic keep multi-account setups stable over long sessions.

---

## Features

### Core Features

- **40+ Provider Support** — OpenRouter, GLM, Kimi, DeepSeek, GitHub Copilot, Claude Code, Codex, Cursor OAuth, and more
- **OpenAI-Compatible API** — Single `/v1/*` endpoint serves all AI tools
- **Format Translation** — Automatic OpenAI ↔ Claude ↔ Gemini conversion
- **Multi-Account Fallback** — Round-robin between accounts per provider
- **OAuth Credential Management** — Claude Code, Codex, Cursor, GitHub OAuth support
- **Token Refresh** — Automatic OAuth token refresh
- **Quota & Usage Tracking** — Per-provider / per-account quota tracking

### Advanced Features

- **HNSW Semantic Cache** — Vector-based response caching with HNSW indexing for cache hit rate optimization
- **Temperature Bucket Guard** — Temperature-bucketed cache to protect output correctness
- **Tools Detection** — Smart cache bypass when tools are detected in requests
- **Multi-APIKEY Aggregation** — Aggregate multiple API keys per provider for higher rate limits
- **Rate Limit Pooling** — Combine rate limits across accounts (e.g., 7×5RPM = 35RPM)
- **Fusion Multi-Model Collaboration** — Parallel multi-model dispatch + synthesized review
- **RTK Token Saver** — Auto-compress tool_result content, save 20-40% tokens
- **LRU Memory Management** — O(1) eviction with memory monitoring and `--max-old-space-size=1024`

### Operations & Deployment

- **Docker Support** — `docker-compose up -d` one-command deploy
- **Dashboard Web UI** — Provider management, usage stats, model testing
- **SQLite Persistence** — Reliable data storage with adapter fallback chain
- **Automatic Data Cleanup** — 24-hour cleanup timer with Dashboard UI control
- **Domestic Direct Connection** — Direct connection bypass for China mainland providers
- **Provider Naming Validation** — `normalizeProviderId` with HTTP 400 error for invalid names

---

## Feature Comparison

| Feature | OninOneProxy | 9Router | One API | New API |
|---------|:---:|:---:|:---:|:---:|
| Multi-provider routing | ✅ | ✅ | ✅ | ✅ |
| OpenAI-compatible API | ✅ | ✅ | ✅ | ✅ |
| Format translation (OpenAI↔Claude↔Gemini) | ✅ | ✅ | ❌ | ❌ |
| Semantic cache (HNSW) | ✅ | ❌ | ❌ | ❌ |
| Temperature bucket guard | ✅ | ❌ | ❌ | ❌ |
| Tools detection (cache bypass) | ✅ | ❌ | ❌ | ❌ |
| Multi-APIKEY aggregation | ✅ | ❌ | ❌ | ❌ |
| Rate limit pooling | ✅ | ❌ | ❌ | ❌ |
| RTK token saver | ✅ | ✅ | ❌ | ❌ |
| Fusion multi-model collaboration | ✅ | ❌ | ❌ | ❌ |
| OAuth credential management | ✅ | ✅ | ❌ | ❌ |
| Domestic direct connection (China) | ✅ | ❌ | ❌ | ❌ |
| Dashboard Web UI | ✅ | ✅ | ✅ | ✅ |

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# 2. Configure
cp .env.example .env
# Edit .env: set JWT_SECRET, INITIAL_PASSWORD, API_KEY_SECRET

# 3. Build and run
docker-compose up -d

# 4. Access Dashboard
# Open http://localhost:20130/dashboard

# 5. Connect your AI tool
# Endpoint: http://localhost:20130/v1
# API Key: [copy from dashboard]
```

### Run from Source (alternative)

```bash
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy
cp .env.example .env
npm install

# Development mode
PORT=20130 NEXT_PUBLIC_BASE_URL=http://localhost:20130 npm run dev

# Production mode
npm run build
PORT=20130 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20130 npm run start
```

### Access Points

- **Dashboard**: http://localhost:20130/dashboard
- **OpenAI-Compatible API**: http://localhost:20130/v1

### Connect Your AI Tool

Configure your AI coding tool (Claude Code, Codex, Cursor, etc.):

```
Endpoint: http://localhost:20130/v1
API Key:  [copy from dashboard]
Model:    [select from dashboard provider list]
```

---

## Supported CLI Tools

OninOneProxy works as a universal **API router** with all major AI coding tools:

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

Copy `.env.example` to `.env` and configure.

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
| `PORT` | Server port | `20130` |
| `HOSTNAME` | Server hostname | `0.0.0.0` |
| `DATA_DIR` | Data directory path | `~/.oninoneproxy/` |
| `DEBUG` | Debug mode | `false` |
| `HEADROOM_URL` | Headroom token saver URL | (disabled) |
| `NEXT_PUBLIC_BASE_URL` | Public base URL | `http://localhost:20130` |

> **Security**: Never commit your `.env` file. The `.gitignore` already excludes `.env*` files (except `.env.example`).

---

## Architecture

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, Cursor, Cline...)
│   Tool      │
└──────┬──────┘
       │ http://localhost:20130/v1
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

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

To report a security vulnerability, please see [SECURITY.md](SECURITY.md).

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

### Local Dev Server

```bash
PORT=20130 NEXT_PUBLIC_BASE_URL=http://localhost:20130 npm run dev
```

---

## License

[MIT License](./LICENSE) — Copyright (c) 2024-2026 decolua and contributors

---

## Acknowledgments

- **[9Router](https://github.com/decolua/9router)** by [decolua](https://github.com/decolua) — The original project this distribution is based on
- All 9Router contributors who built the foundation
