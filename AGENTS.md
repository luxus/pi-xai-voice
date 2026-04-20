# Agent Guide: pi-xai-voice
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
## Project Overview

This is a **Pi extension for xAI voice/音频 workflows**. It reuses the core infrastructure from `pi-xai-imagine` via file copy (not git submodule or package) for simplicity.

## Copied Core Files

These files were copied from `~/projects/pi-xai-imagine` and should stay in sync manually:

```
xai-client.ts       → XaiClient class (fetch, download, healthcheck)
xai-config.ts       → Config resolution with namespace support
xai-media-shared.ts → Constants, types, asset helpers
xai-media.ts        → Clean re-exports of all core modules
xai-image.ts        → Image workflows (reusable, may be unused here)
xai-video.ts        → Video workflows (reusable, may be unused here)
xai-understanding.ts → Vision API (reusable, may be unused here)
```

## Project-Specific Files

```
xai-voice.ts        → Voice-specific implementation (your new code here)
index.ts            → Extension entry point, tool registration
```

## Usage Pattern

Import from the copied core:

```typescript
import { XaiClient, getRequiredXaiApiKey, resolveXaiConfig } from "./xai-media.ts";

// Build runtime from config
const config = resolveXaiConfig();
const { apiKey } = getRequiredXaiApiKey(config);
const client = new XaiClient({ apiKey, baseUrl: config.xai.baseUrl });

// Make API calls
const health = await client.health();
```

## Config Namespace

This extension uses the `xai.voice` subsection:

```json
{
  "xai": {
    "apiKey": "xai-...",
    "baseUrl": "https://api.x.ai/v1",
    "voice": {
      "model": "grok-tts",
      "defaultVoice": "alloy"
    }
  }
}
```

Config sources (priority order):
1. `XAI_API_KEY` env var
2. `./.pi/settings.json` (project-level)
3. `~/.pi/agent/settings.json` (user-level)

## Syncing with Upstream

When `pi-xai-imagine` core files get fixes/improvements:

```bash
# Copy updated files
cp ~/projects/pi-xai-imagine/xai-client.ts ~/projects/pi-xai-voice/
cp ~/projects/pi-xai-imagine/xai-config.ts ~/projects/pi-xai-voice/
# ... etc for other core files
```

Do NOT modify copied core files in this project — changes will be lost on next sync.

## Adding Voice Tools

1. Implement voice API calls in `xai-voice.ts`
2. Use `XaiClient` for HTTP (follow pattern in `xai-image.ts`)
3. Register tools in `index.ts` with Typebox schemas
4. Add voice-specific config types to `xai-config.ts` (if needed, sync back to upstream)
