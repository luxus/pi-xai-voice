# Changelog

All notable changes to this project will be documented in this file.

## 0.3.0: pi-telegram 0.11 Voice Provider API

### Changed

- Adopted pi-telegram 0.11's finalized provider APIs: `registerTelegramVoiceSynthesisProvider()` and `registerTelegramVoiceTranscriptionProvider()` from `@llblab/pi-telegram/lib/voice.ts` replace the old outbound `type: "voice"` handler path.
- Provider registration no longer supplies `getVoicePolicy()`; pi-telegram owns reply-mode policy through its Settings UI and `telegram.json`.
- pi-telegram owns `voice.replyMode`; pi-xai-voice no longer reads, persists, or presents duplicate reply-mode policy in its own Telegram section.
- pi-xai-voice acts as the zero-config fallback provider in pi-telegram's voice pipeline; explicit `telegram.json` outbound voice handlers remain higher priority.
- The provider now returns `{ audioPath }` or `{ audioPath, transcriptText }`; the `sendTranscript` toggle controls whether `transcriptText` is included as the Telegram voice caption.
- pi-xai-voice owns xAI TTS, speech rewriting, transcript choice, and OGG/Opus conversion before handing the artifact to pi-telegram for `sendVoice` delivery.
- Removed provider-side voice prompt injection; reply-mode context belongs to pi-telegram, while pi-xai-voice only synthesizes audio (and provides STT transcription) for the zero-coupling provider contract.
- Missing bridge reply mode remains pi-telegram's `hidden` default; Telegram voice mirroring starts only after pi-telegram `voice.replyMode` is explicitly set in pi-telegram Settings.
- Registers as a pi-telegram voice transcription provider when the bridge supports `registerTelegramVoiceTranscriptionProvider()`, so xAI STT can transcribe Telegram voice input when no explicit inbound handler handled the file.
- Telegram main menu label now shows `🎙️ xAI Voice: on/off`, and the first Voice submenu row toggles the xAI Telegram provider without reintroducing duplicate reply-mode controls.

### Removed

- Direct mutation/readback of pi-telegram's removed `__piTelegramVoiceConfig__` global.
- `persistent` registration options and `sendTranscriptAsMessage`, which are not part of the finalized pi-telegram 0.11 voice provider contract.
- Normal-flow direct event-recorder global usage from the voice provider path.

This release aligns with the decision that **pi-telegram should own Telegram transport policy and stable interfaces** while `pi-xai-voice` owns xAI rewriting, TTS, conversion, STT, and transcript behavior.

See pi-telegram `docs/voice.md` for the current provider contract.

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
