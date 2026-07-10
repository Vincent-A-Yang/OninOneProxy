# OninOneProxy Fork 策略研究报告

**生成时间**: 2026-07-10
**关联项目**: OninOneProxy (https://github.com/Vincent-A-Yang/OninOneProxy)
**上游项目**: 9Router (https://github.com/decolua/9router)

---

## 1. 背景与上游状态

### 1.1 9Router 上游仓库状态（2026-07-10 核实）

| 属性 | 值 |
|------|-----|
| 仓库 URL | https://github.com/decolua/9router |
| 默认分支 | `master` |
| License | MIT |
| Fork 数 | 3613 |
| Open Issues | 1083 |
| 最新 Release | v0.5.20 (2026-07-07) |
| 最近推送 | 2026-07-07 |
| 活跃度 | 高（每日提交，3 天前发布新版本） |

**关键观察**：
- 上游使用 `master` 分支，OninOneProxy 使用 `main` 分支
- OninOneProxy v0.5.20 与上游版本号对齐
- 上游活跃度高，需定期同步以避免过度偏离

### 1.2 OninOneProxy 当前状态

| 属性 | 值 |
|------|-----|
| 仓库 URL | https://github.com/Vincent-A-Yang/OninOneProxy |
| 默认分支 | `main` |
| License | MIT（保留 `Copyright (c) 2024-2026 decolua and contributors`） |
| 基础版本 | v0.5.20（对齐上游） |
| 推送方式 | 独立仓库（非 GitHub Fork） |
| OAuth 凭据 | 已替换为占位符（Gemini CLI / Antigravity） |

---

## 2. Fork 策略选项分析

### 2.1 选项 A：GitHub Fork 关系

**描述**：通过 GitHub UI Fork `decolua/9router`，在 fork 基础上构建 OninOneProxy。

**优点**：
- GitHub 自动显示 "forked from decolua/9router"，社区认知清晰
- 可通过 GitHub UI 一键同步上游
- 标准开源协作模式

**缺点**：
- **致命**：每个 GitHub 账户只能 fork 一个仓库一次。OninOneProxy 已作为独立仓库推送，改为 fork 需删除现有仓库 → 失去已推送代码和 OAuth 替换
- Fork 关系在 GitHub 上**永久性**，无法自行撤销（需 GitHub support ticket）
- Fork 默认分支继承上游（`master`），而 OninOneProxy 已使用 `main`
- Fork 会被 GitHub 视为派生仓库，某些功能受限
- 所有提交显示在 GitHub fork 网络中，可能暴露定制化改动

**适用场景**：尚未推送独立仓库、且希望最大化 GitHub 协作信号的场景。

### 2.2 选项 B：独立仓库 + upstream remote（推荐）

**描述**：保持 `Vincent-A-Yang/OninOneProxy` 为独立仓库，通过 `git remote add upstream` 跟踪上游。

**优点**：
- **已落地**：仓库已推送，无需破坏性操作
- 完全控制仓库，无 fork 关系约束
- 可选择性 cherry-pick 上游变更，避免不兼容改动
- 可维护 OninOneProxy 专属分支
- 分支命名自由（`main` vs `master`）
- MIT License 允许衍生作品无需正式 fork 关系
- README 已明确归属 9Router

**缺点**：
- 无 GitHub 自动 fork 关系显示
- 同步上游需手动操作
- 社区需通过 README 识别衍生关系

**适用场景**：长期维护独立项目、需选择性同步上游的场景。

### 2.3 选项 C：9Router 仓库新分支

**描述**：Fork 9router 后，在 fork 中创建 `oninoneproxy` 分支。

**优点**：
- 维持 fork 关系
- 可通过分支隔离定制化

**缺点**：
- 混淆分支用途（`master` 跟踪上游 vs `oninoneproxy` 定制化）
- 难以保持干净的分离
- 与选项 A 有相同的 fork 永久性问题
- 不适合长期维护独立项目

**适用场景**：短期实验、贡献回上游单一 PR 的场景。

---

## 3. 推荐方案：选项 B（独立仓库 + upstream remote）

### 3.1 推荐理由

1. **已落地**：OninOneProxy 已作为独立仓库推送，选项 B 无需破坏性操作
2. **灵活性**：可选择性同步上游变更，避免上游不兼容改动破坏 OninOneProxy 定制
3. **合规性**：MIT License 明确允许衍生作品，README 已归属 9Router
4. **可持续性**：长期维护独立项目最稳健的方式
5. **社区认知**：通过 README、LICENSE、CHANGELOG 中的归属声明，社区可识别衍生关系

### 3.2 实施步骤

```bash
# 在 OninOneProxy 发行版目录
cd "F:\AllinAi\MyProject\OninOneProxy\OninOneProxy-发行版"

# 添加 upstream remote（跟踪 9Router 上游）
git remote add upstream https://github.com/decolua/9router.git

# 验证 remote 配置
git remote -v
# 期望输出：
# origin    https://github.com/Vincent-A-Yang/OninOneProxy.git (fetch)
# origin    https://github.com/Vincent-A-Yang/OninOneProxy.git (push)
# upstream  https://github.com/decolua/9router.git (fetch)
# upstream  https://github.com/decolua/9router.git (push)

# 定期同步上游（建议每月一次或上游发布新版本时）
git fetch upstream

# 方式 1：merge 上游 master（保留合并历史）
git merge upstream/master --no-ff

# 方式 2：cherry-pick 特定 commit（选择性采纳）
git cherry-pick <commit-sha>

# 如有冲突，手动解决后 commit
```

### 3.3 同步策略建议

| 场景 | 策略 |
|------|------|
| 上游发布安全修复 | 立即 cherry-pick 到 `main` |
| 上游发布新版本（如 v0.5.21） | 评估后 merge `upstream/master` |
| 上游重大重构 | 延迟同步，先在分支测试 |
| 上游新增 provider | cherry-pick 相关 commit |
| 上游修改 OAuth 凭据 | **不同步**（OninOneProxy 保留占位符） |

---

## 4. 贡献路径分析

### 4.1 可贡献回 9Router 的通用改进

以下改进**不包含 OninOneProxy 专属功能**，适合贡献回上游：

1. **Bug 修复**：
   - `providers-baseline.json` 中的配置错误
   - 各 provider 适配器的 bug 修复
   - 测试覆盖改进

2. **性能优化**：
   - 内存监控机制（如已在 OninOneProxy 实现）
   - LRU O(1) 淘汰算法
   - SQLite 自动清理逻辑

3. **基础设施**：
   - Docker 部署优化
   - `.dockerignore` / `.gitignore` 改进
   - 文档改进（英文/中文）

4. **新增 provider 适配**：
   - 通用 provider 适配器（不含多账户聚合逻辑）

### 4.2 OninOneProxy 专属功能（不贡献）

以下功能为 OninOneProxy 定制化，**不应贡献回上游**：

1. **多账户聚合**：
   - inferera.com 7 账户聚合（35 RPM / 3500 RPD）
   - 多 APIKEY 加权选择算法

2. **国内网络适配**：
   - `DOMESTIC_DIRECT_HOSTS` 国内直连
   - Clash 代理绕过逻辑

3. **运维集成**：
   - 与 CPA / OmniRoute 的集成
   - 内部审计日志定制
   - OninOneProxy 品牌定制

4. **OAuth 占位符替换**：
   - Gemini CLI / Antigravity OAuth 凭据已替换为占位符
   - 上游保留真实公开 CLI 凭据（GitHub Push Protection 仅对派生仓库生效）
   - **此改动不贡献回上游**

### 4.3 向 9Router 提交 PR 的流程

#### 4.3.1 准备阶段

由于 OninOneProxy 是独立仓库（非 fork），贡献回上游需**独立的 9router fork**：

```bash
# 方式 1：通过 gh CLI fork（如果账户尚未 fork 过 9router）
gh repo fork decolua/9router --clone=true --remote=true
# 这会克隆到当前目录的 9router/ 文件夹

# 方式 2：手动克隆已有 fork
git clone https://github.com/Vincent-A-Yang/9router.git 9router-contribution
cd 9router-contribution
git remote add upstream https://github.com/decolua/9router.git
```

**注意**：此 `9router` fork 专为 PR 贡献，与 OninOneProxy 独立仓库分离。

#### 4.3.2 开发阶段

```bash
# 进入贡献用 fork
cd 9router-contribution

# 同步上游 master
git fetch upstream
git checkout master
git merge upstream/master --ff-only

# 创建 feature 分支（基于 master）
git checkout -b fix/some-bug master

# 开发 + 测试
# ... 修改代码 ...
npm test  # 或项目指定的测试命令

# 提交
git add <files>
git commit -m "fix: <description>"

# 推送
git push origin fix/some-bug
```

#### 4.3.3 PR 阶段

```bash
gh pr create --repo decolua/9router \
  --base master \
  --head Vincent-A-Yang:fix/some-bug \
  --title "fix: <description>" \
  --body "## Changes
- <change 1>
- <change 2>

## Testing
- [x] Ran \`npm test\`
- [x] Manually verified <scenario>

## Context
<why this change is needed>"
```

#### 4.3.4 注意事项

- PR 必须基于上游 `master` 分支（**不是** OninOneProxy 的 `main`）
- PR **不应**包含 OninOneProxy 专属功能
- PR **不应**包含 OAuth 占位符替换（上游保留真实公开 CLI 凭据）
- 遵循 9Router 的 `CONTRIBUTING.md`（如存在）
- 确保 PR 通过 9Router 的 CI 检查
- 每个 PR 聚焦单一改动，便于 review

### 4.4 贡献路径建议

#### 短期（1-3 个月）
- 识别 OninOneProxy 中纯 bug 修复的部分
- 通过独立的 9router fork 提交 PR
- 保持每个 PR 聚焦单一改动

#### 中期（3-6 个月）
- 建立定期同步 upstream 的流程（每月一次）
- 识别可贡献的通用改进
- 与 9Router 维护者沟通大型改动

#### 长期（6+ 个月）
- 评估是否需要更紧密的协作关系
- 考虑成为 9Router 的活跃贡献者
- 或保持独立项目并持续 cherry-pick 上游改进

---

## 5. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 上游重大重构导致冲突 | 定期同步 + 保持改动最小化 + 模块化定制 |
| 上游安全漏洞修复延迟 | 监控上游 release + 及时 cherry-pick 安全修复 |
| 双重维护负担 | 优先贡献通用改动回上游 + 保持 OninOneProxy 专属功能隔离 |
| Fork 关系混淆 | README 明确声明独立项目身份 + LICENSE 保持原 Copyright |
| 分支命名差异（main vs master） | 同步时注意分支映射，`upstream/master` → 本地 `main` |
| OAuth 凭据同步冲突 | 同步上游时**跳过** OAuth 相关文件，保留 OninOneProxy 占位符 |

---

## 6. 结论

**推荐方案**：选项 B（独立仓库 + upstream remote）作为 OninOneProxy 的长期维护策略。

**理由**：
1. 此方案已落地（仓库已推送至 `Vincent-A-Yang/OninOneProxy`）
2. 合规（MIT License + README 归属声明）
3. 灵活（选择性同步上游，避免不兼容改动）
4. 可持续（长期维护独立项目最稳健方式）

**贡献回 9Router**：通过**独立的 9router fork** 进行，与 OninOneProxy 仓库分离，避免混淆。PR 基于上游 `master` 分支，不包含 OninOneProxy 专属功能或 OAuth 占位符替换。

**下一步行动**：
1. 在 OninOneProxy 发行版目录添加 `upstream` remote
2. 建立定期同步流程（建议每月一次）
3. 识别首批可贡献回 9Router 的通用改进
4. 在需要贡献时，通过 `gh repo fork decolua/9router` 创建贡献用 fork

---

## 附录 A：相关文件

- `README.md` — OninOneProxy 公开发行版 README（含 9Router 归属声明）
- `LICENSE` — MIT License（保留 `Copyright (c) 2024-2026 decolua and contributors`）
- `CHANGELOG.md` — 历史变更日志（保留 decolua 署名）
- `package.json` — 项目元信息（`repository` 指向 Vincent-A-Yang/OninOneProxy）