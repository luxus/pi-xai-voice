import { basename } from "node:path";
import { XaiClient } from "./xai-client.ts";
import { getRequiredXaiApiKey } from "./xai-config.ts";
import {
  DEFAULT_XAI_VOICE_ID,
  DEFAULT_XAI_VOICE_LANGUAGE,
  speechToTextWithXai,
  textToSpeechWithXai,
} from "./xai-voice.ts";

export interface PiVoiceAdapterV1TranscribeInput {
  filePath: string;
  language?: string;
  signal?: AbortSignal;
}

export interface PiVoiceAdapterV1SynthesizeInput {
  text: string;
  voiceId?: string;
  language?: string;
  fileName?: string;
  signal?: AbortSignal;
}

export interface PiVoiceAdapterV1 {
  version: 1;
  id: string;
  capabilities: {
    stt: boolean;
    tts: boolean;
  };
  tagStyle: "none" | "xai" | "ssml" | "custom";
  allowedTags: string[];
  isAvailable(): boolean;
  getDefaults(): {
    voiceId?: string;
    language?: string;
    sttLanguage?: string;
  };
  transcribe(input: PiVoiceAdapterV1TranscribeInput): Promise<{
    text: string;
    language?: string;
  }>;
  synthesize(input: PiVoiceAdapterV1SynthesizeInput): Promise<{
    filePath: string;
    mimeType?: string;
    fileName?: string;
    cleanupPaths?: string[];
  }>;
}

export const XAI_INLINE_SPEECH_TAGS = [
  "[pause]",
  "[long-pause]",
  "[laugh]",
  "[chuckle]",
  "[giggle]",
  "[cry]",
  "[tsk]",
  "[tongue-click]",
  "[lip-smack]",
  "[hum-tune]",
  "[breath]",
  "[inhale]",
  "[exhale]",
  "[sigh]",
  "[gasp]",
] as const;

export const XAI_WRAPPER_SPEECH_TAGS = [
  "soft",
  "whisper",
  "decrease-intensity",
  "higher-pitch",
  "sing-song",
  "loud",
  "build-intensity",
  "lower-pitch",
  "singing",
  "slow",
  "laugh-speak",
  "fast",
  "emphasis",
  "shout",
  "excited",
  "calm",
  "sad",
  "happy",
] as const;

export const XAI_ALLOWED_SPEECH_TAGS = [
  ...XAI_INLINE_SPEECH_TAGS,
  ...XAI_WRAPPER_SPEECH_TAGS.map((tag) => `<${tag}>...</${tag}>`),
];

function createRuntime() {
  const { apiKey, config } = getRequiredXaiApiKey();
  return {
    config,
    client: new XaiClient({ apiKey, baseUrl: config.xai.baseUrl }),
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const piVoiceAdapterV1: PiVoiceAdapterV1 = {
  version: 1,
  id: "pi-xai-voice",
  capabilities: {
    stt: true,
    tts: true,
  },
  tagStyle: "xai",
  allowedTags: [...XAI_ALLOWED_SPEECH_TAGS],
  isAvailable() {
    try {
      getRequiredXaiApiKey();
      return true;
    } catch {
      return false;
    }
  },
  getDefaults() {
    const { config } = createRuntime();
    return {
      voiceId: getString(config.xai.voice.defaultVoice) || DEFAULT_XAI_VOICE_ID,
      language: getString(config.xai.voice.defaultLanguage) || DEFAULT_XAI_VOICE_LANGUAGE,
      sttLanguage: getString(config.xai.voice.sttLanguage),
    };
  },
  async transcribe(input) {
    const { client } = createRuntime();
    const result = await speechToTextWithXai(client, {
      file: input.filePath,
      language: input.language,
      format: Boolean(input.language),
    });
    return {
      text: result.text,
      language: result.language,
    };
  },
  async synthesize(input) {
    const { client } = createRuntime();
    const result = await textToSpeechWithXai(client, {
      text: input.text,
      voiceId: input.voiceId,
      language: input.language,
      outputFormat: {
        codec: "mp3",
        sampleRate: 24000,
        bitRate: 64000,
      },
      fileName: input.fileName,
    });
    return {
      filePath: result.audioPath,
      mimeType: result.contentType || "audio/mpeg",
      fileName: basename(result.audioPath),
      cleanupPaths: [result.audioPath],
    };
  },
};

export default piVoiceAdapterV1;
