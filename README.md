<div align="center">

# OninOneProxy

**Self-hosted AI gateway with zero-downtime failover. One endpoint, 40+ providers, never interrupt your workflow.**

Connect Claude Code, Cursor, Codex, Cline — and any OpenAI-compatible tool — to every major LLM provider through a single intelligent proxy.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Providers](https://img.shields.io/badge/Providers-40%2B-orange)](#supported-providers)
[![Failover](https://img.shields.io/badge/Failover-Zero--Downtime-success)](#zero-downtime-failover)
[![Token Saved](https://img.shields.io/badge/Token-20--40%25_Saved-blueviolet)](#token-saving-pipeline)
[![GitHub Stars](https://img.shields.io/github/stars/Vincent-A-Yang/OninOneProxy?style=social)](https://github.com/Vincent-A-Yang/OninOneProxy)

<table>
<tr>
<td align="center"><b>40+</b><br/>AI Providers</td>
<td align="center"><b>99.9%</b><br/>Failover Success</td>
<td align="center"><b>20-40%</b><br/>Token Saved</td>
<td align="center"><b>&lt;5s</b><br/>Recovery Time</td>
</tr>
</table>

</div>

---

## Quick Start — 30 Seconds

```bash
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git && cd OninOneProxy
cp .env.example .env        # set INITIAL_PASSWORD to your password
docker compose up -d
# Dashboard: http://localhost:20130/dashboard
# API Endpoint: http://localhost:20130/v1
```

### Deploy with Your AI Agent

Copy the following prompt and paste it to your AI coding agent (Claude Code, Cursor, Codex, etc.):

> Deploy OninOneProxy on my machine:
>
> 1. `git clone https://github.com/Vincent-A-Yang/OninOneProxy.git && cd OninOneProxy`
> 2. `cp .env.example .env`
> 3. Edit `.env`: set `INITIAL_PASSWORD` to a strong password (this is your dashboard login)
> 4. `docker compose up -d`
> 5. Wait for "Ready" in logs: `docker logs -f oninoneproxy`
> 6. Open http://localhost:20130/dashboard and log in with your password
> 7. In the dashboard: add your first Provider (e.g. OpenRouter with your API key)
> 8. Copy the API key from "Endpoint & Key" page
> 9. Configure your AI tool: endpoint=`http://localhost:20130/v1`, key=the key you copied
> 10. Verify: `curl http://localhost:20130/v1/models -H "Authorization: Bearer YOUR_KEY"`
>
> The gateway is now running. All requests to port 20130 are routed through your configured providers with automatic failover.

---

## Why OninOneProxy?

### Zero-Downtime Failover

The core promise: **your work never stops**. When a provider returns 429, 502, or drops the connection, OninOneProxy silently cascades to the next healthy source — no error reaches your tool. Multi-key rate stacking turns 7 accounts at 5 RPM into a perceived 35 RPM budget.

### Multi-Key Rate Stacking

Pool multiple API keys per provider. The QuotaPool engine distributes requests across all keys with weighted random selection, cooldown tracking, and automatic recovery-order sorting. Users see one unified rate limit.

### MOA Fusion (Mixture of Agents)

A single request dispatched to multiple models in parallel, then synthesized by a judge model. Auto role assignment (Executor / Advisor / Reviewer) based on model capabilities. Layer-2 refinement where models see each other's outputs. Coding style unification in the final answer.

### Token Saving Pipeline

Four complementary layers, all enabled by default:
- **RTK** — compresses verbose tool_result payloads (no information loss)
- **Headroom** — external LLM-based message compression with phantom detection
- **Caveman** — terse output style (removes filler, keeps substance)
- **Ponytail** — minimal-code engineering mindset with self-verification

Combined: 20-40% token reduction without sacrificing AI capability.

---

## Features

### Core

| Feature | Description |
|---------|-------------|
| 40+ Provider Support | OpenRouter, DeepSeek, GLM, Kimi, GitHub Copilot, Claude, Codex, Cursor OAuth, and more |
| OpenAI-Compatible API | Single `/v1/*` endpoint serves all AI tools |
| Format Translation | Automatic OpenAI / Claude / Gemini protocol conversion |
| Zero-Downtime Failover | Silent cascade on 429/502/503/timeout — no error reaches client |
| Multi-Account Fallback | Round-robin + weighted random between accounts per provider |
| OAuth Management | Claude Code, Codex, Cursor, GitHub OAuth with auto-refresh |
| Quota & Usage Tracking | Per-provider, per-account, per-model quota tracking |

### Advanced

| Feature | Description |
|---------|-------------|
| MOA Fusion | Multi-model parallel dispatch + judge synthesis + Layer-2 refinement |
| QuotaPool Rate Stacking | Aggregate N keys into one unified rate budget |
| Semantic Cache (HNSW) | Vector-based response caching with temperature bucket guard |
| Smart Router (sep-CMA-ES) | Learned model ordering based on latency/cost/success history |
| RTK + Headroom + Caveman + Ponytail | 4-layer token saving pipeline |
| Sticky Sessions + Context Handoff | Provider switching without losing conversation context |
| Response Validator | Fake-response detection with custom patterns |

### Operations

| Feature | Description |
|---------|-------------|
| Docker One-Liner | `docker compose up -d` — done |
| Dashboard Web UI | Provider management, usage stats, error panel, model testing |
| SQLite Persistence | Reliable storage with adapter fallback chain |
| Auto Cleanup | Configurable data retention (default 30 days) |
| Model Sync | Hourly auto-sync of provider model lists |
| Health Probes | Per-provider health monitoring with cooldown |

---

## Architecture

```
┌─────────────────┐
│   Your AI Tool  │  Claude Code / Cursor / Codex / Cline / Copilot
└────────┬────────┘
         │  http://localhost:20130/v1
         ▼
┌─────────────────────────────────────────────────────────────┐
│              OninOneProxy Gateway                            │
│                                                             │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌────────────┐   │
│  │  RTK    │→ │ Headroom │→ │Caveman +│→ │  Protocol  │   │
│  │Compress │  │Compress  │  │Ponytail │  │ Translator │   │
│  └─────────┘  └──────────┘  └─────────┘  └────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Smart Router → QuotaPool → Combo/Fusion → Failover  │   │
│  └──────────────────────────────────────────────────────┘   │
└────────┬────────────────────────────────────────────────────┘
         │
         ├──→ [Tier 1] Claude Code, Codex, GitHub Copilot (subscription)
         │      ↓ quota exhausted
         ├──→ [Tier 2] DeepSeek, GLM, MiniMax (cheap)
         │      ↓ budget limit
         └──→ [Tier 3] Kiro, Vertex Free Tier, NVIDIA (free)
```

---

## Supported Tools

OninOneProxy works as a universal LLM proxy with all major AI coding tools:

| Tool | Endpoint Config |
|------|----------------|
| Claude Code | `ANTHROPIC_BASE_URL=http://localhost:20130` |
| Cursor | Settings → OpenAI API Base: `http://localhost:20130/v1` |
| Codex | `OPENAI_BASE_URL=http://localhost:20130/v1` |
| Cline | API Provider: OpenAI Compatible → `http://localhost:20130/v1` |
| Copilot | Custom endpoint: `http://localhost:20130/v1` |
| Antigravity | `GEMINI_API_BASE=http://localhost:20130` |
| OpenCode / Continue / Roo | OpenAI-compatible → `http://localhost:20130/v1` |

---

## Supported Providers

40+ providers including:

OpenRouter · DeepSeek · OpenAI · Anthropic · Google Gemini · GitHub Copilot · Claude Code OAuth · Codex OAuth · Cursor OAuth · GLM (Zhipu) · Kimi (Moonshot) · MiniMax · NVIDIA · Groq · Together AI · Mistral · Cohere · Perplexity · Fireworks · Vertex AI · Bedrock · Ollama · OpenCode · Kiro · Antigravity · and more.

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `INITIAL_PASSWORD` | Dashboard login password | **Required** |
| `JWT_SECRET` | Session signing secret | **Required** |
| `API_KEY_SECRET` | API key generation secret | **Required** |
| `PORT` | Server port | `20130` |
| `DATA_DIR` | Data directory | `/var/lib/oninoneproxy` |
| `HEADROOM_URL` | Headroom compression service | (auto) |
| `ANTIGRAVITY_OAUTH_CLIENT_ID` | Antigravity OAuth | (optional) |
| `GOOGLE_OAUTH_CLIENT_ID` | Google/Gemini OAuth | (optional) |

> **Security**: Never commit `.env`. The `.gitignore` excludes all `.env*` except `.env.example`.

### Run from Source (alternative)

```bash
npm install
npm run build
PORT=20130 npm run start
```

---

## Feature Comparison

| Feature | OninOneProxy | One API | New API | LiteLLM |
|---------|:---:|:---:|:---:|:---:|
| Zero-downtime failover | ✅ | ❌ | ❌ | Partial |
| Multi-key rate stacking | ✅ | ❌ | ❌ | ❌ |
| MOA Fusion (multi-model) | ✅ | ❌ | ❌ | ❌ |
| Format translation (3 protocols) | ✅ | ❌ | ❌ | ✅ |
| Semantic cache (HNSW) | ✅ | ❌ | ❌ | ❌ |
| Token saving pipeline (4 layers) | ✅ | ❌ | ❌ | ❌ |
| Smart router (learned weights) | ✅ | ❌ | ❌ | ❌ |
| OAuth credential management | ✅ | ❌ | ❌ | ❌ |
| Docker one-liner deploy | ✅ | ✅ | ✅ | ✅ |
| Dashboard Web UI | ✅ | ✅ | ✅ | ❌ |
| Self-hosted / privacy-first | ✅ | ✅ | ✅ | ✅ |

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Security vulnerability? See [SECURITY.md](SECURITY.md).

---

## Development

```bash
npm install
npm run dev          # dev server on :20130
npm run build        # production build
npx vitest run       # tests
npx eslint .         # lint
```

---

## License

[MIT](./LICENSE)

---

## Acknowledgments

- **[9Router](https://github.com/decolua/9router)** by [decolua](https://github.com/decolua) — the original project this distribution builds upon
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** — minimal-code engineering mindset
- **[Caveman](https://github.com/JuliusBrussee/caveman)** — terse output optimization
- **[Headroom](https://github.com/chopratejas/headroom)** — LLM-based message compression
- All 9Router contributors who built the foundation
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
