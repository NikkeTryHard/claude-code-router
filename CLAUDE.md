# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Build the project**:
  ```bash
  npm run build
  ```
- **Start the router server**:
  ```bash
  ccr start
  ```
- **Stop the router server**:
  ```bash
  ccr stop
  ```
- **Check the server status**:
  ```bash
  ccr status
  ```
- **Run Claude Code through the router**:
  ```bash
  ccr code "<your prompt>"
  ```
- **Release a new version**:
  ```bash
  npm run release
  ```

## Architecture

This project is a TypeScript-based router for Claude Code requests. It allows routing requests to different large language models (LLMs) from various providers based on custom rules.

- **Entry Point**: The main command-line interface logic is in `src/cli.ts`. It handles parsing commands like `start`, `stop`, and `code`.
- **Server**: The `ccr start` command launches a server that listens for requests from Claude Code. The server logic is initiated from `src/index.ts`.
- **Configuration**: The router is configured via a JSON file located at `~/.claude-code-router/config.json`. This file defines API providers, routing rules, and custom transformers. An example can be found in `config.example.json`.
- **Routing**: The core routing logic determines which LLM provider and model to use for a given request. It supports default routes for different scenarios (`default`, `background`, `think`, `longContext`, `webSearch`) and can be extended with a custom JavaScript router file. The router logic is likely in `src/utils/router.ts`.
- **Providers and Transformers**: The application supports multiple LLM providers. Transformers adapt the request and response formats for different provider APIs.
- **Claude Code Integration**: When a user runs `ccr code`, the command is forwarded to the running router service. The service then processes the request, applies routing rules, and sends it to the configured LLM. If the service isn't running, `ccr code` will attempt to start it automatically.
- **Dependencies**: The project is built with `esbuild`. It has a key local dependency `@musistudio/llms`, which probably contains the core logic for interacting with different LLM APIs.
- `@musistudio/llms` is implemented based on `fastify` and exposes `fastify`'s hook and middleware interfaces, allowing direct use of `server.addHook`.

---

## Critical Fix: Native Anthropic Format Passthrough (nativeFormat)

### Problem

When using the `antigravity` provider (which proxies to `gcli2api`), the response pipeline was broken:

1. `gcli2api` returns responses in **native Anthropic format**
2. CCR's built-in `Anthropic` transformer incorrectly tried to convert these responses **from OpenAI to Anthropic format**
3. This resulted in empty output or "Provider error" messages in `claude-code` CLI

### Solution: The `nativeFormat` Patch

A patch was applied to `@musistudio/llms` library to add a `nativeFormat` flag that bypasses response transformation.

#### Files Modified

1. **`patches/@musistudio+llms+1.0.51.patch`** - Persisted patch file (auto-applied on `npm install`)

   The patch modifies both CJS and ESM versions of the library:

   - **Bypass function** (`_0` in CJS, `h0` in ESM):

     ```javascript
     // Original
     function h0(r,e,t){return r.transformer?.use?.length===1...}

     // Patched - adds nativeFormat check at the beginning
     function h0(r,e,t){if(r.nativeFormat)return true;return r.transformer?.use?.length===1...}
     ```

   - **registerProvider call**:

     ```javascript
     // Original
     registerProvider({
       name: t.name,
       baseUrl: t.api_base_url,
       apiKey: t.api_key,
       models: t.models || [],
       transformer: t.transformer ? n : void 0,
     });

     // Patched - adds nativeFormat property
     registerProvider({
       name: t.name,
       baseUrl: t.api_base_url,
       apiKey: t.api_key,
       models: t.models || [],
       transformer: t.transformer ? n : void 0,
       nativeFormat: t.nativeFormat,
     });
     ```

2. **`~/.claude-code-router/config.json`** - Provider configuration

   ```json
   {
     "name": "antigravity",
     "api_base_url": "http://127.0.0.1:7861/antigravity/v1/messages",
     "api_key": "pwd",
     "nativeFormat": true, // <-- THIS IS THE KEY FLAG
     "models": ["claude-sonnet-4-5", "claude-opus-4-5", "gemini-3-pro-preview"],
     "transformer": {
       "use": ["xml-thinking"]
     }
   }
   ```

3. **`src/cli.ts`** - Startup fix

   ```typescript
   case "start":
     await run();  // <-- Added 'await' to prevent premature exit
     break;
   ```

4. **`~/.claude-code-router/anthropic-passthrough.js`** - Custom transformer (optional)
   - Removed the `endPoint = '/v1/messages'` property to avoid conflicts with built-in Anthropic transformer

### How It Works

1. When CCR loads a provider with `nativeFormat: true`, this flag is passed to `registerProvider()`
2. When processing a response, the library's bypass function (`h0`) checks `provider.nativeFormat`
3. If `true`, it returns `true` (bypass mode), skipping the OpenAI-to-Anthropic conversion
4. The native Anthropic response from `gcli2api` passes through unchanged to the CLI

### Applying the Patch

The patch is automatically applied via `postinstall` script in `package.json`:

```json
{
  "scripts": {
    "postinstall": "patch-package"
  }
}
```

If you need to manually apply the patch:

```bash
npx patch-package
npm run build  # IMPORTANT: Must rebuild after patching!
```

### Creating/Updating the Patch

If you modify the library and need to save a new patch:

```bash
# Make your changes to node_modules/@musistudio/llms/...
npx patch-package @musistudio/llms
# This creates/updates patches/@musistudio+llms+1.0.51.patch
```

---

## Custom Transformers

Custom transformers can be placed in `~/.claude-code-router/` and referenced in `config.json`:

### xml-thinking.js

Converts JSON thinking blocks in assistant messages to XML text format. This is needed for APIs that don't support native thinking blocks.

```javascript
class XmlThinkingTransformer {
  name = "xml-thinking";

  async transformRequestIn(body, provider, context) {
    // Converts thinking blocks to <thinking>...</thinking> XML
  }
}
```

### Usage in config.json

```json
{
  "transformers": [
    {
      "name": "xml-thinking",
      "path": "/home/user/.claude-code-router/xml-thinking.js",
      "options": {}
    }
  ],
  "Providers": [
    {
      "name": "antigravity",
      "transformer": {
        "use": ["xml-thinking"]
      }
    }
  ]
}
```

**Important**: Custom transformers should NOT set `endPoint` if they conflict with built-in transformers.

---

## Troubleshooting

### "Service startup timeout" or "Not Running" after start

1. Check if the PID file is stale:

   ```bash
   rm ~/.claude-code-router/.claude-code-router.pid
   ccr start
   ```

2. Check logs:

   ```bash
   tail -100 ~/.claude-code-router/logs/ccr-*.log | grep -i error
   ```

3. Verify transformers load correctly:
   ```bash
   node -c ~/.claude-code-router/xml-thinking.js  # Check for syntax errors
   ```

### Empty output from antigravity provider

1. Verify `nativeFormat: true` is set in config.json for the provider
2. Rebuild after patching: `npm run build`
3. Check if patch is in the bundle:
   ```bash
   grep "nativeFormat" dist/cli.js | wc -l  # Should be >= 3
   ```

### Port already in use

```bash
lsof -i :3456
# Kill the process or change PORT in config.json
```

---

## Git Policy

- 无论如何你都不能自动提交 git (Never auto-commit to git under any circumstances)
- Use atomic commits with Conventional Commits format (`feat:`, `fix:`, `refactor:`)
