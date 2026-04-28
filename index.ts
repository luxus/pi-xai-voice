import type { ChildProcess } from "node:child_process";
import { unlinkSync } from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { XaiClient } from "./xai-client.ts";
import {
  createMicrophoneRecordingSnapshot,
  createLocalAudioTempPath,
  startAudioPlayback,
  startMicrophoneRecording,
  stopAudioPlayback,
  stopMicrophoneRecording,
  type LocalRecording,
} from "./local-audio.ts";
import { VoicePushToTalkEditor } from "./voice-editor.ts";
import { getRequiredXaiApiKey, type ResolvedXaiConfig } from "./xai-config.ts";
import { summarizeError, type XaiMediaLogger } from "./xai-media-shared.ts";
import {
  DEFAULT_REALTIME_TOKEN_TTL_SECONDS,
  DEFAULT_XAI_VOICE_ID,
  DEFAULT_XAI_VOICE_LANGUAGE,
  XAI_TTS_CODECS,
  XAI_STT_ENCODINGS,
  XAI_VOICE_IDS,
  createRealtimeClientSecretWithXai,
  listTextToSpeechVoicesWithXai,
  realtimeVoiceTextTurnWithXai,
  speechToTextWithXai,
  textToSpeechWithXai,
} from "./xai-voice.ts";
import {
  DEFAULT_LIVE_TRANSCRIPT_GHOST_TEXT,
  DEFAULT_LIVE_TRANSCRIPT_ENABLED,
  DEFAULT_LIVE_TRANSCRIPT_POLL_MS,
  DEFAULT_STT_ENABLED,
  DEFAULT_STT_LANGUAGE,
  DEFAULT_VOICE_SHORTCUT,
  DEFAULT_VOICE_SHORTCUT_MODE,
  DEFAULT_VOICE_TTS_QUALITY,
  TTS_QUALITY_PRESETS,
  openVoiceSettingsDialog,
  resolveVoicePreferences,
  saveVoicePreferences,
  type VoiceSttLanguage,
  type VoicePreviewHandle,
  type VoicePreferences,
} from "./voice-settings.ts";

const VOICE_ID_VALUES = [...XAI_VOICE_IDS] as [string, ...string[]];
const TTS_CODEC_VALUES = [...XAI_TTS_CODECS] as [string, ...string[]];
const STT_ENCODING_VALUES = [...XAI_STT_ENCODINGS] as [string, ...string[]];

interface VoiceCommandContext {
  ui: {
    notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
    setStatus(key: string, value?: string): void;
    setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    getEditorText(): string;
    setEditorText(text: string): void;
    pasteToEditor(text: string): void;
  };
  sessionManager: {
    getBranch(): unknown[];
  };
}

let activePlayback: ChildProcess | undefined;
let activeRecording: LocalRecording | undefined;
let recordingBusy = false;
let listeningWidgetTimer: ReturnType<typeof setInterval> | undefined;
let listeningWidgetFrame = 0;
let liveTranscriptTimer: ReturnType<typeof setInterval> | undefined;
let liveTranscriptBusy = false;
let liveTranscriptGeneration = 0;
let liveTranscriptText = "";
let liveTranscriptLastSizeBytes = 0;
let liveTranscriptBaseEditorText = "";
let liveTranscriptPreviewActive = false;
let activeVoicePreferences: VoicePreferences | undefined;
let liveTranscriptGhostText = DEFAULT_LIVE_TRANSCRIPT_GHOST_TEXT;
let liveTranscriptGhostFrame = 0;

const LIVE_TRANSCRIPT_GHOST_COLORS = ["3;90", "2;37", "3;37", "2;90"] as const;

const LISTENING_WIDGET_KEY = "xai-voice-listening";
const LISTENING_WIDGET_PLACEMENT = "aboveEditor" as const;
const LISTENING_WIDGET_LEVELS = [1, 2, 3, 4, 5, 4, 3, 2] as const;
const LISTENING_WIDGET_BAR_COLORS = ["38;5;46", "38;5;82", "38;5;226", "38;5;214", "38;5;203"] as const;
const LIVE_TRANSCRIPT_MIN_BYTES = 16_000;

