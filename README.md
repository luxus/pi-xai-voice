# Pi xAI Voice

Pi extension for xAI voice workflows.

## Features

- `text_to_speech` — unary `/v1/tts`, saves audio to temp file, optional local playback with `play: true`
- `list_tts_voices` — list available xAI voices
- `speech_to_text` — unary `/v1/stt` from local file or remote URL
- `create_realtime_voice_client_secret` — mint short-lived browser/mobile token for `/v1/realtime`
- `realtime_voice_text_turn` — one-shot text roundtrip over `/v1/realtime`, saves returned PCM as WAV
- `check_xai_voice_health` — verify auth, base URL, defaults, visible models
- `/xai-speak [text]` — speak provided text, current editor text, or last assistant reply
- `/xai-record` — toggle microphone capture, transcribe, paste into editor
- `/xai-voice-settings` — configure voice defaults, STT toggle, shortcut, live transcript, polling, ghost text
- `Alt+M` by default — editor voice shortcut; configurable in `/xai-voice-settings`
- `/xai-voice-health` — command alias for health check

## Structure

```text
xai-client.ts        # shared HTTP client
xai-config.ts        # shared config loading
xai-media-shared.ts  # shared helpers/constants
xai-image.ts         # copied from pi-xai-imagine
xai-video.ts         # copied from pi-xai-imagine
xai-understanding.ts # copied from pi-xai-imagine
xai-voice.ts         # voice-specific API implementation
local-audio.ts       # local mic capture + playback helpers
voice-editor.ts      # push-to-talk editor wrapper
index.ts             # Pi tool registration
```

## Config

Shared xAI namespace:

```json
{
  "xai": {
    "apiKey": "xai-...",
    "baseUrl": "https://api.x.ai/v1",
    "voice": {
      "defaultVoice": "eve",
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

Config lookup order:

1. `XAI_API_KEY`
2. `./.pi/settings.json`
3. `~/.pi/agent/settings.json`

## Notes

- xAI voice docs currently expose fixed TTS/STT/realtime endpoints — no request-level model selector used here.
- `realtime_voice_text_turn` is smoke-test style. No live mic streaming tool yet.
- Microphone shortcut uses local `ffmpeg` capture on macOS via AVFoundation, then sends saved WAV into `/v1/stt`.
- Default shortcut is `Alt+M`. Shortcut and mode (`push-to-talk` or `toggle`) are configurable in `/xai-voice-settings`.
- Push-to-talk depends on terminal key release support. Fallback: `/xai-record` or switch shortcut mode to `toggle`.
- Playback uses local `afplay` on macOS. New playback stops previous playback.
- Temp audio files land under OS temp dir in `pi-xai-voice/audio/`.
- Voice settings can be saved per-project (`.pi/settings.json`) or globally (`~/.pi/agent/settings.json`).
- Live transcript preview, polling interval, STT enable/disable, language hint, and ghost text are configurable in `/xai-voice-settings`.

## Usage

Low-level runtime example:

```ts
import { XaiClient, getRequiredXaiApiKey, resolveXaiConfig } from "./xai-media.ts";

const config = resolveXaiConfig();
const { apiKey } = getRequiredXaiApiKey(config);
const client = new XaiClient({ apiKey, baseUrl: config.xai.baseUrl });

const health = await client.checkHealth();
```

## Dev

```bash
bun install
bunx tsgo -p tsconfig.json --noEmit
```
