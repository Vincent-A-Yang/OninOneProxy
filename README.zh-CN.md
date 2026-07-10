<div align="center">

# OninOneProxy

**统一 AI 网关 — 多提供商路由、Token 节省、语义缓存、智能故障转移。**

将所有 AI 编程工具（Claude Code、Cursor、Codex、Cline）通过单一 OpenAI 兼容端点连接到 40+ 提供商。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Vincent-A-Yang/OninOneProxy/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub Stars](https://img.shields.io/github/stars/Vincent-A-Yang/OninOneProxy?style=social)](https://github.com/Vincent-A-Yang/OninOneProxy)

**基于 [9Router](https://github.com/decolua/9router)（作者 [decolua](https://github.com/decolua)）的衍生发行版**

</div>

---

## 目录

- [为什么选择 OninOneProxy？](#为什么选择-oninoneproxy)
- [功能特性](#功能特性)
- [功能对比](#功能对比)
- [快速开始](#快速开始)
- [支持的 CLI 工具](#支持的-cli-工具)
- [环境变量](#环境变量)
- [架构](#架构)
- [与 9Router 的关系](#与-9router-的关系)
- [贡献指南](#贡献指南)
- [开发](#开发)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 为什么选择 OninOneProxy？

OninOneProxy 是一个统一的 **AI 网关** 和 **大模型代理**，将一堆 API Key、OAuth 令牌和互不兼容的请求格式整理成一个干净的、OpenAI 兼容的端点。以下是它与通用多提供商路由器的差异化卖点。

### 1. 多协议统一

不再为各提供商专用 SDK 纠缠。OninOneProxy 在 OpenAI、Anthropic（Claude）、Gemini 请求格式之间透明转换，因此你的 **Claude Code 代理**、**Cursor 代理** 和 Codex 配置都说着同一套 `/v1/*` API。无论你的工具发出的是 `messages`（Anthropic）、`contents`（Gemini）还是 `chat/completions`（OpenAI），网关都会即时归一化，并将响应翻译回你的客户端所期望的格式。

### 2. 设计即 Token 节省

每个请求都经过 RTK（Result Token Kit）管道压缩冗长的 `tool_result` 负载，外加可选的 Headroom、Caveman、Ponytail 节省器。这些组合可将 Token 消耗降低 **20–40%**，且不改变模型所见的语义内容——降低每次调用的延迟与订阅消耗。

### 3. 带正确性守卫的语义缓存

基于向量的 **语义缓存**（HNSW 索引）从缓存服务重复和近似重复的提示，大幅削减重跑成本。两道守卫保证正确性：

- **温度分桶守卫** —— 只在严格温度分桶内缓存，因此 `temperature=0.2` 与 `temperature=0.9` 永不冲突。
- **Tools 检测** —— 当请求包含 `tools` 时，缓存自动绕过，工具调用回合始终是新鲜的。

### 4. 智能路由与 Fusion 协作

**智能路由** 为每个请求挑选最便宜健康的提供商，采用订阅 → 低价 → 免费的分层故障转移。OninOneProxy 还引入 **Fusion 多模型协作**：单个请求可并行分发到多个模型，再由 judge 模型综合审查——无需编排多个客户端即可获得共识式答案。

### 5. 多账户聚合与速率池化

为每个提供商池化多个 API Key 并聚合其速率限制。七个 5 RPM 账户合并成一个 **35 RPM** 预算——非常适合会触及单 Key 上限的突发负载。OAuth 凭据轮换与防封禁逻辑让多账户配置在长会话中保持稳定。

---

## 功能特性

### 核心功能

- **40+ 提供商支持** —— OpenRouter、GLM、Kimi、DeepSeek、GitHub Copilot、Claude Code、Codex、Cursor OAuth 等
- **OpenAI 兼容 API** —— 单一 `/v1/*` 端点服务所有 AI 工具
- **格式转换** —— 自动 OpenAI ↔ Claude ↔ Gemini 互转
- **多账户故障转移** —— 每个提供商的账户间轮询
- **OAuth 凭据管理** —— Claude Code、Codex、Cursor、GitHub OAuth 支持
- **Token 自动刷新** —— 自动 OAuth token 刷新
- **配额与使用跟踪** —— 按提供商/账户跟踪订阅配额和使用量

### 高级功能

- **HNSW 语义缓存** —— 基于 HNSW 索引的向量响应缓存，优化缓存命中率
- **温度分桶守卫** —— 按温度分桶缓存，保护输出正确性
- **Tools 检测** —— 请求中检测到 tools 时智能绕过缓存
- **多 APIKEY 聚合** —— 每个提供商聚合多个 API Key 以提高速率限制
- **速率限制池化** —— 跨账户合并速率限制（如 7×5RPM = 35RPM）
- **Fusion 多模型协作** —— 并行多模型分发 + 综合审查
- **RTK Token 节省** —— 自动压缩 tool_result 内容，节省 20-40% tokens
- **LRU 内存管理** —— O(1) 淘汰 + 内存监控 + `--max-old-space-size=1024`

### 运维与部署

- **Docker 支持** —— `docker-compose up -d` 一键部署
- **Dashboard Web UI** —— 提供商管理、使用统计、模型测试
- **SQLite 持久化** —— 带适配器回退链的可靠数据存储
- **自动数据清理** —— 24 小时清理定时器，带 Dashboard UI 控制
- **国内直连** —— 中国大陆提供商直连绕过
- **提供商命名验证** —— `normalizeProviderId` 对无效名称返回 HTTP 400

---

## 功能对比

| 功能 | OninOneProxy | 9Router | One API | New API |
|---------|:---:|:---:|:---:|:---:|
| 多提供商路由 | ✅ | ✅ | ✅ | ✅ |
| OpenAI 兼容 API | ✅ | ✅ | ✅ | ✅ |
| 格式转换（OpenAI↔Claude↔Gemini） | ✅ | ✅ | ❌ | ❌ |
| 语义缓存（HNSW） | ✅ | ❌ | ❌ | ❌ |
| 温度分桶守卫 | ✅ | ❌ | ❌ | ❌ |
| Tools 检测（缓存绕过） | ✅ | ❌ | ❌ | ❌ |
| 多 APIKEY 聚合 | ✅ | ❌ | ❌ | ❌ |
| 速率限制池化 | ✅ | ❌ | ❌ | ❌ |
| RTK Token 节省 | ✅ | ✅ | ❌ | ❌ |
| Fusion 多模型协作 | ✅ | ❌ | ❌ | ❌ |
| OAuth 凭据管理 | ✅ | ✅ | ❌ | ❌ |
| 国内直连（中国） | ✅ | ❌ | ❌ | ❌ |
| Dashboard Web UI | ✅ | ✅ | ✅ | ✅ |

---

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# 2. 配置
cp .env.example .env
# 编辑 .env：设置 JWT_SECRET, INITIAL_PASSWORD, API_KEY_SECRET

# 3. 构建并运行
docker-compose up -d

# 4. 访问 Dashboard
# 打开 http://localhost:20130/dashboard

# 5. 连接你的 AI 工具
# 端点: http://localhost:20130/v1
# API Key: [从 Dashboard 复制]
```

### 从源码运行（替代方案）

```bash
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy
cp .env.example .env
npm install

# 开发模式
PORT=20130 NEXT_PUBLIC_BASE_URL=http://localhost:20130 npm run dev

# 生产模式
npm run build
PORT=20130 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20130 npm run start
```

### 访问地址

- **Dashboard 仪表盘**: http://localhost:20130/dashboard
- **OpenAI 兼容 API**: http://localhost:20130/v1

### 连接你的 AI 工具

配置 AI 编程工具（Claude Code、Codex、Cursor 等）：

```
端点:   http://localhost:20130/v1
API Key: [从 Dashboard 复制]
模型:    [从 Dashboard 提供商列表选择]
```

---

## 支持的 CLI 工具

OninOneProxy 作为通用 **API 路由** 与所有主流 AI 编程工具协同工作：

| 工具 | 状态 |
|------|--------|
| Claude Code | ✅ 已支持 |
| Codex | ✅ 已支持 |
| Cursor | ✅ 已支持 |
| OpenCode | ✅ 已支持 |
| Cline | ✅ 已支持 |
| Copilot | ✅ 已支持 |
| Antigravity | ✅ 已支持 |
| OpenClaw | ✅ 已支持 |
| Continue | ✅ 已支持 |
| Roo / Kilo Code | ✅ 已支持 |

---

## 环境变量

复制 `.env.example` 到 `.env` 并配置。

### 必需变量

| 变量 | 说明 | 默认值 |
|----------|-------------|---------|
| `JWT_SECRET` | 会话 cookie 签名密钥 | 需自行生成 |
| `INITIAL_PASSWORD` | 初始管理员密码 | 必须覆盖 |
| `API_KEY_SECRET` | API Key 生成密钥 | 需自行生成 |
| `MACHINE_ID_SALT` | 机器 ID 生成盐 | 需自行生成 |

### 可选变量

| 变量 | 说明 | 默认值 |
|----------|-------------|---------|
| `PORT` | 服务器端口 | `20130` |
| `HOSTNAME` | 服务器主机名 | `0.0.0.0` |
| `DATA_DIR` | 数据目录路径 | `~/.oninoneproxy/` |
| `DEBUG` | 调试模式 | `false` |
| `HEADROOM_URL` | Headroom Token 节省服务 URL | (禁用) |
| `NEXT_PUBLIC_BASE_URL` | 公共基础 URL | `http://localhost:20130` |

> **安全提示**：切勿提交 `.env` 文件。`.gitignore` 已排除 `.env*` 文件（`.env.example` 除外）。

---

## 架构

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

完整架构详情见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

---

## 与 9Router 的关系

OninOneProxy 是 [9Router](https://github.com/decolua/9router) 的**衍生发行版**：

- **非官方分支** —— 本项目独立维护
- **保留归属** —— 原 9Router 版权（`decolua and contributors`）在 LICENSE 中保留
- **添加运维扩展** —— 多 APIKEY 聚合、HNSW 缓存、内存管理等
- **共享上游改进** —— 通用改进可贡献回 9Router

### 回馈 9Router

有益于双方项目的通用改进欢迎通过 Pull Request 贡献回上游 9Router 仓库。OninOneProxy 专属扩展（缓存、聚合）可保留在本发行版中。

---

## 贡献指南

欢迎贡献！请查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解指南。

如需报告安全漏洞，请查看 [SECURITY.md](SECURITY.md)。

---

## 开发

### 前置条件

- Node.js ≥ 18
- npm 或 bun

### 构建

```bash
npm install
npm run build
```

### 测试

```bash
# 安装测试依赖
cd tests && npm install && cd ..

# 运行测试（从仓库根目录）
npx vitest run
```

> 测试套件在全新 checkout 上并非全绿。参见 `tests/__baseline__/` 的回归基线。

### Lint

```bash
npx eslint .
```

### 本地开发服务器

```bash
PORT=20130 NEXT_PUBLIC_BASE_URL=http://localhost:20130 npm run dev
```

---

## 许可证

[MIT License](./LICENSE) — Copyright (c) 2024-2026 decolua and contributors

---

## 致谢

- **[9Router](https://github.com/decolua/9router)** by [decolua](https://github.com/decolua) —— 本发行版所基于的原始项目
- 所有构建了基础的 9Router 贡献者
