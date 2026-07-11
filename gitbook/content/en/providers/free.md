# Free Providers - Zero Cost Fallback

Emergency backup when everything else is quota-limited. Code 24/7 with zero cost!

---

## Overview

Free tier providers are your **fallback** when subscription and cheap quota exhausted.

The gateway registers **5 providers** in the `free` category, split into two groups:

### No-Auth Free (zero setup)

- 🆓 **MiMo Code Free** (`mimo-free`) - 1 model, no login required
- 🆓 **OpenCode Free** (`opencode`) - dynamic model list, no login required

### OAuth Free (free tier, requires login)

- 🆓 **Gemini CLI** (`gemini-cli`) - 7 models (Gemini 3.x / 2.5 family) — ⚠️ deprecated
- 🆓 **Kiro AI** (`kiro`) - 24+ models (Claude Opus/Sonnet/Haiku, DeepSeek, Qwen, GLM) — ⚠️ deprecated
- 🆓 **Qoder** (`qoder`) - 1 model (Qwen 3.7 Max) — ⚠️ deprecated

> **Note:** `iFlow` and `Qwen` are **OAuth providers**, not in the `free` category.
> They require OAuth authentication and are documented in the [OAuth Providers](./oauth.md) page.
> Do not confuse them with the no-auth free providers listed here.

**Strategy:** Use no-auth providers as instant backup (zero setup). Use OAuth free
providers for richer model selection when you can spare a one-time login.

---

## MiMo Code Free (No-Auth)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 1 model | Unlimited |

### Setup

**Zero setup — no login, no API key.** Just use it:

```
Model: mmf/mimo-auto
```

The provider routes to `https://api.xiaomimimo.com/api/free-ai/openai/chat`
with no authentication headers.

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `mmf/mimo-auto` | MiMo Auto | General coding |

### Pro Tips

- **No setup** - Works out of the box, zero configuration
- **Unlimited usage** - No quota limits
- **Passthrough models** - Supports dynamic model list from models.dev

---

## OpenCode Free (No-Auth)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | Dynamic | Unlimited |

### Setup

**Zero setup — no login, no API key.** Just use it:

```
Model: oc/<model-name>
```

The provider routes to `https://opencode.ai` with an `x-opencode-client: desktop`
header. Models are fetched dynamically from `https://opencode.ai/zen/v1/models`.

### Pro Tips

- **No setup** - Works out of the box
- **Dynamic models** - Model list updates automatically
- **Passthrough models** - Supports upstream model names

---

## Gemini CLI (OAuth Free)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 7 models | Limited (free tier) |

> ⚠️ **Deprecated:** This provider carries a risk notice. Use as fallback only.

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect Gemini CLI
```

**Step 2: Google OAuth Login**

- Click "Connect Gemini CLI"
- Browser opens → Google login page
- Grant Cloud Platform + userinfo permissions
- Auto token refresh enabled

**Step 3: Use in CLI**

```
Model: gc/gemini-3.1-pro-preview
       gc/gemini-3-pro-preview
       gc/gemini-3-flash-preview
       gc/gemini-3.1-flash-lite-preview
       gc/gemini-2.5-pro
       gc/gemini-2.5-flash
       gc/gemini-2.5-flash-lite
```

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `gc/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | Complex reasoning |
| `gc/gemini-3-pro-preview` | Gemini 3 Pro Preview | Advanced coding |
| `gc/gemini-3-flash-preview` | Gemini 3 Flash Preview | Fast responses |
| `gc/gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | Lightweight tasks |
| `gc/gemini-2.5-pro` | Gemini 2.5 Pro | General purpose |
| `gc/gemini-2.5-flash` | Gemini 2.5 Flash | Quick responses |
| `gc/gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | Minimal overhead |

---

## Kiro AI (OAuth Free)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 24+ models | Limited (free tier) |

> ⚠️ **Deprecated:** This provider carries a risk notice. Use as fallback only.

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect Kiro
```

**Step 2: AWS Builder ID or OAuth**

- Click "Connect Kiro"
- Choose login method:
  - AWS Builder ID (recommended)
  - Google account
  - GitHub account
  - Import token
- Grant permissions
- Auto token refresh enabled

**Step 3: Use in CLI**

```
Model: kr/claude-opus-4.8
       kr/claude-sonnet-5
       kr/claude-haiku-4.5
       kr/deepseek-3.2
       kr/qwen3-coder-next
       kr/glm-5
       kr/MiniMax-M2.5
