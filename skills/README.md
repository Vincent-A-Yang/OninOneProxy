# OninOneProxy — Agent Skills

> **Attribution**: OninOneProxy is a derivative of [9Router](https://github.com/decolua/9router) by decolua. Skills are sourced from the upstream 9Router project.

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use OninOneProxy for you.

> Tip: start with the **9router** entry skill — it covers setup and links to all capability skills. Skills are sourced from the upstream [9Router](https://github.com/decolua/9router) repository.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router/SKILL.md |
| Chat / code-gen | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-image/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-web-search/SKILL.md |
| Web fetch (URL to markdown) | https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, ...):

```
Read this skill and use it: https://raw.githubusercontent.com/decolua/9router/refs/heads/master/skills/9router/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export NINEROUTER_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export NINEROUTER_KEY="sk-..."                   # from Dashboard -> Keys (only if requireApiKey=true)
```

Verify: `curl $NINEROUTER_URL/api/health` -> `{"ok":true}`.

## Links

- **OninOneProxy Source**: https://github.com/Vincent-A-Yang/OninOneProxy
- **Original 9Router**: https://github.com/decolua/9router