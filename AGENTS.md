# Agent Guide: pi-xai-voice

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

---

# Agent Behavioral Contract

These rules override all other instructions when they conflict. They exist to reduce LLM coding drift, over-engineering, and speculative changes.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
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
- If you notice unrelated dead code, mention it — don't delete it.

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

# Agent Execution Protocol (Kimi K2.x)

Operational execution rules for this coding agent session. Kimi K2.6 is strong for long-horizon coding and tool use, but that strength needs strict scope control to avoid fast drift.

## 5. Operational, Not Conversational

Work from explicit instructions. If the user's request is vague, stop and clarify. Do not proceed on best-guess intent.

**Pattern:** `read-before-write → evidence-before-action → minimal diff → verify-before-report`

## 6. Read Before Write

Do not infer repository paths, APIs, helpers, or behavior. Confirm facts by:

1. Reading files explicitly (`read`, `grep`, `find_files`).
2. Following local project docs (AGENTS.md, README.md, docs/).
3. Running verification commands before claiming understanding.

## 7. Lock the Scope

- No opportunistic refactors.
- No unrelated cleanup.
- No files outside the target set.
- If the user asks for X, deliver X. Do not also deliver Y because "it might be useful."

## 8. Define Stop Gates

Ambiguity, missing files, conflicting docs, forbidden commands, or unclear scope should produce **BLOCKED**. Stop and ask before proceeding.

Do not proceed with best-guess assumptions. Surface uncertainty explicitly.

## 9. Require Proof, Not Confidence

Confirm work with actual checks before claiming success:

- Run tests (`npm test`, domain-specific suites).
- Check logs or command output.
- Verify file contents match intent.
- Re-read your own edits to ensure correctness.

## 10. Compaction Recovery

For long tasks, recovery state must be inspectable:

- Use `git diff` to show current changes.
- Track modified files explicitly.
- Persist verification state.
- Keep a running result artifact if the task spans multiple turns.

## References

- Moonshot — Best Practices for Prompts: https://platform.kimi.ai/docs/guide/prompt-best-practice
- MoonshotAI — Kimi CLI / Kimi Code CLI: https://github.com/MoonshotAI/kimi-cli
- Moonshot — Kimi K2.6 technical blog: https://www.kimi.com/blog/kimi-k2-6

---

# Project Context

## 0. Meta-Protocol Principles

- `Constraint-Driven Evolution`: Add structure when the extension gains real operator or runtime constraints
- `Single Source of Truth`: Keep durable rules in `AGENTS.md`, open work in `BACKLOG.md`, completed delivery in `CHANGELOG.md`, and deeper technical detail in `/docs`
- `Boundary Clarity`: Separate voice synthesis concerns, π integration concerns, Telegram bridge concerns, and release/documentation state
- `Progressive Enhancement + Graceful Degradation`: Prefer behavior that upgrades automatically when richer runtime context exists, but always preserves a useful fallback path when it does not
- `Runtime Safety`: Prefer queue and rendering behavior that fails predictably over clever behavior that can desynchronize the voice pipeline from π session state
- `Pi-Native Extensibility`: `pi-xai-voice` should inherit π's own extension philosophy. It is not only a voice API wrapper; it should become a small, convenient, composable voice layer for π extensions, where new capabilities plug into stable contracts.

## 1. Concept

`pi-xai-voice` is a Pi extension for xAI voice/音频 workflows. It provides TTS (text-to-speech), STT (speech-to-text), and realtime voice APIs via xAI's Grok voice endpoints. The extension also integrates with `pi-telegram` for voice-first Telegram bot interactions.

## 2. Identity & Naming Contract

- `Voice turn`: One unit of voice input processed by π; this may represent one message or a coalesced media group
- `Voice reply`: A spoken response delivered as a Telegram voice message or local audio playback
- `Speech tags`: Inline cues for TTS delivery style such as `[pause]`, `[laugh]`, `<whisper>`, `<slow>`, `<emphasis>`
- `Transparent voice`: Automatic voice-in → voice-out delivery where pi-telegram handles conversion without explicit LLM markup

## 3. Project Topology

- `/index.ts`: Extension entrypoint and tool registration
- `/voice-*.ts`: Voice-specific implementation files
  - `voice-adapter.ts`: Core voice adapter for TTS/STT API calls
  - `voice-cli.ts`: Command-template friendly CLI for bridge integrations
  - `voice-settings.ts`: Voice preferences, settings dialog, and persistence
  - `voice-telegram-bus.ts`: pi-telegram interop bus (preferences, guidance, handler registration)
  - `voice-editor.ts`: Push-to-talk editor wrapper for Pi
  - `local-audio.ts`: Local mic capture + playback helpers
- `/xai-*.ts`: Core xAI media files (copied from pi-xai-imagine)
  - `xai-client.ts`, `xai-config.ts`, `xai-media-shared.ts`, `xai-media.ts`
  - `xai-image.ts`, `xai-video.ts`, `xai-understanding.ts` (reusable, may be unused here)
- `/README.md`: User-facing project entry point
- `/AGENTS.md`: Durable engineering and runtime conventions (this file)
- `/CHANGELOG.md`: Completed delivery history

## 4. Core Files

### Copied from pi-xai-imagine (sync manually, do not modify)

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

### Project-Specific Files

```
xai-voice.ts        → Voice-specific implementation (TTS, STT, realtime)
voice-adapter.ts    → Clean adapter interface for TTS/STT
voice-cli.ts        → CLI wrappers for bridge integrations
voice-settings.ts   → Preference schema, defaults, settings dialog
voice-telegram-bus.ts → pi-telegram zero-coupling interop bus
voice-editor.ts    → Pi editor voice shortcut integration
local-audio.ts     → Local mic capture and playback
index.ts           → Extension entry point, tool registration
```

