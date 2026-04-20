import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { XaiClient, coerceXaiClient } from "./xai-client.ts";
import { assertApiKey, assertPrompt, type XaiMediaLogger } from "./xai-media-shared.ts";

const TTS_ENDPOINT = "/tts";
const TTS_VOICES_ENDPOINT = "/tts/voices";
const STT_ENDPOINT = "/stt";
const REALTIME_ENDPOINT = "/realtime";
const REALTIME_CLIENT_SECRETS_ENDPOINT = "/realtime/client_secrets";
const DEFAULT_REALTIME_TIMEOUT_MS = 30_000;
const AUDIO_TEMP_DIR = join(tmpdir(), "pi-xai-voice", "audio");

export const DEFAULT_XAI_VOICE_ID = "eve";
export const DEFAULT_XAI_VOICE_LANGUAGE = "en";
export const DEFAULT_REALTIME_TOKEN_TTL_SECONDS = 300;

export const XAI_VOICE_IDS = new Set(["eve", "ara", "rex", "sal", "leo", "una"]);
export const XAI_TTS_CODECS = new Set(["mp3", "wav", "pcm", "mulaw", "alaw"]);
export const XAI_STT_ENCODINGS = new Set(["pcm", "mulaw", "alaw"]);
export const XAI_AUDIO_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000, 44100, 48000]);
export const XAI_MP3_BIT_RATES = new Set([32000, 64000, 96000, 128000, 192000]);

export interface TextToSpeechOutputFormat {
  codec?: string;
  sampleRate?: number;
  bitRate?: number;
}

export interface TextToSpeechParams {
  text: string;
  voiceId?: string;
  language?: string;
  outputFormat?: TextToSpeechOutputFormat;
  fileName?: string;
}

export interface TextToSpeechResult {
  ok: true;
  audioPath: string;
  voiceId: string;
  language: string;
  codec: string;
  contentType?: string;
  sizeBytes: number;
}

export interface XaiTtsVoice {
  voiceId: string;
  name?: string;
  type?: string;
  tone?: string;
  description?: string;
  previewUrl?: string;
  raw: Record<string, unknown>;
}

const DOCUMENTED_TTS_VOICE_METADATA: Record<
  string,
  { type?: string; tone?: string; description?: string; previewUrl?: string }
> = {
  eve: {
    type: "Female",
    tone: "Energetic, upbeat",
    description: "Default voice, engaging and enthusiastic",
    previewUrl: "https://data.x.ai/audio-samples/voice_eve.mp3",
  },
  ara: {
    type: "Female",
    tone: "Warm, friendly",
    description: "Balanced and conversational",
    previewUrl: "https://data.x.ai/audio-samples/voice_ara.mp3",
  },
  rex: {
    type: "Male",
    tone: "Confident, clear",
    description: "Professional and articulate, ideal for business applications",
    previewUrl: "https://data.x.ai/audio-samples/voice_rex.mp3",
  },
  sal: {
    type: "Neutral",
    tone: "Smooth, balanced",
    description: "Versatile voice suitable for various contexts",
    previewUrl: "https://data.x.ai/audio-samples/voice_sal.mp3",
  },
  leo: {
    type: "Male",
    tone: "Authoritative, strong",
    description: "Decisive and commanding, suitable for instructional content",
    previewUrl: "https://data.x.ai/audio-samples/voice_leo.mp3",
  },
};

export interface ListTextToSpeechVoicesResult {
  ok: true;
  voices: XaiTtsVoice[];
}

export interface SpeechToTextParams {
  file?: string;
  url?: string;
  audioFormat?: string;
  sampleRate?: number;
  language?: string;
  format?: boolean;
  multichannel?: boolean;
  channels?: number;
  diarize?: boolean;
}

export interface SpeechToTextWord {
  text: string;
  start?: number;
  end?: number;
  speaker?: number;
}

