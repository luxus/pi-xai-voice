# Changelog

All notable changes to this project will be documented in this file.

## Unreleased — Voice v2 Integration with Minimal pi-telegram

### Changed
- Full adoption of the new minimal pi-telegram voice architecture.
- `voice-telegram-bus.ts` now uses clean static import from `@llblab/pi-telegram` (with fallback only for local dev).
- Provider registration now supplies `getVoicePromptContribution` for LLM guidance.
- `setVoiceConfig` now persists `replyMode` to `telegram.json` so bridge tagging respects UI changes.
- Transcript is **always** returned (for voice caption + π session logs). The `sendTranscript` toggle only controls whether it is also sent as a separate text message.
- Improved ffmpeg handling: safe temp OGG paths, proper cleanup, structured event recording via the correct recorder key.
- `record_voice` chat action is now shown during voice delivery.

### Removed
- Heavy relative path hacking and 30s re-registration interval in the main path.
- German debug logs during registration.
- Wrong event recorder key usage in debug logging.

This release aligns with the decision that **pi-telegram should only offer interfaces** while `pi-xai-voice` owns the full voice experience (policy, rewriting, TTS, conversion, transcript behavior).

See pi-telegram `docs/voice.md` and the v2 tracker issues for details.

### Added

- pi-telegram voice integration: zero-config handler registration and Telegram section menu (`/menu` → 🎙️ Voice (x.ai)).
- Telegram voice settings menu with reply mode, voice, language, style, and `sendTranscript` toggle.
- Voice settings persistence via Pi settings file (`xai.voice` config namespace).
- Session resume handling with disposer and periodic re-registration for pi-telegram.
- Deduplication of voice section registration via registry check.
- Voice (x.ai) labeling in Telegram menus.
- Matt Pocock skills setup: `docs/agents/` with issue tracker, triage labels, and domain docs.
- Exported `piVoiceAdapterV1` from `voice-adapter.ts` so other Pi extensions can use `pi-xai-voice` as a code-level STT/TTS backend.
- Added `pi-xai-voice`, `pi-xai-voice-stt`, and `pi-xai-voice-tts` binaries for command-template integrations.

### Changed

- Migrated from Bun to npm. Updated Pi packages to 0.74.0.
- Adopted AGENTS.md structure from pi-telegram with meta-protocol principles.

### Fixed

- Removed debug `console.log` statements from voice-telegram-bus.
- Settings label now shows "🎙️ Voice (x.ai)" instead of "Voice settings" with status dots.
- Voice replies no longer show text drafts in Telegram during generation (fixed upstream in pi-telegram).

## Current

## [0.1.0] - 2026-04-20

Initial release candidate.

### Added

- xAI voice tools for TTS, STT, voice catalog, realtime client secret, realtime text-turn smoke test, and health check.
- Pi commands: `/xai-speak`, `/xai-record`, `/xai-voice-settings`, `/xai-voice-health`.
- Editor voice shortcut with configurable shortcut and mode (`push-to-talk` or `toggle`).
- Local microphone capture and local audio playback helpers for macOS.
- Voice settings UI with separate TTS and STT tabs.
- Configurable TTS voice and quality preset.
- Configurable STT enable/disable and language hint.
- Live transcript preview with configurable polling interval.
- Ghost text preview option while recording.
- Voice catalog fallback metadata merge for type, tone, description, and preview URLs.
- In-dialog voice preview playback from settings UI.

### Changed

- Default editor shortcut set to `Alt+M`.
- Listening widget shown above editor during recording.
- Live transcript preview written directly into editor during recording.

### Fixed

- Removed double-keypress behavior caused by key release handling in editor integration.
- Removed noisy debug output from normal operation; debug logs now gated behind `XAI_VOICE_DEBUG=1`.
- Final transcript now cleanly replaces live preview in editor.
- Voice preview playback now stops cleanly without closing settings dialog.
- Voice `una` accepted from API voice catalog.

### Notes

- `realtime_voice_text_turn` is smoke-test only. True live microphone streaming is not part of this release.
- No automated test suite yet; current verification is typecheck, lint, smoke tests, and manual TUI validation.