function ansi(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function renderListeningMeter(level: number): string {
  const bars = LISTENING_WIDGET_BAR_COLORS.map((color, index) => {
    if (index < level) return ansi(`1;${color}`, "|");
    return ansi("90", ".");
  }).join("");

  return `${ansi("1;96", "Listening")} ${ansi("90", "[")}${bars}${ansi("90", "]")}`;
}

function getActiveVoicePreferences(): VoicePreferences {
  if (activeVoicePreferences) return activeVoicePreferences;
  const { config } = getRequiredXaiApiKey();
  activeVoicePreferences = resolveVoicePreferences(config.xai.voice);
  return activeVoicePreferences;
}

function setActiveVoicePreferences(preferences: VoicePreferences): void {
  activeVoicePreferences = { ...preferences };
}

function renderLiveTranscriptPreviewText(transcript: string): string {
  const cleanTranscript = transcript.trim();
  if (!liveTranscriptGhostText || !cleanTranscript) return cleanTranscript;
  const color = LIVE_TRANSCRIPT_GHOST_COLORS[liveTranscriptGhostFrame % LIVE_TRANSCRIPT_GHOST_COLORS.length] ?? "3;90";
  return ansi(color, cleanTranscript);
}

function mergeTranscriptIntoEditor(baseText: string, transcript: string): string {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return baseText;
  if (!baseText) return cleanTranscript;
  return /[\s\n]$/.test(baseText) ? `${baseText}${cleanTranscript}` : `${baseText}\n${cleanTranscript}`;
}

function setLiveTranscriptPreview(ctx: VoiceCommandContext, transcript: string): void {
  ctx.ui.setEditorText(
    mergeTranscriptIntoEditor(liveTranscriptBaseEditorText, renderLiveTranscriptPreviewText(transcript)),
  );
  liveTranscriptPreviewActive = transcript.trim().length > 0;
}

function restoreLiveTranscriptPreview(ctx: VoiceCommandContext): void {
  if (!liveTranscriptPreviewActive) return;
  ctx.ui.setEditorText(liveTranscriptBaseEditorText);
  liveTranscriptPreviewActive = false;
}

function createLogger(): XaiMediaLogger {
  if (process.env.XAI_VOICE_DEBUG === "1") return console;
  return {};
}

function createRuntime(log = createLogger()): {
  apiKey: string;
  apiKeySource: string;
  config: ResolvedXaiConfig;
  client: XaiClient;
  log: XaiMediaLogger;
  defaults: {
    voiceId: string;
    ttsQuality: "low" | "medium" | "high";
    sttEnabled: boolean;
    sttLanguage: VoiceSttLanguage;
    language: string;
    shortcut: string;
    shortcutMode: "push-to-talk" | "toggle";
    realtimeTokenTtlSeconds: number;
    microphoneDeviceIndex: number;
    liveTranscriptEnabled: boolean;
    liveTranscriptPollingMs: number;
    liveTranscriptGhostText: boolean;
  };
} {
  const { apiKey, source, config } = getRequiredXaiApiKey();
  const voiceConfig = config.xai.voice;
  const preferences = resolveVoicePreferences(voiceConfig);
  const defaultVoice = typeof voiceConfig.defaultVoice === "string" && voiceConfig.defaultVoice.trim()
    ? voiceConfig.defaultVoice.trim()
    : undefined;
  const defaultLanguage = typeof voiceConfig.defaultLanguage === "string" && voiceConfig.defaultLanguage.trim()
    ? voiceConfig.defaultLanguage.trim()
    : undefined;
  const ephemeralTokenSeconds =
    typeof voiceConfig.ephemeralTokenSeconds === "number" && Number.isFinite(voiceConfig.ephemeralTokenSeconds)
      ? voiceConfig.ephemeralTokenSeconds
      : undefined;
  const microphoneDeviceIndex =
    typeof voiceConfig.microphoneDeviceIndex === "number" && Number.isFinite(voiceConfig.microphoneDeviceIndex)
      ? voiceConfig.microphoneDeviceIndex
      : undefined;
  return {
    apiKey,
    apiKeySource: source,
    config,
    client: new XaiClient({ apiKey, baseUrl: config.xai.baseUrl, log }),
    log,
    defaults: {
      voiceId: preferences.voiceId || defaultVoice || DEFAULT_XAI_VOICE_ID,
      ttsQuality: preferences.ttsQuality || DEFAULT_VOICE_TTS_QUALITY,
      sttEnabled: typeof preferences.sttEnabled === "boolean" ? preferences.sttEnabled : DEFAULT_STT_ENABLED,
      sttLanguage: preferences.sttLanguage || DEFAULT_STT_LANGUAGE,
      language: defaultLanguage || DEFAULT_XAI_VOICE_LANGUAGE,
      shortcut: preferences.shortcut || DEFAULT_VOICE_SHORTCUT,
      shortcutMode: preferences.shortcutMode || DEFAULT_VOICE_SHORTCUT_MODE,
      realtimeTokenTtlSeconds: ephemeralTokenSeconds || DEFAULT_REALTIME_TOKEN_TTL_SECONDS,
      microphoneDeviceIndex: microphoneDeviceIndex || 0,
      liveTranscriptEnabled:
        typeof preferences.liveTranscriptEnabled === "boolean"
          ? preferences.liveTranscriptEnabled
          : DEFAULT_LIVE_TRANSCRIPT_ENABLED,
      liveTranscriptPollingMs: preferences.liveTranscriptPollingMs || DEFAULT_LIVE_TRANSCRIPT_POLL_MS,
      liveTranscriptGhostText:
        typeof preferences.liveTranscriptGhostText === "boolean"
          ? preferences.liveTranscriptGhostText
          : DEFAULT_LIVE_TRANSCRIPT_GHOST_TEXT,
    },
  };
}

async function runXaiVoiceHealthCheck() {
  const runtime = createRuntime();
  const health = await runtime.client.checkHealth(runtime.log);
  return {
    ...health,
    apiKeySource: runtime.apiKeySource,
    loadedFiles: runtime.config.loadedFiles,
    defaultVoice: runtime.defaults.voiceId,
    defaultLanguage: runtime.defaults.language,
    realtimeTokenTtlSeconds: runtime.defaults.realtimeTokenTtlSeconds,
    microphoneDeviceIndex: runtime.defaults.microphoneDeviceIndex,
    sttLanguage: runtime.defaults.sttLanguage,
  };
}

function xaiVoiceHealthSummary(result: {
  baseUrl: string;
  modelCount: number;
  sampleModels: string[];
  apiKeySource: string;
  loadedFiles: string[];
  defaultVoice: string;
  defaultLanguage: string;
  realtimeTokenTtlSeconds: number;
  microphoneDeviceIndex: number;
  sttLanguage?: string;
}): string {
  const lines = [
    "xAI voice health OK.",
    `Base URL: ${result.baseUrl}`,
    `API key: ${result.apiKeySource}`,
    `Models visible: ${result.modelCount}`,
    `Default voice: ${result.defaultVoice}`,
    `Default language: ${result.defaultLanguage}`,
    `Mic device index: ${result.microphoneDeviceIndex}`,
    `Realtime token TTL: ${result.realtimeTokenTtlSeconds}s`,
    "Config namespace: xai.voice",
  ];
  if (result.sttLanguage) lines.push(`STT language hint: ${result.sttLanguage}`);
  if (result.sampleModels.length) lines.push(`Sample models: ${result.sampleModels.join(", ")}`);
  if (result.loadedFiles.length) lines.push(`Settings: ${result.loadedFiles.join(", ")}`);
  return lines.join("\n");
}

function ttsSummary(result: {
  audioPath: string;
  voiceId: string;
  language: string;
  codec: string;
  sizeBytes: number;
}) {
  return [
    "Generated speech.",
    `Voice: ${result.voiceId}`,
    `Language: ${result.language}`,
    `Codec: ${result.codec}`,
    `File: ${result.audioPath}`,
    `Size: ${result.sizeBytes.toLocaleString()} bytes`,
  ].join("\n");
}

function resolveSttLanguage(language: VoiceSttLanguage): string | undefined {
  return language === "auto" ? undefined : language;
}

function sttSummary(result: {
  text: string;
  language?: string;
  duration?: number;
  words: Array<{ speaker?: number }>;
  channels: Array<unknown>;
}) {
  const speakerCount = new Set(
    result.words
      .map((word) => word.speaker)
      .filter((speaker): speaker is number => typeof speaker === "number"),
  ).size;
  const lines = ["Transcribed audio."];
  if (result.language) lines.push(`Detected language: ${result.language}`);
  if (typeof result.duration === "number") lines.push(`Duration: ${result.duration}s`);
  if (result.channels.length) lines.push(`Channels: ${result.channels.length}`);
  if (speakerCount) lines.push(`Speakers: ${speakerCount}`);
  lines.push("", result.text || "(empty transcript)");
  return lines.join("\n");
}

function voicesSummary(voices: Array<{ voiceId: string; name?: string; tone?: string; description?: string }>) {
  if (!voices.length) return "No voices returned.";
  return [
    `Available voices: ${voices.length}`,
    ...voices.map((voice) => {
      const extras = [voice.name, voice.tone, voice.description].filter(Boolean).join(" · ");
      return `- ${voice.voiceId}${extras ? ` — ${extras}` : ""}`;
    }),
  ].join("\n");
}

function realtimeSummary(result: {
  text: string;
  audioPath?: string;
  voice: string;
  sampleRate: number;
  responseId?: string;
}) {
  const lines = [
    "Realtime voice turn complete.",
    `Voice: ${result.voice}`,
    `Sample rate: ${result.sampleRate} Hz`,
  ];
  if (result.responseId) lines.push(`Response: ${result.responseId}`);
  if (result.audioPath) lines.push(`Audio: ${result.audioPath}`);
  lines.push("", result.text || "(empty response text)");
  return lines.join("\n");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
      parts.push(record.text.trim());
    }
  }
  return parts.join("\n\n").trim();
}