export interface SpeechToTextChannel {
  index: number;
  text: string;
  words: SpeechToTextWord[];
}

export interface SpeechToTextResult {
  ok: true;
  text: string;
  language?: string;
  duration?: number;
  words: SpeechToTextWord[];
  channels: SpeechToTextChannel[];
  raw: unknown;
}

export interface CreateRealtimeClientSecretParams {
  expiresAfterSeconds?: number;
}

export interface CreateRealtimeClientSecretResult {
  ok: true;
  clientSecret?: string;
  expiresAfterSeconds: number;
  expiresAt?: string | number;
  raw: unknown;
}

export interface RealtimeVoiceTextTurnParams {
  text: string;
  instructions?: string;
  voice?: string;
  sampleRate?: number;
  timeoutMs?: number;
  expiresAfterSeconds?: number;
}

export interface RealtimeVoiceTextTurnResult {
  ok: true;
  text: string;
  audioPath?: string;
  voice: string;
  sampleRate: number;
  responseId?: string;
}

interface TtsVoicesApiResult {
  voices?: Array<Record<string, unknown> & {
    voice_id?: string;
    name?: string;
    tone?: string;
    description?: string;
    preview_url?: string;
    sample_url?: string;
  }>;
}

interface SpeechToTextApiResult {
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{
    text?: string;
    start?: number;
    end?: number;
    speaker?: number;
  }>;
  channels?: Array<{
    index?: number;
    text?: string;
    words?: Array<{
      text?: string;
      start?: number;
      end?: number;
      speaker?: number;
    }>;
  }>;
}

interface RealtimeDoneEvent {
  type?: string;
  response?: {
    id?: string;
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string;
        transcript?: string;
      }>;
    }>;
  };
}

function ensureAudioTempDir(): string {
  if (!existsSync(AUDIO_TEMP_DIR)) {
    mkdirSync(AUDIO_TEMP_DIR, { recursive: true });
  }
  return AUDIO_TEMP_DIR;
}

function createTempAudioFilePath(fileName: string): string {
  const dir = ensureAudioTempDir();
  const extension = extname(fileName) || ".bin";
  const stem = basename(fileName, extension).replace(/[^a-zA-Z0-9._-]+/g, "-") || "audio";
  const random = Math.random().toString(36).slice(2, 8);
  return join(dir, `${stem}-${Date.now()}-${random}${extension}`);
}

function resolveUrl(client: XaiClient, path: string): string {
  const baseUrl = client.baseUrl.trim().replace(/\/+$/, "");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function resolveWsUrl(client: XaiClient, path: string): string {
  const httpUrl = resolveUrl(client, path);
  return httpUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

async function requestWithAuth(
  client: XaiClient,
  path: string,
  init: RequestInit,
  log?: XaiMediaLogger,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${client.apiKey}`);
  }
  const response = await fetch(resolveUrl(client, path), { ...init, headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    log?.error?.(
      `[xai-voice] request failed ${response.status} ${path}: ${errorText.slice(0, 500)}`,
    );
    throw new Error(`xAI API error: ${response.status} ${errorText.slice(0, 500)}`);
  }
  return response;
}

function normalizeVoiceId(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || DEFAULT_XAI_VOICE_ID;
  if (!XAI_VOICE_IDS.has(normalized)) {
    throw new Error(`Invalid voiceId: ${normalized}`);
  }
  return normalized;
}

function normalizeLanguage(value: string | undefined, fallback = DEFAULT_XAI_VOICE_LANGUAGE): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function normalizeCodec(value: string | undefined, fallback = "mp3"): string {
  const normalized = value?.trim().toLowerCase() || fallback;
  const aliased = normalized === "ulaw" ? "mulaw" : normalized;
  if (!XAI_TTS_CODECS.has(aliased)) {
    throw new Error(`Invalid codec: ${aliased}`);
  }
  return aliased;
}

function normalizeSttEncoding(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const aliased = normalized === "ulaw" ? "mulaw" : normalized;
  if (!XAI_STT_ENCODINGS.has(aliased)) {
    throw new Error(`Invalid audioFormat: ${aliased}`);
  }
  return aliased;
}

function normalizeSampleRate(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !XAI_AUDIO_SAMPLE_RATES.has(Math.floor(value))) {
    throw new Error(`Invalid sampleRate: ${String(value)}`);
  }
  return Math.floor(value);
}

function normalizeBitRate(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !XAI_MP3_BIT_RATES.has(Math.floor(value))) {
    throw new Error(`Invalid bitRate: ${String(value)}`);
  }
  return Math.floor(value);
}

function normalizePositiveInt(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be positive integer`);
  }
  return Math.floor(value);
}

