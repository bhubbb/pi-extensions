# pi-llama

Multi-backend llama.cpp Pi extension. Auto-discovers models from one or more llama.cpp servers and registers them as separate providers in [pi](https://pi.dev).

## What changed (v0.2.0)

- **Multiple backends**: Configure and use multiple llama.cpp servers from `/model`.
- **Settings file**: `~/.pi/agent/pi-llama.json` replaces env vars as primary config.
- **Legacy compat**: `LLAMA_BASE_URL` / `LLAMA_API_KEY` env vars still work for single-backend mode.

## Install

**From the shell:**

```bash
pi install git:github.com/huggingface/pi-llama
```

This clones to `~/.pi/agent/packages/pi-llama/` and adds an entry to your pi settings. Every future `pi` invocation auto-loads it.

**From inside an interactive pi session:**

```
!pi install git:github.com/huggingface/pi-llama
```

Then run `/reload` (or restart pi) to load the extension.

**Dev mode:**

```bash
git clone https://github.com/huggingface/pi-llama ~/code/pi-llama
pi -e ~/code/pi-llama/src/index.ts
```

`-e` loads the extension only for the current session, useful while developing.

## Configuration

### Settings file (primary)

Settings are saved to `~/.pi/agent/pi-llama.json`:

```json
{
  "version": 1,
  "backends": [
    {
      "baseUrl": "http://localhost:8080/v1"
    },
    {
      "baseUrl": "http://remote-server:8080/v1",
      "apiKey": "my-api-key"
    }
  ]
}
```

Each backend is auto-discovered: models listed on the server appear under their own provider (`llama-cpp`, `llama-cpp-1`, etc.) in `/model`.

Use `/llama-setup` inside pi for an interactive TUI wizard to add/edit/remove backends.

### Legacy environment variables (single-backend)

For backward compatibility, the env vars below configure a **single** backend:

| Variable | Default | Description |
|---|---|---|
| `LLAMA_BASE_URL` | `http://localhost:8080/v1` | llama.cpp server endpoint |
| `LLAMA_API_KEY` | `no-key` | API key (or env var name) |

If `LLAMA_BASE_URL` is set, env vars take precedence over the settings file.

### models.json fallback

If no env var and no settings file exist, `~/.pi/agent/models.json` is checked for a `llama-cpp` provider entry as a last fallback.

## Usage

```bash
# 1. Install llama.cpp
curl -LsSf https://llama.app/install.sh | bash

# 2. Start one or more llama.cpp servers
llama serve --port 8080   # local
llama serve --port 8081   # remote

# 3. Launch pi
pi

# 4. Inside pi - use /llama-status to see configured backends
#    /model to select from any backend's models
#    /llama-setup to edit backend configuration
```

## Commands

| Command | Description |
|---------|-------------|
| `/llama-status` | Show all configured backends, their URLs, and model counts |
| `/llama-version` | Get build info of a llama.cpp server (`/llama-version [index]`) |
| `/llama-setup` | Interactive TUI wizard to add/edit/remove backends |

## Provider naming

All single-backend modes use `llama-cpp` for full backward compatibility. Only the settings file multi-backend mode uses numbered IDs:

- **Default** (no env vars, no settings file, no `models.json`): `llama-cpp`
- **Env var** (`LLAMA_BASE_URL`): `llama-cpp` (backward compat — single backend)
- **`models.json`** fallback: `llama-cpp` (backward compat — single backend)
- **Settings file** backends: `llama-cpp-0`, `llama-cpp-1`, `llama-cpp-2`, etc. (numbered to avoid collisions across backends)

This ensures every single-backend scenario keeps the original `llama-cpp` provider name. Only when you explicitly configure multiple backends in the settings file do you get numbered IDs.

## Settings file schema

```typescript
interface LlamaBackendConfig {
  baseUrl: string;       // API endpoint URL (required)
  apiKey?: string;       // API key (optional, default: "no-key")
  api?: string;          // API type, default: "openai-completions"
  authHeader?: boolean;  // Send Authorization: Bearer header
  prefix?: string;       // Prefix to strip from model names
  contextWindow?: number; // Default context window for offline fallback (default: 8192)
  maxTokens?: number;     // Default max output tokens for offline fallback (default: 16384)
}

interface PersistedConfig {
  version?: number;      // Config version for migrations
  backends: LlamaBackendConfig[];
}
```

## Architecture

The extension uses the following resolution priority chain:

1. `LLAMA_BASE_URL` env var → single-backend legacy mode
2. `~/.pi/agent/pi-llama.json` backends[] → multi-backend mode
3. `~/.pi/agent/models.json` `llama-cpp` provider → single-backend fallback
4. Defaults → `http://localhost:8080/v1`

Each backend is discovered independently:
- `/v1/models` lists available models
- `/props` discovers context window and thinking support per model
- `/models/sse` streams model loading progress

### Thinking models

Models with `enable_thinking` in their chat template are auto-detected and registered with full thinking level support (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Use `/settings` to pick your thinking level. The `qwen-chat-template` compat mode translates pi's thinking levels into `chat_template_kwargs.enable_thinking` for llama.cpp.

## Uninstall

```bash
pi remove git:github.com/huggingface/pi-llama
```