function getLastAssistantText(ctx: VoiceCommandContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "assistant") continue;
    const text = extractTextContent(messageRecord.content);
    if (text) return text;
  }
  return undefined;
}

function resolveSpeakText(args: string | undefined, ctx: VoiceCommandContext): string | undefined {
  const direct = args?.trim();
  if (direct) return direct;

  const editorText = ctx.ui.getEditorText().trim();
  if (editorText) return editorText;

  return getLastAssistantText(ctx);
}

async function playAudioFile(filePath: string, log: XaiMediaLogger, options?: { wait?: boolean }): Promise<void> {
  stopAudioPlayback(activePlayback);
  activePlayback = await startAudioPlayback(filePath, log);
  const playback = activePlayback;
  const closed = new Promise<void>((resolve) => {
    playback.once("close", () => {
      if (activePlayback?.pid === playback.pid) activePlayback = undefined;
      resolve();
    });
  });
  if (options?.wait) await closed;
}

function inferPreviewExtension(previewUrl: string): string {
  try {
    const pathname = new URL(previewUrl).pathname;
    const match = pathname.match(/\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i);
    return match?.[0]?.toLowerCase() || ".mp3";
  } catch {
    return ".mp3";
  }
}

async function downloadVoicePreview(previewUrl: string, filePath: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(previewUrl, { signal });
  if (!response.ok) {
    throw new Error(`Preview download failed: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await Bun.write(filePath, bytes);
}

async function startVoicePreviewPlayback(previewUrl: string, _ctx: VoiceCommandContext): Promise<VoicePreviewHandle> {
  const runtime = createRuntime();
  const filePath = createLocalAudioTempPath("voice-preview", inferPreviewExtension(previewUrl));
  const controller = new AbortController();
  let previewPlayback: ChildProcess | undefined;

  const closed = (async () => {
    try {
      await downloadVoicePreview(previewUrl, filePath, controller.signal);
      if (controller.signal.aborted) return;

      stopAudioPlayback(activePlayback);
      previewPlayback = await startAudioPlayback(filePath, runtime.log);
      activePlayback = previewPlayback;

      await new Promise<void>((resolve) => {
        previewPlayback?.once("close", () => {
          if (activePlayback?.pid === previewPlayback?.pid) activePlayback = undefined;
          resolve();
        });
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      try {
        unlinkSync(filePath);
      } catch (e) {
        void e;
      }
    }
  })();

  return {
    stop: () => {
      controller.abort();
      stopAudioPlayback(previewPlayback);
    },
    closed,
  };
}

async function speakText(text: string, ctx: VoiceCommandContext): Promise<void> {
  const runtime = createRuntime();
  const outputFormat = TTS_QUALITY_PRESETS[runtime.defaults.ttsQuality];
  ctx.ui.setStatus("xai-voice-speak", "Generating speech...");
  try {
    const result = await textToSpeechWithXai(
      runtime.client,
      {
        text,
        voiceId: runtime.defaults.voiceId,
        language: runtime.defaults.language,
        outputFormat,
      },
      runtime.log,
    );

    await playAudioFile(result.audioPath, runtime.log);

    ctx.ui.notify(`Speaking via ${result.voiceId}`, "success");
  } finally {
    ctx.ui.setStatus("xai-voice-speak", undefined);
  }
}

function resetVoiceCaptureUi(ctx: VoiceCommandContext): void {
  ctx.ui.setStatus("xai-voice-record", undefined);
  ctx.ui.setStatus("xai-voice-transcribe", undefined);
  stopLiveTranscript(ctx, { restoreEditor: true });
  stopListeningWidget(ctx);
}

function renderListeningWidget(ctx: VoiceCommandContext): void {
  const level = LISTENING_WIDGET_LEVELS[listeningWidgetFrame % LISTENING_WIDGET_LEVELS.length] ?? 1;
  ctx.ui.setWidget(LISTENING_WIDGET_KEY, [renderListeningMeter(level)], { placement: LISTENING_WIDGET_PLACEMENT });
}

function startListeningWidget(ctx: VoiceCommandContext): void {
  stopListeningWidget(ctx);
  listeningWidgetFrame = 0;
  liveTranscriptGhostFrame = 0;
  renderListeningWidget(ctx);
  listeningWidgetTimer = setInterval(() => {
    listeningWidgetFrame = (listeningWidgetFrame + 1) % LISTENING_WIDGET_LEVELS.length;
    liveTranscriptGhostFrame = (liveTranscriptGhostFrame + 1) % LIVE_TRANSCRIPT_GHOST_COLORS.length;
    if (liveTranscriptPreviewActive && liveTranscriptGhostText && liveTranscriptText) {
      setLiveTranscriptPreview(ctx, liveTranscriptText);
    }
    renderListeningWidget(ctx);
  }, 120);
}

function stopListeningWidget(ctx: VoiceCommandContext): void {
  if (listeningWidgetTimer) {
    clearInterval(listeningWidgetTimer);
    listeningWidgetTimer = undefined;
  }
  ctx.ui.setWidget(LISTENING_WIDGET_KEY, undefined, { placement: LISTENING_WIDGET_PLACEMENT });
}

function stopLiveTranscript(ctx: VoiceCommandContext, options?: { restoreEditor?: boolean }): void {
  if (liveTranscriptTimer) {
    clearInterval(liveTranscriptTimer);
    liveTranscriptTimer = undefined;
  }
  if (options?.restoreEditor) {
    restoreLiveTranscriptPreview(ctx);
  }
  liveTranscriptBusy = false;
  liveTranscriptText = "";
  liveTranscriptLastSizeBytes = 0;
  liveTranscriptGhostText = DEFAULT_LIVE_TRANSCRIPT_GHOST_TEXT;
  liveTranscriptGhostFrame = 0;
  liveTranscriptGeneration += 1;
}

async function pollLiveTranscript(
  ctx: VoiceCommandContext,
  recording: LocalRecording,
  generation: number,
): Promise<void> {
  if (liveTranscriptBusy) return;
  if (activeRecording !== recording) return;
  if (recording.sizeBytes <= LIVE_TRANSCRIPT_MIN_BYTES) return;
  if (recording.sizeBytes === liveTranscriptLastSizeBytes) return;

  liveTranscriptBusy = true;
  const snapshotPath = createMicrophoneRecordingSnapshot(recording);
  if (!snapshotPath) {
    liveTranscriptBusy = false;
    return;
  }

  try {
    const runtime = createRuntime();
    const result = await speechToTextWithXai(
      runtime.client,
      {
        file: snapshotPath,
        language: resolveSttLanguage(runtime.defaults.sttLanguage),
        format: Boolean(resolveSttLanguage(runtime.defaults.sttLanguage)),
      },
      runtime.log,
    );

    if (generation !== liveTranscriptGeneration || activeRecording !== recording) return;

    liveTranscriptLastSizeBytes = recording.sizeBytes;
    const transcript = result.text.trim();
    if (!transcript || transcript === liveTranscriptText) return;
    liveTranscriptText = transcript;
    setLiveTranscriptPreview(ctx, transcript);
    renderListeningWidget(ctx);
  } catch {
    // Keep fallback path quiet. Final stop->transcribe still authoritative.
  } finally {
    try {
      unlinkSync(snapshotPath);
    } catch (e) {
      void e;
    }
    liveTranscriptBusy = false;
  }
}

function startLiveTranscript(
  ctx: VoiceCommandContext,
  recording: LocalRecording,
  options: { pollingMs: number; ghostText: boolean },
): void {
  stopLiveTranscript(ctx, { restoreEditor: false });
  liveTranscriptGeneration += 1;
  liveTranscriptBaseEditorText = ctx.ui.getEditorText();
  liveTranscriptPreviewActive = false;
  liveTranscriptGhostText = options.ghostText;
  liveTranscriptGhostFrame = 0;
  const generation = liveTranscriptGeneration;
  liveTranscriptTimer = setInterval(() => {
    void pollLiveTranscript(ctx, recording, generation);
  }, options.pollingMs);
}

function handleVoiceCaptureError(ctx: VoiceCommandContext, error: unknown): void {
  activeRecording = undefined;
  recordingBusy = false;
  resetVoiceCaptureUi(ctx);
  ctx.ui.notify(`Voice capture failed: ${summarizeError(error)}`, "error");
}

async function startVoiceCapture(ctx: VoiceCommandContext): Promise<void> {
  if (recordingBusy) {
    ctx.ui.notify("Voice capture busy. Wait for current transcription.", "warning");
    return;
  }
  if (activeRecording) return;

  const runtime = createRuntime();
  if (!runtime.defaults.sttEnabled) {
    ctx.ui.notify("Speech-to-text disabled. Enable it in /xai-voice-settings.", "warning");
    return;
  }

  activeRecording = await startMicrophoneRecording({
    filePath: createLocalAudioTempPath("mic", ".wav"),
    microphoneDeviceIndex: runtime.defaults.microphoneDeviceIndex,
    sampleRate: 16_000,
    channels: 1,
    log: runtime.log,
  });
  ctx.ui.setStatus("xai-voice-record", undefined);
  liveTranscriptBaseEditorText = ctx.ui.getEditorText();
  liveTranscriptPreviewActive = false;
  if (runtime.defaults.liveTranscriptEnabled) {
    startLiveTranscript(ctx, activeRecording, {
      pollingMs: runtime.defaults.liveTranscriptPollingMs,
      ghostText: runtime.defaults.liveTranscriptGhostText,
    });
  }
  startListeningWidget(ctx);
}

async function stopVoiceCapture(ctx: VoiceCommandContext): Promise<void> {
  if (recordingBusy) {
    ctx.ui.notify("Voice capture busy. Wait for current transcription.", "warning");
    return;
  }
  if (!activeRecording) {
    ctx.ui.notify("No active microphone recording", "warning");
    return;
  }

  recordingBusy = true;
  const recording = activeRecording;
  activeRecording = undefined;
  ctx.ui.setStatus("xai-voice-record", undefined);
  stopLiveTranscript(ctx, { restoreEditor: false });
  stopListeningWidget(ctx);
  ctx.ui.setStatus("xai-voice-transcribe", "Transcribing microphone audio...");

  try {
    const stopped = await stopMicrophoneRecording(recording);
    const runtime = createRuntime();
    const result = await speechToTextWithXai(
      runtime.client,
      {
        file: stopped.filePath,
        language: resolveSttLanguage(runtime.defaults.sttLanguage),
        format: Boolean(resolveSttLanguage(runtime.defaults.sttLanguage)),
      },
      runtime.log,
    );

    const transcript = result.text.trim();
    if (!transcript) {
      restoreLiveTranscriptPreview(ctx);
      ctx.ui.notify("No speech detected", "warning");
      return;
    }

    ctx.ui.setEditorText(mergeTranscriptIntoEditor(liveTranscriptBaseEditorText, transcript));
    liveTranscriptPreviewActive = false;
    ctx.ui.notify("Transcript inserted into editor", "success");
  } finally {
    recordingBusy = false;
    ctx.ui.setStatus("xai-voice-transcribe", undefined);
  }
}

async function toggleMicrophoneRecording(ctx: VoiceCommandContext): Promise<void> {
  if (!activeRecording) {
    await startVoiceCapture(ctx);
    ctx.ui.notify("Microphone recording started", "info");
    return;
  }

  await stopVoiceCapture(ctx);
}

const textToSpeechTool = defineTool({
  name: "text_to_speech",
  label: "text_to_speech",
  description:
    "Generate speech audio from text via xAI /v1/tts. Saves returned audio bytes to local temp file. Can also play audio locally.",
  promptSnippet: "text_to_speech(text, voiceId?, language?, codec?, play?) -> xAI TTS audio file or local playback. If a remote-chat delivery tool such as telegram_attach is available and the user requested a spoken remote reply, attach the returned audioPath with that tool.",
  parameters: Type.Object({
    text: Type.String({ description: "Text to speak. Supports xAI speech tags. Max 15,000 chars." }),
    voiceId: Type.Optional(
      StringEnum(VOICE_ID_VALUES, {
        description: `Voice override. Default from xai.voice.defaultVoice or ${DEFAULT_XAI_VOICE_ID}.`,
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: `BCP-47 language code or auto. Default from xai.voice.defaultLanguage or ${DEFAULT_XAI_VOICE_LANGUAGE}.`,
      }),
    ),
    codec: Type.Optional(
      StringEnum(TTS_CODEC_VALUES, {
        description: "Output codec. mp3 default. wav good for editing. pcm/mulaw/alaw for pipelines.",
      }),
    ),
    sampleRate: Type.Optional(
      Type.Integer({
        minimum: 8000,
        maximum: 48000,
        description: "Output sample rate. Valid values enforced at runtime.",
      }),
    ),
    bitRate: Type.Optional(
      Type.Integer({
        minimum: 32000,
        maximum: 192000,
        description: "MP3 bitrate only. Valid values enforced at runtime.",
      }),
    ),
    play: Type.Optional(
      Type.Boolean({ description: "If true, play generated audio locally on this machine." }),
    ),
    fileName: Type.Optional(Type.String({ description: "Optional output filename stem." })),
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Generating speech with xAI..." }],
      details: { status: "running" },
    });
    const result = await textToSpeechWithXai(
      runtime.client,
      {
        text: params.text,
        voiceId: params.voiceId || runtime.defaults.voiceId,
        language: params.language || runtime.defaults.language,
        outputFormat:
          params.codec || params.sampleRate || params.bitRate
            ? {
                codec: params.codec,
                sampleRate: params.sampleRate,
                bitRate: params.bitRate,
              }
            : TTS_QUALITY_PRESETS[runtime.defaults.ttsQuality],
        fileName: params.fileName,
      },
      runtime.log,
    );
    if (params.play) {
      await playAudioFile(result.audioPath, runtime.log);
    }
    return {
      content: [
        {
          type: "text",
          text: `${ttsSummary(result)}${params.play ? "\nPlayed locally: yes" : ""}`,
        },
      ],
      details: result,
    };
  },
});

const listTtsVoicesTool = defineTool({
  name: "list_tts_voices",
  label: "list_tts_voices",
  description: "List voices available on xAI /v1/tts/voices.",
  promptSnippet: "list_tts_voices() -> available xAI voice ids and descriptions",
  parameters: Type.Object({}),
  async execute() {
    const runtime = createRuntime();
    const result = await listTextToSpeechVoicesWithXai(runtime.client, runtime.log);
    return {
      content: [{ type: "text", text: voicesSummary(result.voices) }],
      details: result,
    };
  },
});

const speechToTextTool = defineTool({
  name: "speech_to_text",
  label: "speech_to_text",
  description:
    "Transcribe audio file or remote audio URL via xAI /v1/stt. Supports formatting, diarization, multichannel.",
  promptSnippet: "speech_to_text(file|url, format?, diarize?, multichannel?) -> xAI transcript. Use local voice/audio file paths forwarded by bridge extensions such as pi-telegram when the user asks about spoken content.",
  parameters: Type.Object({
    file: Type.Optional(Type.String({ description: "Local audio file path." })),
    url: Type.Optional(Type.String({ description: "Remote audio URL for server-side fetch." })),
    audioFormat: Type.Optional(
      StringEnum(STT_ENCODING_VALUES, {
        description: "Only for raw headerless audio. Use pcm, mulaw, or alaw.",
      }),
    ),
    sampleRate: Type.Optional(
      Type.Integer({
        minimum: 8000,
        maximum: 48000,
        description: "Required for raw audio. Valid values enforced at runtime.",
      }),
    ),
    language: Type.Optional(
      Type.String({ description: "Language code. Required when format=true." }),
    ),
    format: Type.Optional(
      Type.Boolean({
        description: "Enable inverse text normalization for numbers, currencies, units.",
      }),
    ),
    multichannel: Type.Optional(
      Type.Boolean({ description: "Transcribe each audio channel independently." }),
    ),
    channels: Type.Optional(
      Type.Integer({
        minimum: 2,
        maximum: 8,
        description: "Channel count. Needed for multichannel raw audio.",
      }),
    ),
    diarize: Type.Optional(Type.Boolean({ description: "Enable speaker diarization." })),
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Transcribing audio with xAI..." }],
      details: { status: "running" },
    });
    const result = await speechToTextWithXai(runtime.client, params, runtime.log);
    return {
      content: [{ type: "text", text: sttSummary(result) }],
      details: result,
    };
  },
});

const createRealtimeClientSecretTool = defineTool({
  name: "create_realtime_voice_client_secret",
  label: "create_realtime_voice_client_secret",
  description:
    "Mint short-lived xAI realtime client secret for browser/mobile Voice Agent connections without exposing API key.",
  promptSnippet:
    "create_realtime_voice_client_secret(expiresAfterSeconds?) -> ephemeral token for /v1/realtime",
  parameters: Type.Object({
    expiresAfterSeconds: Type.Optional(
      Type.Integer({ minimum: 1, description: "Requested token lifetime in seconds." }),
    ),
  }),
  async execute(_toolCallId, params) {
    const runtime = createRuntime();
    const result = await createRealtimeClientSecretWithXai(
      runtime.client,
      {
        expiresAfterSeconds: params.expiresAfterSeconds || runtime.defaults.realtimeTokenTtlSeconds,
      },
      runtime.log,
    );
    const lines = [
      "Created realtime client secret.",
      `TTL: ${result.expiresAfterSeconds}s`,
      ...(result.expiresAt !== undefined ? [`Expires at: ${String(result.expiresAt)}`] : []),
      ...(result.clientSecret ? ["Client secret returned in tool details."] : ["Raw response returned in tool details."]),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: result,
    };
  },
});

const realtimeVoiceTextTurnTool = defineTool({
  name: "realtime_voice_text_turn",
  label: "realtime_voice_text_turn",
  description:
    "Run one text-only roundtrip against xAI /v1/realtime, collect assistant text, save returned PCM audio as WAV. Good smoke test for realtime voice prompts/voice choice. Not live microphone streaming.",
  promptSnippet:
    "realtime_voice_text_turn(text, instructions?, voice?) -> one-shot xAI realtime response + wav file",
  parameters: Type.Object({
    text: Type.String({ description: "User message to send into realtime voice session." }),
    instructions: Type.Optional(Type.String({ description: "Session instructions/system prompt." })),
    voice: Type.Optional(
      StringEnum(VOICE_ID_VALUES, {
        description: `Voice override. Default from xai.voice.defaultVoice or ${DEFAULT_XAI_VOICE_ID}.`,
      }),
    ),
    sampleRate: Type.Optional(
      Type.Integer({
        minimum: 8000,
        maximum: 48000,
        description: "PCM output sample rate for saved WAV file.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1000, description: "Max wait time for realtime response." }),
    ),
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Opening xAI realtime voice session..." }],
      details: { status: "running" },
    });
    const result = await realtimeVoiceTextTurnWithXai(
      runtime.client,
      {
        text: params.text,
        instructions: params.instructions,
        voice: params.voice || runtime.defaults.voiceId,
        sampleRate: params.sampleRate,
        timeoutMs: params.timeoutMs,
        expiresAfterSeconds: runtime.defaults.realtimeTokenTtlSeconds,
      },
      runtime.log,
    );
    return {
      content: [{ type: "text", text: realtimeSummary(result) }],
      details: result,
    };
  },
});

const checkXaiVoiceHealthTool = defineTool({
  name: "check_xai_voice_health",
  label: "check_xai_voice_health",
  description: "Check xAI auth, base URL, visible models, voice defaults, realtime token TTL.",
  promptSnippet: "check_xai_voice_health() -> validate xAI voice config/auth",
  parameters: Type.Object({}),
  async execute() {
    try {
      const result = await runXaiVoiceHealthCheck();
      return {
        content: [{ type: "text", text: xaiVoiceHealthSummary(result) }],
        details: result,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `xAI voice health failed.\n${summarizeError(error)}` }],
        details: undefined,
      };
    }
  },
});

export default function piXaiVoiceExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    setActiveVoicePreferences(createRuntime().defaults);
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new VoicePushToTalkEditor(tui, theme, keybindings, {
          getSttEnabled: () => getActiveVoicePreferences().sttEnabled,
          getShortcut: () => getActiveVoicePreferences().shortcut,
          getShortcutMode: () => getActiveVoicePreferences().shortcutMode,
          onPushToTalkStart: async () => {
            try {
              await startVoiceCapture(ctx);
            } catch (error) {
              handleVoiceCaptureError(ctx, error);
            }
          },
          onPushToTalkStop: async () => {
            try {
              await stopVoiceCapture(ctx);
            } catch (error) {
              handleVoiceCaptureError(ctx, error);
            }
          },
        }),
    );
  });

  pi.registerTool(textToSpeechTool);
  pi.registerTool(listTtsVoicesTool);
  pi.registerTool(speechToTextTool);
  pi.registerTool(createRealtimeClientSecretTool);
  pi.registerTool(realtimeVoiceTextTurnTool);
  pi.registerTool(checkXaiVoiceHealthTool);

  pi.registerCommand("xai-speak", {
    description: "Speak provided text, current editor text, or last assistant message",
    handler: async (args, ctx) => {
      const text = resolveSpeakText(args, ctx);
      if (!text) {
        ctx.ui.notify("No text found. Pass text, fill editor, or wait for assistant reply.", "warning");
        return;
      }
      try {
        await speakText(text, ctx);
      } catch (error) {
        ctx.ui.notify(`Speech output failed: ${summarizeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("xai-voice-settings", {
    description: "Configure xAI voice defaults, shortcut, live transcript polling, and ghost text",
    handler: async (_args, ctx) => {
      if (activeRecording || recordingBusy) {
        ctx.ui.notify("Stop recording before changing voice settings.", "warning");
        return;
      }

      const runtime = createRuntime();
      const current = runtime.defaults;
      let voices: Awaited<ReturnType<typeof listTextToSpeechVoicesWithXai>>["voices"] = [];
      try {
        voices = (await listTextToSpeechVoicesWithXai(runtime.client, runtime.log)).voices;
      } catch {
        // Fallback to static voice ids when voice catalog unavailable.
      }

      const draft: VoicePreferences = {
        voiceId: current.voiceId,
        ttsQuality: current.ttsQuality,
        sttEnabled: current.sttEnabled,
        sttLanguage: current.sttLanguage,
        shortcut: current.shortcut,
        shortcutMode: current.shortcutMode,
        liveTranscriptEnabled: current.liveTranscriptEnabled,
        liveTranscriptPollingMs: current.liveTranscriptPollingMs,
        liveTranscriptGhostText: current.liveTranscriptGhostText,
      };

      const updated = await openVoiceSettingsDialog(ctx, draft, voices, async (voice) => {
        if (!voice.previewUrl) throw new Error("No preview available for this voice.");
        return startVoicePreviewPlayback(voice.previewUrl, ctx);
      });
      if (!updated) return;

      const path = saveVoicePreferences(ctx.cwd, updated.preferences, updated.scope);
      setActiveVoicePreferences(updated.preferences);
      ctx.ui.notify(`Voice settings saved (${updated.scope}) to ${path}`, "info");
    },
  });

  pi.registerCommand("xai-record", {
    description: "Toggle microphone recording and paste transcript into editor",
    handler: async (_args, ctx) => {
      try {
        await toggleMicrophoneRecording(ctx);
      } catch (error) {
        handleVoiceCaptureError(ctx, error);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    stopAudioPlayback(activePlayback);
    activePlayback = undefined;
    if (activeRecording) {
      try {
        await stopMicrophoneRecording(activeRecording);
      } catch (e) {
        void e;
      }
      activeRecording = undefined;
    }
    if (listeningWidgetTimer) {
      clearInterval(listeningWidgetTimer);
      listeningWidgetTimer = undefined;
    }
    if (liveTranscriptTimer) {
      clearInterval(liveTranscriptTimer);
      liveTranscriptTimer = undefined;
    }
    liveTranscriptBusy = false;
    liveTranscriptText = "";
    liveTranscriptLastSizeBytes = 0;
    liveTranscriptGeneration += 1;
    recordingBusy = false;
  });

  pi.registerCommand("xai-voice-health", {
    description: "Check xAI voice API health and config",
    handler: async (_args, ctx) => {
      try {
        const result = await runXaiVoiceHealthCheck();
        ctx.ui.notify(
          `xAI voice OK · ${result.modelCount} models · ${result.apiKeySource}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`xAI voice health failed: ${summarizeError(error)}`, "error");
      }
    },
  });
}