function codecToExtension(codec: string): string {
  switch (codec) {
    case "wav":
      return ".wav";
    case "pcm":
      return ".pcm";
    case "mulaw":
      return ".mulaw";
    case "alaw":
      return ".alaw";
    case "mp3":
    default:
      return ".mp3";
  }
}

function codecFromContentType(contentType: string | null): string | undefined {
  const normalized = contentType?.split(";")[0].trim().toLowerCase();
  switch (normalized) {
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/pcm":
      return "pcm";
    case "audio/basic":
      return "mulaw";
    case "audio/alaw":
      return "alaw";
    default:
      return undefined;
  }
}

function inferAudioMimeType(filePath: string): string {
  const extension = extname(filePath).slice(1).toLowerCase();
  switch (extension) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "opus":
      return "audio/opus";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "mp4":
    case "m4a":
      return "audio/mp4";
    case "mkv":
      return "audio/x-matroska";
    case "pcm":
      return "audio/pcm";
    case "mulaw":
    case "ulaw":
      return "audio/basic";
    case "alaw":
      return "audio/alaw";
    default:
      return "application/octet-stream";
  }
}

function normalizeSpeechToTextWord(word: {
  text?: string;
  start?: number;
  end?: number;
  speaker?: number;
}): SpeechToTextWord | undefined {
  const text = word.text?.trim();
  if (!text) return undefined;
  return {
    text,
    start: typeof word.start === "number" ? word.start : undefined,
    end: typeof word.end === "number" ? word.end : undefined,
    speaker: typeof word.speaker === "number" ? word.speaker : undefined,
  };
}

function extractRealtimeClientSecret(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const direct = [record.value, record.secret, record.token];
  for (const value of direct) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nested = record.client_secret;
  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    const nestedValues = [nestedRecord.value, nestedRecord.secret, nestedRecord.token];
    for (const value of nestedValues) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function extractRealtimeExpiresAt(raw: unknown): string | number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const direct = [record.expires_at, record.expiresAt];
  for (const value of direct) {
    if (typeof value === "string" || typeof value === "number") return value;
  }
  const nested = record.client_secret;
  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    const nestedValues = [nestedRecord.expires_at, nestedRecord.expiresAt];
    for (const value of nestedValues) {
      if (typeof value === "string" || typeof value === "number") return value;
    }
  }
  return undefined;
}

function extractRealtimeResponseText(doneEvent: RealtimeDoneEvent): string | undefined {
  const outputText = doneEvent.response?.output_text?.trim();
  if (outputText) return outputText;
  const chunks: string[] = [];
  for (const item of doneEvent.response?.output ?? []) {
    for (const content of item.content ?? []) {
      const value = content.text?.trim() || content.transcript?.trim();
      if (value) chunks.push(value);
    }
  }
  return chunks.length ? chunks.join("\n\n") : undefined;
}

function pcm16ToWavBuffer(pcmBytes: Uint8Array, sampleRate: number): Buffer {
  const dataLength = pcmBytes.byteLength;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  Buffer.from(pcmBytes).copy(buffer, 44);
  return buffer;
}

