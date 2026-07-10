# OninOneProxy CLI - AI Router & Token Saver

**A derivative of [9Router](https://github.com/decolua/9router) by decolua. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

> **Attribution**: This CLI is part of OninOneProxy, a derivative distribution based on [9Router](https://github.com/decolua/9router) by decolua, licensed under MIT.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Vincent-A-Yang/OninOneProxy/blob/main/LICENSE)
[![Based on 9Router](https://img.shields.io/badge/Based%20on-9Router-blue)](https://github.com/decolua/9router)

---

## Quick Start

**Option 1 — Docker (recommended):**

```bash
# Clone the repository
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# Build and run
docker build -t oninoneproxy .
docker run -d --name oninoneproxy -p 20128:20128 \
  -v "$HOME/.oninoneproxy:/app/data" -e DATA_DIR=/app/data \
  oninoneproxy:latest
```

Or with docker-compose:

```bash
docker-compose up -d
```

Dashboard opens at `http://localhost:20128`

**Option 2 — From source:**

```bash
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

cp .env.example .env
npm install

# Development
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev

# Production
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

**Connect a FREE provider (no signup needed):**

Dashboard -> Providers -> Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) -> Done!

**Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    [select from dashboard provider list]
```

---

## CLI Options

The CLI launcher (`cli/`) is published to npm as `9router` by the original 9Router project. OninOneProxy users should use the Docker or source-based deployment above.

```bash
# Original 9Router CLI (if installed)
9router                    # Start with default settings
9router --port 8080        # Custom port
9router --no-browser       # Don't open browser
9router --skip-update      # Skip auto-update check
9router --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## Supported CLI Tools

Claude-Code, OpenClaw, Codex, OpenCode, Cursor, Antigravity, Cline, Continue, Droid, Roo, Copilot, Kilo Code, Gemini CLI, Qwen Code, iFlow, Crush, Crusher, Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## Data Location

- **macOS/Linux**: `~/.9router/db/data.sqlite` (CLI) or `~/.oninoneproxy/` (Docker/source)
- **Windows**: `%APPDATA%/9router/db/data.sqlite` (CLI) or `%APPDATA%/oninoneproxy/` (Docker/source)
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.oninoneproxy` to persist)

---

## Documentation

- **OninOneProxy GitHub**: https://github.com/Vincent-A-Yang/OninOneProxy
- **Original 9Router**: https://github.com/decolua/9router
- **Full README**: https://github.com/Vincent-A-Yang/OninOneProxy/blob/main/README.md

---

## Acknowledgments

- **[9Router](https://github.com/decolua/9router)** by [decolua](https://github.com/decolua) - The original project this derivative is based on
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation that inspired 9Router

## License

MIT License - see [LICENSE](../LICENSE) for details.

Copyright (c) 2024-2026 decolua and contributors