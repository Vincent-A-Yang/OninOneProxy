<div align="center">

# OninOneProxy

**统一 AI API 网关 — 多提供商路由、Token 节省、智能故障转移。**

将所有 AI 编程工具连接到 40+ 提供商，通过单一端点实现自动格式转换、配额跟踪和成本优化。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Vincent-A-Yang/OninOneProxy/blob/main/LICENSE)
[![Based on 9Router](https://img.shields.io/badge/Based%20on-9Router-blue)](https://github.com/decolua/9router)

**基于 [9Router](https://github.com/decolua/9router)（作者 [decolua](https://github.com/decolua)）的衍生发行版**

</div>

---

## 归属声明与许可证

OninOneProxy 是基于 [9Router](https://github.com/decolua/9router)（作者 decolua）的**衍生发行版**，采用 [MIT 许可证](./LICENSE) 分发。

- 原 9Router 版权归属 `decolua and contributors`
- OninOneProxy 在此基础上添加了配置、提供商集成和运维增强功能
- 这**不是** 9Router 的官方分支，而是一个独立的衍生发行版

---

## 功能特性

### 9Router 基础功能（继承）

- **40+ 提供商支持** — 连接 OpenRouter、GLM、Kimi、DeepSeek 等众多提供商
- **OpenAI 兼容 API** — 单一端点（`/v1/*`）适配所有 AI 工具
- **格式转换** — 自动 OpenAI ↔ Claude ↔ Gemini 格式互转
- **多账号故障转移** — 每个提供商的账号间轮询
- **OAuth 凭据管理** — Claude Code、Codex、Cursor、GitHub OAuth 支持
- **Token 自动刷新** — 自动 OAuth token 刷新
- **配额与使用跟踪** — 按提供商/账号跟踪订阅配额和使用量
- **RTK Token 节省** — 自动压缩 tool_result 内容，节省 20-40% tokens
- **模型组合故障转移** — 订阅 → 低价 → 免费层级自动切换
- **Dashboard 仪表盘** — 提供商管理、使用统计和测试的 Web UI
- **SQLite 持久化** — 带适配器回退链的可靠数据存储

### OninOneProxy 扩展功能

- **多 APIKEY 聚合** — 每个提供商聚合多个 API Key 以提高速率限制
- **提供商速率池化** — 跨账号合并速率限制（如 7×5RPM = 35RPM）
- **HNSW 语义缓存** — 基于 HNSW 索引的向量响应缓存，优化缓存命中率
- **温度分桶守卫** — 按温度分桶缓存，保护输出正确性
- **Tools 检测** — 请求中检测到 tools 时智能绕过缓存
- **LRU 内存管理** — O(1) 淘汰 + 内存监控 + `--max-old-space-size=1024`
- **自动数据清理** — 24 小时清理定时器，带 Dashboard UI 控制
- **国内直连** — 中国大陆提供商直连绕过
- **Poe 工具调用支持** — Poe 提供商兼容的 fail-open 参数剥离
- **提供商命名验证** — `normalizeProviderId` 对无效名称返回 HTTP 400

---

## 快速开始

### 方式一：Docker 部署（推荐）

```bash
# 克隆仓库
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# 构建并运行 Docker 镜像
docker build -t oninoneproxy .
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.oninoneproxy:/app/data" \
  -e DATA_DIR=/app/data \
  --name oninoneproxy \
  oninoneproxy:latest
```

或使用 docker-compose：

```bash
docker-compose up -d
```

### 方式二：从源码运行

```bash
git clone https://github.com/Vincent-A-Yang/OninOneProxy.git
cd OninOneProxy

# 安装依赖
cp .env.example .env
npm install

# 开发模式
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev

# 生产模式
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

### 访问地址

- **Dashboard 仪表盘**: http://localhost:20128/dashboard
- **OpenAI 兼容 API**: http://localhost:20128/v1

### 连接你的 AI 工具

配置 AI 编程工具（Claude Code、Codex、Cursor 等）：

```
端点: http://localhost:20128/v1
API Key: [从 Dashboard 复制]
模型: [从 Dashboard 提供商列表选择]
```

---

## 环境变量

复制 `.env.example` 到 `.env` 并配置：

### 必需变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | 会话 cookie 签名密钥 | 需自行生成 |
| `INITIAL_PASSWORD` | 初始管理员密码 | 必须覆盖 |
| `API_KEY_SECRET` | API Key 生成密钥 | 需自行生成 |
| `MACHINE_ID_SALT` | 机器 ID 生成盐 | 需自行生成 |

### 可选变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务器端口 | `20128` |
| `HOSTNAME` | 服务器主机名 | `0.0.0.0` |
| `DATA_DIR` | 数据目录路径 | `~/.oninoneproxy/` |
| `DEBUG` | 调试模式 | `false` |
| `HEADROOM_URL` | Headroom token 节省服务 URL | (禁用) |
| `NEXT_PUBLIC_BASE_URL` | 公共基础 URL | `http://localhost:20128` |

> **安全提示**：切勿提交 `.env` 文件。`.gitignore` 已排除 `.env*` 文件（`.env.example` 除外）。

---

## 与 9Router 的关系

OninOneProxy 是 [9Router](https://github.com/decolua/9router) 的**衍生发行版**：

- **非官方分支** — 本项目独立维护
- **保留归属** — 原 9Router 版权（`decolua and contributors`）在 LICENSE 中保留
- **添加运维扩展** — 多 APIKEY 聚合、HNSW 缓存、内存管理等
- **共享上游改进** — 通用改进可贡献回 9Router

---

## 许可证

[MIT License](./LICENSE) — Copyright (c) 2024-2026 decolua and contributors

---

## 致谢

- **[9Router](https://github.com/decolua/9router)** by [decolua](https://github.com/decolua) — 本发行版所基于的原始项目
- 所有构建了基础的 9Router 贡献者