async function websocketMessageToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return typeof data === "object" && data !== null ? JSON.stringify(data) : "";
}

export async function textToSpeechWithXai(
  clientOrApiKey: string | XaiClient,
  params: TextToSpeechParams,
  log?: XaiMediaLogger,
): Promise<TextToSpeechResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const text = assertPrompt(params.text);
  if (text.length > 15_000) {
    throw new Error("text exceeds xAI TTS limit of 15,000 characters");
  }

  const voiceId = normalizeVoiceId(params.voiceId);
  const language = normalizeLanguage(params.language);
  const codec = normalizeCodec(params.outputFormat?.codec);
  const sampleRate = normalizeSampleRate(params.outputFormat?.sampleRate);
  const bitRate = normalizeBitRate(params.outputFormat?.bitRate);
  if (codec !== "mp3" && bitRate !== undefined) {
    throw new Error("bitRate is only supported for mp3 output");
  }

  const body: Record<string, unknown> = {
    text,
    voice_id: voiceId,
    language,
  };

  if (params.outputFormat) {
    body.output_format = {
      codec,
      ...(sampleRate !== undefined ? { sample_rate: sampleRate } : {}),
      ...(bitRate !== undefined ? { bit_rate: bitRate } : {}),
    };
  }

  log?.info?.(`[xai-voice] tts voice=${voiceId} language=${language} codec=${codec}`);
  const response = await requestWithAuth(
    client,
    TTS_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    log,
  );

  const bytes = Buffer.from(await response.arrayBuffer());
  const resolvedCodec = codecFromContentType(response.headers.get("content-type")) || codec;
  const extension = codecToExtension(resolvedCodec);
  const preferredName = params.fileName?.trim() || `tts-${voiceId}`;
  const audioPath = createTempAudioFilePath(`${preferredName}${extension}`);
  writeFileSync(audioPath, bytes);

  return {
    ok: true,
    audioPath,
    voiceId,
    language,
    codec: resolvedCodec,
    contentType: response.headers.get("content-type") || undefined,
    sizeBytes: bytes.byteLength,
  };
}

export async function listTextToSpeechVoicesWithXai(
  clientOrApiKey: string | XaiClient,
  log?: XaiMediaLogger,
): Promise<ListTextToSpeechVoicesResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const result = await client.fetchJson<TtsVoicesApiResult>(TTS_VOICES_ENDPOINT, { method: "GET" }, log);

  const voices: XaiTtsVoice[] = [];
  for (const voice of result.voices ?? []) {
    const voiceId = voice.voice_id?.trim().toLowerCase();
    if (!voiceId) continue;
    const documented = DOCUMENTED_TTS_VOICE_METADATA[voiceId];
    voices.push({
      voiceId,
      name: voice.name?.trim() || undefined,
      type:
        typeof voice.type === "string"
          ? voice.type.trim() || undefined
          : typeof voice.gender === "string"
            ? voice.gender.trim() || undefined
            : documented?.type,
      tone:
        typeof voice.tone === "string"
          ? voice.tone.trim() || undefined
          : documented?.tone,
      description:
        typeof voice.description === "string" ? voice.description.trim() || undefined : undefined,
      previewUrl:
        typeof voice.preview_url === "string"
          ? voice.preview_url.trim() || undefined
          : typeof voice.sample_url === "string"
            ? voice.sample_url.trim() || undefined
            : documented?.previewUrl,
      raw: voice,
    });
    const entry = voices[voices.length - 1]!;
    if (!entry.description) entry.description = documented?.description;
  }

  return {
    ok: true,
    voices,
  };
}