## 5. Config Namespace

This extension uses the `xai.voice` subsection:

```json
{
  "xai": {
    "apiKey": "xai-...",
    "baseUrl": "https://api.x.ai/v1",
    "voice": {
      "model": "grok-tts",
      "defaultVoice": "alloy",
      "defaultLanguage": "en",
      "ephemeralTokenSeconds": 300,
      "microphoneDeviceIndex": 0,
      "sttLanguage": "de",
      "shortcut": "alt+m",
      "shortcutMode": "push-to-talk",
      "sttEnabled": true,
      "liveTranscriptEnabled": true,
      "liveTranscriptPollingMs": 1000,
      "liveTranscriptGhostText": true
    }
  }
}
```

Config sources (priority order):

1. `XAI_API_KEY` env var
2. `./.pi/settings.json` (project-level)
3. `~/.pi/agent/settings.json` (user-level)

## 6. Engineering Conventions

### 6.1 Validation Hotspots

- Treat TTS/STT API calls, file I/O, and ffmpeg conversion as regression-prone areas
- Voice CLI argument parsing and command detection must be validated after changes
- Config loading and preference resolution must handle missing/invalid values gracefully
- Preserve literal file paths and temp directory handling across platforms

### 6.2 File And Naming Style

- Keep comments and user-facing docs in English unless the surrounding file already follows another convention
- Each project `.ts` file should start with a short multi-line responsibility header comment that explains the file boundary to future maintainers
- Prefer targeted edits, keeping `index.ts` as the orchestration layer and moving reusable logic into focused domain modules when a subsystem becomes large enough to earn extraction
- Do not reintroduce shared bucket domains such as `lib/constants.ts` or `lib/types.ts`; constants and types should stay in their owning domains

### 6.3 Current Domain Ownership Snapshot

- Voice API calls: `xai-voice.ts`, `voice-adapter.ts`
- CLI / bridge integration: `voice-cli.ts`
- Preferences and settings: `voice-settings.ts`
- pi-telegram interop: `voice-telegram-bus.ts`
- Pi editor integration: `voice-editor.ts`, `local-audio.ts`
- Tool registration and orchestration: `index.ts`

### 6.4 Entrypoint And Import Boundaries

- Keep voice synthesis logic in `voice-adapter.ts` and `xai-voice.ts`, not in `index.ts`
- Keep pi-telegram interop strictly in `voice-telegram-bus.ts` with zero-coupling through pi-telegram's public subpath APIs, not direct `globalThis` registry mutation
- Do not statically import from `pi-telegram`; use dynamic imports with fallback paths for git-installed extensions

## 7. Operational Conventions

- When Telegram-visible behavior changes, sync `README.md` in the same pass
- When durable runtime constraints or repeat bug patterns emerge, record them here instead of burying them in changelog prose
- Work only inside this repository during development tasks; updating the installed Pi extension checkout is a separate manual operator step
- Do NOT modify copied core files (`xai-client.ts`, `xai-config.ts`, etc.) in this project — changes will be lost on next sync with `pi-xai-imagine`

## 8. Integration Protocols

### pi-telegram Voice Integration

- pi-xai-voice registers a voice synthesis provider dynamically via `registerTelegramVoiceSynthesisProvider()` from `@llblab/pi-telegram/lib/voice.ts` and a voice transcription provider via `registerTelegramVoiceTranscriptionProvider()` when pi-telegram is available
- Zero-coupling: uses pi-telegram's public subpath registration APIs; does NOT create or mutate pi-telegram `globalThis` registries directly
- The provider owns xAI TTS, speech rewriting, transcript choice, and OGG/Opus conversion before returning `{ audioPath, transcriptText? }`
- Transparent voice is handled by pi-telegram's `voice.replyMode` policy; pi-xai-voice never reads, persists, or presents duplicate reply-mode controls
- Telegram main-menu label shows `🎙️ xAI Voice: on/off`; the first xAI Voice submenu row toggles `xai.voice.telegramEnabled`, which opts the TTS and STT providers in or out without removing the section
- Reply-mode prompt context belongs to pi-telegram; pi-xai-voice should not inject per-message voice-mode instructions through provider prompt contributions
- Reply-mode writes belong to pi-telegram Settings and `telegram.json`; pi-xai-voice provider settings must not write `voice.replyMode`

### Syncing with Upstream (pi-xai-imagine)

When `pi-xai-imagine` core files get fixes/improvements:

```bash
# Copy updated files
cp ~/projects/pi-xai-imagine/xai-client.ts ~/projects/pi-xai-voice/
cp ~/projects/pi-xai-imagine/xai-config.ts ~/projects/pi-xai-voice/
# ... etc for other core files
```

## 9. Pre-Task Preparation Protocol

- Read `README.md` for current user-facing behavior
- Read `BACKLOG.md` before changing runtime behavior or documentation so open work stays truthful
- Read `/docs` before restructuring voice pipeline or settings logic
- Inspect the relevant `index.ts` section before editing because most behavior is stateful and cross-linked
- Verify which files are copied from `pi-xai-imagine` before modifying them

## 10. Task Completion Protocol

- Run the smallest meaningful validation for the touched area; `npm test` is the default regression suite
- For voice CLI changes, test argument parsing and command detection
- For preference changes, validate config loading and settings dialog behavior
- For pi-telegram interop changes, verify handler registration and preference bus integration
- Sync `README.md`, `CHANGELOG.md`, and `BACKLOG.md` whenever user-visible behavior or real open-work state changes

## Agent skills

### Issue tracker

GitHub. See `docs/agents/issue-tracker.md`.

### Triage labels

Defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
