# Pi xAI Voice

Pi extension for xAI voice workflows.

## Install

Via npm registry (provenance attested):

```bash
pi install pi-xai-voice
```

Via git:

```bash
pi install github:luxus/pi-xai-voice
```

## Publishing

This package is published to npm using **OIDC trust via GitHub Actions** with **npm provenance attestation**.

- **No long-lived npm tokens** in repository secrets — authentication uses short-lived OIDC tokens from GitHub's OIDC provider
- Every publish includes a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) linking the package to the specific GitHub commit and workflow run
- Trust established: `luxus/pi-xai-voice` repository, `publish.yml` workflow only

To trigger a release:
1. Bump version in `package.json`
2. Push to main
3. Run the [Publish workflow](https://github.com/luxus/pi-xai-voice/actions/workflows/publish.yml) manually with desired dist-tag (`latest`, `next`, etc.)

## Why this exists

xAI shipped dedicated Grok STT and TTS APIs here: [Introducing Grok 3 Speech](https://x.ai/news/grok-stt-and-tts-apis).

The original motivation for this project was not “build every possible voice feature inside Pi.” The main use case was Telegram and bot integrations.

For that use case, voice often feels much more natural than typing. Talking to a bot is faster, lower friction, and more conversational than constantly writing messages by hand. Once STT and TTS become good enough on price and latency, voice stops being a gimmick and starts feeling like the right interface.

This repository packages that idea in two layers:
- a reusable xAI voice layer for STT, TTS, voice listing, and realtime helpers
- Pi integrations on top, so the same APIs can also be used directly inside the editor

The Pi-specific features exist because the core voice plumbing was already useful and easy to expose here as well:
- fast voice input/output loop directly in the editor
- local playback and local mic capture for low-friction workflow
- configurable live transcript polling so you can trade responsiveness against cost
- explicit STT on/off, ghost text, shortcut mode, and quality settings instead of hardcoded defaults

So the short version is: the main reason for this project is voice-first bot usage, especially Telegram-style flows. The Pi extension features are the practical extra integrations that fell out of building that core voice layer properly.

A concrete downstream target for this work is [`luxus/pi-telegram`](https://github.com/luxus/pi-telegram). That project builds on [`llblab/pi-telegram`](https://github.com/llblab/pi-telegram), which itself is a fork of [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram).

In practice, that Telegram add-on is where the voice-first idea becomes especially compelling. It turns the bot into something closer to a spoken assistant than a text-only chat. Through that integration, you can use this voice layer to:
- switch the xAI voice/model used for spoken replies
- run a continuous voice mode where voice messages can trigger voice replies
- receive direct spoken answers as Telegram voice messages
- use [xAI speech tags](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#speech-tags) so spoken output sounds more human and expressive, not just flat text readout
- make the interaction feel more like talking to an assistant than typing commands into a chat box

Speech tags are short inline cues for delivery style. In the Telegram integration, the actual xAI-style tags used in source include tags like `[pause]`, `[long-pause]`, `[laugh]`, `[giggle]`, `[sigh]`, `<whisper>...</whisper>`, `<slow>...</slow>`, and `<emphasis>...</emphasis>`. Examples:

```text
We shipped it. [laugh]
[pause] I think this will work.
<whisper>this part stays quiet</whisper>
<slow><soft>Okay — let’s do this carefully.</soft></slow>
<emphasis>The build is finally green.</emphasis>
```

That matters for bots because it makes spoken replies feel less robotic. For Telegram voice replies in particular, this helps the assistant sound more like a real voice and less like a flat screen reader.

The tag set is intentionally constrained. The Telegram integration uses an explicit allowlist instead of arbitrary free-form tags, so spoken output stays predictable and compatible with provider behavior.

At the moment, cloning and adapting projects is often faster than waiting for upstream alignment, so this repository intentionally keeps its own fork path open. Upstream adoption would be nice, but it is not required for this extension to be useful.

## Features

- `text_to_speech` — unary `/v1/tts`, saves audio to temp file, optional local playback with `play: true`; remote-chat bridges can attach the returned `audioPath` with their own delivery tool
- `list_tts_voices` — list available xAI voices
- `speech_to_text` — unary `/v1/stt` from local file or remote URL, including local voice/audio files forwarded by bridge extensions such as pi-telegram
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


## Adapter API

`pi-xai-voice/voice-adapter.ts` exports `piVoiceAdapterV1` for other Pi extensions that need a code-level STT/TTS backend instead of LLM-facing tools.

The adapter supports both STT and TTS, reports `tagStyle: "xai"`, and exposes the xAI speech-tag allowlist so callers can prepare tagged spoken text safely. The adapter passes tagged text through to xAI TTS unchanged.

```ts
import { piVoiceAdapterV1 } from "pi-xai-voice/voice-adapter.ts";

if (piVoiceAdapterV1.isAvailable()) {
  const transcript = await piVoiceAdapterV1.transcribe({ filePath: "voice.ogg" });
  const speech = await piVoiceAdapterV1.synthesize({
    text: "Hello [pause] <soft>world</soft>",
    voiceId: "eve",
    language: "en",
  });
}
```

## Dev

```bash
bun install
bunx tsgo -p tsconfig.json --noEmit
```