export async function speechToTextWithXai(
  clientOrApiKey: string | XaiClient,
  params: SpeechToTextParams,
  log?: XaiMediaLogger,
): Promise<SpeechToTextResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);

  const filePath = params.file?.trim();
  const url = params.url?.trim();
  if (!filePath && !url) {
    throw new Error("speech_to_text requires file or url");
  }
  if (filePath && url) {
    throw new Error("speech_to_text accepts either file or url, not both");
  }

  const audioFormat = normalizeSttEncoding(params.audioFormat);
  const sampleRate = normalizeSampleRate(params.sampleRate);
  const language = params.language?.trim() || undefined;
  const format = params.format === true;
  const multichannel = params.multichannel === true;
  const diarize = params.diarize === true;
  const channels = params.channels === undefined ? undefined : normalizePositiveInt(params.channels, "channels");

  if (format && !language) {
    throw new Error("language is required when format=true");
  }
  if (audioFormat && sampleRate === undefined) {
    throw new Error("sampleRate is required for raw audio inputs");
  }
  if (multichannel && audioFormat && channels === undefined) {
    throw new Error("channels is required for multichannel raw audio inputs");
  }
  if (channels !== undefined && (channels < 2 || channels > 8)) {
    throw new Error("channels must be between 2 and 8");
  }

  const form = new FormData();
  if (url) form.append("url", url);
  if (audioFormat) form.append("audio_format", audioFormat);
  if (sampleRate !== undefined) form.append("sample_rate", String(sampleRate));
  if (language) form.append("language", language);
  if (format) form.append("format", "true");
  if (multichannel) form.append("multichannel", "true");
  if (channels !== undefined) form.append("channels", String(channels));
  if (diarize) form.append("diarize", "true");
  if (filePath) {
    const blob = new Blob([readFileSync(filePath)], { type: inferAudioMimeType(filePath) });
    form.append("file", blob, basename(filePath));
  }

  log?.info?.(
    `[xai-voice] stt source=${filePath ? "file" : "url"} multichannel=${String(multichannel)} diarize=${String(diarize)}`,
  );
  const response = await requestWithAuth(
    client,
    STT_ENDPOINT,
    {
      method: "POST",
      body: form,
    },
    log,
  );

  const raw = (await response.json()) as SpeechToTextApiResult;
  return {
    ok: true,
    text: raw.text?.trim() || "",
    language: raw.language?.trim() || undefined,
    duration: typeof raw.duration === "number" ? raw.duration : undefined,
    words: (raw.words ?? [])
      .map((word) => normalizeSpeechToTextWord(word))
      .filter((word): word is SpeechToTextWord => Boolean(word)),
    channels: (raw.channels ?? [])
      .map((channel) => {
        const index = typeof channel.index === "number" ? channel.index : undefined;
        const text = channel.text?.trim() || "";
        if (index === undefined) return undefined;
        return {
          index,
          text,
          words: (channel.words ?? [])
            .map((word) => normalizeSpeechToTextWord(word))
            .filter((word): word is SpeechToTextWord => Boolean(word)),
        } satisfies SpeechToTextChannel;
      })
      .filter((channel): channel is SpeechToTextChannel => Boolean(channel)),
    raw,
  };
}

export async function createRealtimeClientSecretWithXai(
  clientOrApiKey: string | XaiClient,
  params: CreateRealtimeClientSecretParams = {},
  log?: XaiMediaLogger,
): Promise<CreateRealtimeClientSecretResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const expiresAfterSeconds =
    normalizePositiveInt(params.expiresAfterSeconds, "expiresAfterSeconds") ||
    DEFAULT_REALTIME_TOKEN_TTL_SECONDS;

  const raw = await client.fetchJson<unknown>(
    REALTIME_CLIENT_SECRETS_ENDPOINT,
    {
      method: "POST",
      body: JSON.stringify({
        expires_after: {
          seconds: expiresAfterSeconds,
        },
      }),
    },
    log,
  );

  return {
    ok: true,
    clientSecret: extractRealtimeClientSecret(raw),
    expiresAfterSeconds,
    expiresAt: extractRealtimeExpiresAt(raw),
    raw,
  };
}

