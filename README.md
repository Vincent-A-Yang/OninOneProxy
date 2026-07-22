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

## Why OninOneProxy?

<table>
<tr>
<td width="25%" align="center">
  <h3>🛡️ Zero-Downtime</h3>
  <p>429/502/timeout? Silently cascades to next healthy source. <b>No error ever reaches your tool.</b></p>
</td>
<td width="25%" align="center">
  <h3>⚡ Rate Stacking</h3>
  <p>7 keys × 5 RPM = <b>35 RPM</b>. Weighted random + cooldown tracking + recovery-order sorting.</p>
</td>
<td width="25%" align="center">
  <h3>🧠 MOA Fusion</h3>
  <p>Multi-model parallel dispatch → judge synthesis. Auto roles: Executor / Advisor / Reviewer.</p>
</td>
<td width="25%" align="center">
  <h3>💰 Token Saving</h3>
  <p>4-layer pipeline (RTK + Headroom + Caveman + Ponytail). <b>20-40% less tokens</b>, zero quality loss.</p>
</td>
</tr>
</table>

```
 Performance
 ─────────────────────────────────────────────────
 Failover     ████████████████████████████████  99.9%
 Token Saved  ████████████████████░░░░░░░░░░░░  20-40%
 Recovery     ████████████████████████████████  <5s
 Providers    ████████████████████████████████  40+
 ─────────────────────────────────────────────────
```

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