```

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `kr/claude-opus-4.8` | Claude Opus 4.8 | Complex reasoning |
| `kr/claude-sonnet-5` | Claude Sonnet 5 | Balanced quality/speed |
| `kr/claude-haiku-4.5` | Claude Haiku 4.5 | Fast responses |
| `kr/deepseek-3.2` | DeepSeek 3.2 | Coding tasks |
| `kr/qwen3-coder-next` | Qwen3 Coder Next | Code generation |
| `kr/glm-5` | GLM 5 | Chinese + English |
| `kr/MiniMax-M2.5` | MiniMax M2.5 | Long context |

Thinking and agentic variants are also available (e.g., `kr/claude-opus-4.8-thinking`).

---

## Qoder (OAuth Free)

### Pricing

| Plan | Monthly Cost | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 1 model | Limited (free tier) |

> ⚠️ **Deprecated:** This provider carries a risk notice. Use as fallback only.

### Setup

**Step 1: Connect via Dashboard**

```bash
9router
# Dashboard → Providers → Connect Qoder
```

**Step 2: Device Token Login**

- Click "Connect Qoder"
- Dashboard shows device code
- Visit `https://qoder.com/device/selectAccounts`
- Enter device code
- Auto token refresh enabled

**Step 3: Use in CLI**

```
Model: qd/qmodel_latest
```

### Available Models

| Model ID | Description | Best For |
|----------|-------------|----------|
| `qd/qmodel_latest` | Qoder Qwen 3.7 Max | General coding |

---

## Feature Comparison

| Provider | Auth | Models | Best Model | Setup | Status |
|----------|------|--------|------------|-------|--------|
| **MiMo Code Free** | No-Auth | 1 | MiMo Auto | Zero | Active |
| **OpenCode Free** | No-Auth | Dynamic | Dynamic | Zero | Active |
| **Gemini CLI** | OAuth (Google) | 7 | Gemini 3.1 Pro | One-time login | ⚠️ Deprecated |
| **Kiro AI** | OAuth (AWS) | 24+ | Claude Opus 4.8 | One-time login | ⚠️ Deprecated |
| **Qoder** | OAuth (Device) | 1 | Qwen 3.7 Max | One-time login | ⚠️ Deprecated |

**Winner:** Kiro for quality (free Claude!), MiMo/OpenCode for zero-setup convenience.

---

## Usage Example

### Cursor IDE Setup

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [from 9router dashboard]
  Model: mmf/mimo-auto
```

### Create Free Combo (Recommended)

```
Dashboard → Combos → Create New

Name: free-combo
Models:
  1. mmf/mimo-auto (no-auth primary)
  2. oc/<model> (no-auth backup)
  3. kr/claude-sonnet-5 (OAuth quality)
  4. gc/gemini-3-flash-preview (OAuth speed)

Use in CLI: free-combo
```

**Result:** Zero cost, maximum uptime!

---

## Best Practices

### 1. Use as Emergency Backup

```
Priority:
1. Subscription tier (maximize paid quota)
2. Cheap tier (pennies per 1M tokens)
3. No-auth free (instant, zero setup)
4. OAuth free (richer models, one-time login)
```

### 2. Choose the Right Free Provider

```
Zero setup needed:    mmf/mimo-auto or oc/<model>
Best quality:         kr/claude-opus-4.8 or kr/claude-sonnet-5
Fast responses:       gc/gemini-3-flash-preview
Simple tasks:         mmf/mimo-auto
```

### 3. Mix No-Auth and OAuth Free

```
For zero-cost coding with maximum reliability:

Name: zero-cost
Models:
  1. mmf/mimo-auto (no-auth, always available)
  2. oc/<model> (no-auth backup)
  3. kr/claude-sonnet-5 (OAuth quality)

Cost: $0 forever!
```

---

## Troubleshooting

### "OAuth failed" (Gemini CLI / Kiro / Qoder)

**Solution:**
- Check internet connection
- Try different browser
- Clear browser cache
- Reconnect in dashboard

### "Model not available"

**Solution:**
- Check provider connected in dashboard
- Verify OAuth token valid
- Reconnect provider if needed

### "Slow responses"

**Solution:**
- Free tier may have lower priority
- Use during off-peak hours
- Switch to different free provider
- Upgrade to cheap tier for speed

---

## Limitations

### Free Tier Considerations

- **Speed** - May be slower than paid tiers
- **Priority** - Lower priority during peak hours
- **Rate limits** - Possible rate limiting (OAuth free tiers)
- **Availability** - May have occasional downtime
- **Deprecation** - Gemini CLI, Kiro, and Qoder carry risk notices

**Solution:** Use multi-provider fallback strategy for reliability!

---

## Next Steps

- **Setup OAuth providers:** [OAuth Providers](./oauth.md) (includes iFlow, Qwen)
- **Add cheap backup:** [Cheap Providers](./cheap.md)
- **Create combos:** Dashboard → Combos → Create New
- **Start coding:** Use `free-combo` combo for maximum reliability