export async function realtimeVoiceTextTurnWithXai(
  clientOrApiKey: string | XaiClient,
  params: RealtimeVoiceTextTurnParams,
  log?: XaiMediaLogger,
): Promise<RealtimeVoiceTextTurnResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const text = assertPrompt(params.text);
  const voice = normalizeVoiceId(params.voice);
  const sampleRate = normalizeSampleRate(params.sampleRate) || 24_000;
  const timeoutMs = normalizePositiveInt(params.timeoutMs, "timeoutMs") || DEFAULT_REALTIME_TIMEOUT_MS;

  const secretResult = await createRealtimeClientSecretWithXai(
    client,
    { expiresAfterSeconds: params.expiresAfterSeconds },
    log,
  );
  if (!secretResult.clientSecret) {
    throw new Error("xAI realtime client secret response did not include usable token");
  }

  const wsUrl = resolveWsUrl(client, REALTIME_ENDPOINT);
  log?.info?.(`[xai-voice] realtime text turn voice=${voice} sampleRate=${sampleRate}`);

  return await new Promise<RealtimeVoiceTextTurnResult>((resolve, reject) => {
    let settled = false;
    let responseDone = false;
    let responseId: string | undefined;
    let ws: WebSocket | undefined;
    const textChunks: string[] = [];
    const audioChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out after ${timeoutMs}ms waiting for realtime response`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (!ws) return;
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          void e;
        }
      }
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = (doneEvent?: RealtimeDoneEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const fallbackText = doneEvent ? extractRealtimeResponseText(doneEvent) : undefined;
      const resultText = (textChunks.join("") || fallbackText || "").trim();
      let audioPath: string | undefined;
      if (audioChunks.length) {
        const pcmBytes = Buffer.concat(audioChunks);
        audioPath = createTempAudioFilePath(`realtime-${voice}.wav`);
        writeFileSync(audioPath, pcm16ToWavBuffer(pcmBytes, sampleRate));
      }
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          void e;
        }
      }
      resolve({
        ok: true,
        text: resultText,
        audioPath,
        voice,
        sampleRate,
        responseId,
      });
    };

    ws = new WebSocket(wsUrl, [`xai-client-secret.${secretResult.clientSecret}`]);
    const socket = ws;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            voice,
            ...(params.instructions?.trim() ? { instructions: params.instructions.trim() } : {}),
            turn_detection: null,
            audio: {
              output: {
                format: {
                  type: "audio/pcm",
                  rate: sampleRate,
                },
              },
            },
          },
        }),
      );

      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      );
      socket.send(JSON.stringify({ type: "response.create" }));
    });

    socket.addEventListener("message", async (messageEvent) => {
      try {
        const textPayload = await websocketMessageToText(messageEvent.data);
        const event = JSON.parse(textPayload) as Record<string, unknown>;
        const type = typeof event.type === "string" ? event.type : undefined;
        switch (type) {
          case "response.text.delta":
          case "response.output_text.delta": {
            if (typeof event.delta === "string") textChunks.push(event.delta);
            break;
          }
          case "response.output_audio.delta": {
            if (typeof event.delta === "string") {
              audioChunks.push(Buffer.from(event.delta, "base64"));
            }
            break;
          }
          case "response.done": {
            responseDone = true;
            const doneEvent = event as RealtimeDoneEvent;
            responseId = doneEvent.response?.id?.trim() || responseId;
            succeed(doneEvent);
            break;
          }
          case "error": {
            fail(new Error(typeof event.message === "string" ? event.message : "xAI realtime error"));
            break;
          }
          default:
            break;
        }
      } catch (error) {
        fail(error);
      }
    });

    socket.addEventListener("error", () => {
      fail(new Error("Realtime WebSocket connection failed"));
    });

    socket.addEventListener("close", () => {
      if (!settled && !responseDone) {
        fail(new Error("Realtime WebSocket closed before response completed"));
      }
    });
  });
}
