# Changelog

All notable changes to this project will be documented in this file.

## Current

### Added
- Exported `piVoiceAdapterV1` from `voice-adapter.ts` so other Pi extensions can use `pi-xai-voice` as a code-level STT/TTS backend. The adapter reports xAI tag support and exposes the constrained speech-tag allowlist.

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
