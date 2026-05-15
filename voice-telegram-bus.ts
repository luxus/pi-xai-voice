/**
 * pi-xai-voice → pi-telegram voice integration
 * New architecture: function-based handler + extension section + shared config
 * Zero-coupling: reads/writes globalThis registries created by pi-telegram.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { piVoiceAdapterV1 } from "./voice-adapter.ts";
import { XAI_VOICE_IDS } from "./xai-voice.ts";
import { resolveXaiConfig } from "./xai-config.ts";

// ─── Debug Logger ────────────────────────────────────────────────────────────

const DEBUG_LOG_PATH = "/tmp/pi-xai-voice-debug.log";

function debugLog(tag: string, message: string, extra?: unknown): void {
  const timestamp = new Date().toISOString();
  const extraStr = extra !== undefined ? ` ${JSON.stringify(extra)}` : "";
  const line = `[${timestamp}] [${tag}] ${message}${extraStr}\n`;
  try {
    appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore write errors
  }
  // Record via the event recorder that pi-telegram actually exposes (correct global key).
  try {
    const recordEvent = (globalThis as Record<string, unknown>).__piTelegramVoiceEventRecorder__;
    if (typeof recordEvent === "function") {
      (recordEvent as (category: string, err: unknown, details?: unknown) => void)(
        `xai-voice:${tag}`,
        message,
        extra,
      );
    }
  } catch {
    // Ignore
  }
}

// ─── Voice Descriptions ──────────────────────────────────────────────────────

const VOICE_DESCRIPTIONS: Record<string, string> = {
  eve: "Energetic, upbeat — engaging and enthusiastic",
  ara: "Warm, friendly — balanced and conversational",
  rex: "Confident, clear — professional and articulate",
  sal: "Smooth, balanced — versatile for any context",
  leo: "Authoritative, strong — commanding and decisive",
  una: "Bright, expressive — vivid and dynamic",
};

// ─── Shared Config ───────────────────────────────────────────────────────────

const VOICE_CONFIG_KEY = "__piTelegramVoiceConfig__" as const;

let onConfigChangeCallback: ((config: PiTelegramVoiceConfig) => void) | undefined;
let lastVoiceTranscript: string | undefined;

/** Best-effort path to the telegram.json that pi-telegram's configStore reads. */
function getTelegramJsonPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  // Common locations: ~/.pi/telegram.json (global) or project-level under agent dir
  return join(home, ".pi", "telegram.json");
}

export function onVoiceConfigChanged(callback: (config: PiTelegramVoiceConfig) => void): void {
  onConfigChangeCallback = callback;
}

export function setLastVoiceTranscript(text: string): void {
  lastVoiceTranscript = text;
}

export function getLastVoiceTranscript(): string | undefined {
  return lastVoiceTranscript;
}

// ─── Text Rewriting for Speech ─────────────────────────────────────────────

function rewriteLight(text: string): string {
  return text
    .replace(/\bdon't\b/gi, "don't")
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bcan't\b/gi, "can't")
    .replace(/\bcannot\b/gi, "can't")
    .replace(/\bwon't\b/gi, "won't")
    .replace(/\bwill not\b/gi, "won't")
    .replace(/\bit's\b/gi, "it's")
    .replace(/\bit is\b/gi, "it's")
    .replace(/\bi'm\b/gi, "I'm")
    .replace(/\bi am\b/gi, "I'm")
    .replace(/\bhe's\b/gi, "he's")
    .replace(/\bhe is\b/gi, "he's")
    .replace(/\bshe's\b/gi, "she's")
    .replace(/\bshe is\b/gi, "she's")
    .replace(/\bthat's\b/gi, "that's")
    .replace(/\bthat is\b/gi, "that's")
    .replace(/\bthere's\b/gi, "there's")
    .replace(/\bthere is\b/gi, "there's")
    .replace(/\bwhat's\b/gi, "what's")
    .replace(/\bwhat is\b/gi, "what's")
    .replace(/\bhow's\b/gi, "how's")
    .replace(/\bhow is\b/gi, "how's")
    .replace(/\bhere's\b/gi, "here's")
    .replace(/\bhere is\b/gi, "here's")
    .replace(/\bwhere's\b/gi, "where's")
    .replace(/\bwhere is\b/gi, "where's")
    .replace(/\bwho's\b/gi, "who's")
    .replace(/\bwho is\b/gi, "who's");
}

function addSpeechTags(text: string): string {
  return (
    text
      // Add pauses after sentence-ending punctuation
      .replace(/([.!?])\s+(?=[A-Z])/g, "$1 [pause] ")
      // Add long pause for ellipsis
      .replace(/\.\.\./g, "[long-pause]")
      // Add sigh for negative statements
      .replace(/\b(sad|bad|sorry|unfortunately|disappointed)\b/gi, "[sigh] $1")
      // Add laugh for positive/humorous cues
      .replace(/\b(haha|lol|funny|joke|hilarious)\b/gi, "[laugh] $1")
      // Add gasp for surprise
      .replace(/\b(wow|amazing|incredible|shocking|surprising)\b/gi, "[gasp] $1")
      // Add emphasis for key phrases
      .replace(
        /\b(important|crucial|essential|critical|must|need to)\b/gi,
        "<emphasis>$1</emphasis>",
      )
      // Whisper for secrets or private thoughts
      .replace(/\b(secret|private|confidential|between us)\b/gi, "<whisper>$1</whisper>")
      // Slow for important final statements
      .replace(/\b(in conclusion|to summarize|finally|in short)\b/gi, "<slow>$1</slow>")
      // Clean up double spaces
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function stripSpeechTags(text: string): string {
  return text
    .replace(/\[(\w+(?:-\w+)?)\]/g, "") // [pause], [long-pause], [laugh], etc.
    .replace(/<(\w+)>(.*?)<\/\1>/g, "$2") // <whisper>text</whisper>, <emphasis>text</emphasis>
    .replace(/\s+/g, " ")
    .trim();
}

function rewriteForSpeech(text: string, style: PiTelegramVoiceConfig["speechStyle"]): string {
  switch (style) {
    case "literal":
      return text;
    case "rewrite-light":
      return rewriteLight(text);
    case "rewrite-tags":
      return addSpeechTags(rewriteLight(text));
    default:
      return text;
  }
}

export interface PiTelegramVoiceConfig {
  replyMode: "mirror" | "voice" | "manual";
  provider: string;
  providerOptions: Record<string, unknown>;
  defaultVoice: string;
  defaultLanguage: string;
  speechStyle: "literal" | "rewrite-light" | "rewrite-tags";
  sendTranscript: boolean;
}

const DEFAULT_VOICE_CONFIG: PiTelegramVoiceConfig = {
  replyMode: "mirror",
  provider: "xai",
  providerOptions: {},
  defaultVoice: piVoiceAdapterV1.getDefaults().voiceId || "alloy",
  defaultLanguage: piVoiceAdapterV1.getDefaults().language || "auto",
  speechStyle: "literal",
  sendTranscript: false,
};

function migrateReplyMode(
  value: string | undefined,
): PiTelegramVoiceConfig["replyMode"] | undefined {
  if (value === "mirror" || value === "voice" || value === "manual") return value;
  if (value === "voice-received") return "mirror";
  if (value === "always") return "voice";
  if (value === "on-request") return "manual";
  return undefined;
}

export function getVoiceConfig(): PiTelegramVoiceConfig {
  const existing = (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY];
  if (existing && typeof existing === "object" && existing !== null) {
    const partial = existing as Partial<PiTelegramVoiceConfig> & { replyMode?: string };
    const migrated: Partial<PiTelegramVoiceConfig> = { ...partial };
    if (partial.replyMode) {
      migrated.replyMode = migrateReplyMode(partial.replyMode);
    }
    return { ...DEFAULT_VOICE_CONFIG, ...migrated };
  }

  // Fallback: read from xai.voice config in settings.json
  try {
    const xaiConfig = resolveXaiConfig();
    const voiceConfig = xaiConfig.xai.voice;
    if (voiceConfig && typeof voiceConfig === "object" && !Array.isArray(voiceConfig)) {
      const xaiPartial: Partial<PiTelegramVoiceConfig> = {};
      const vc = voiceConfig as Record<string, unknown>;
      if (typeof vc.defaultVoice === "string") xaiPartial.defaultVoice = vc.defaultVoice;
      if (typeof vc.defaultLanguage === "string") xaiPartial.defaultLanguage = vc.defaultLanguage;
      if (
        typeof vc.speechStyle === "string" &&
        ["literal", "rewrite-light", "rewrite-tags"].includes(vc.speechStyle)
      ) {
        xaiPartial.speechStyle = vc.speechStyle as PiTelegramVoiceConfig["speechStyle"];
      }
      if (typeof vc.replyMode === "string") {
        xaiPartial.replyMode = migrateReplyMode(vc.replyMode);
      }
      if (typeof vc.sendTranscript === "boolean") xaiPartial.sendTranscript = vc.sendTranscript;

      const merged = { ...DEFAULT_VOICE_CONFIG, ...xaiPartial };
      (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY] = { ...merged };
      return merged;
    }
  } catch {
    // Ignore config read errors
  }

  (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY] = { ...DEFAULT_VOICE_CONFIG };
  return { ...DEFAULT_VOICE_CONFIG };
}

export function setVoiceConfig(partial: Partial<PiTelegramVoiceConfig>): void {
  const current = getVoiceConfig();
  const updated = { ...current, ...partial };
  (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY] = updated;
  onConfigChangeCallback?.(updated);

  // Persist replyMode (and any voice.* fields that affect bridge policy) to telegram.json.
  // This makes changes in the Voice (x.ai) section actually control tagging / mirror / voice / manual
  // because pi-telegram's getTelegramVoiceReplyMode reads telegram.json (maintainer requirement).
  // xai-voice owns the UI and the write; bridge only offers the read interface.
  if (partial.replyMode !== undefined) {
    try {
      const path = getTelegramJsonPath();
      let cfg: any = {};
      if (existsSync(path)) {
        cfg = JSON.parse(readFileSync(path, "utf8") || "{}");
      }
      cfg.voice = cfg.voice || {};
      cfg.voice.replyMode = updated.replyMode;
      writeFileSync(path, JSON.stringify(cfg, null, 2));
    } catch {
      // Non-fatal: globalThis fallback + next session_start sync still works.
    }
  }
}

// ─── Voice Outbound Handler ──────────────────────────────────────────────────

/**
 * Register a programmatic voice outbound handler with pi-telegram.
 * The handler receives TTS text + options and returns an OGG/Opus file path.
 * Re-registers on every call — pi-telegram overwrites the previous handler.
 */

async function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-vbr",
        "on",
        outputPath,
      ],
      { stdio: "pipe" },
    );

    let stderrData = "";
    child.stderr.on("data", (data: Buffer) => {
      stderrData += data.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderrData.trim()}`));
    });

    child.on("error", (error: Error) => {
      reject(new Error(`ffmpeg spawn failed: ${error.message}`));
    });
  });
}

/** Generate a safe, unique .ogg path in the system temp dir (more reliable than mutating the input filename). */
function createOggOutputPath(originalMp3Path: string): string {
  const base = basename(originalMp3Path, extname(originalMp3Path)).replace(/[^a-zA-Z0-9_-]/g, "");
  const unique = randomBytes(6).toString("hex");
  return join(tmpdir(), `${base || "xai-voice"}-${unique}.ogg`);
}

export async function registerXaiVoiceTelegramHandler(): Promise<void> {
  // Try clean static import first (after adding @llblab/pi-telegram peerDep).
  // Falls back to old relative path hack only for local sibling dev without proper linking.
  try {
    const piTelegram = await import("@llblab/pi-telegram");
    if (typeof piTelegram.registerTelegramVoiceProvider === "function") {
      const fn = async (text: string, options: any = {}) => {
        const config = getVoiceConfig();

        // Apply speech style (tags, light rewrite, or literal)
        const speechText = rewriteForSpeech(text, config.speechStyle);
        const cleanText = stripSpeechTags(speechText);
        setLastVoiceTranscript(cleanText);

        const result = await piVoiceAdapterV1.synthesize({
          text: speechText,
          voiceId: config.defaultVoice,
          language: options?.lang || config.defaultLanguage,
        });

        // Convert to OGG/Opus for Telegram (provider responsibility, as per docs/voice.md)
        const oggPath = createOggOutputPath(result.filePath);
          try {
            await runFfmpeg(result.filePath, oggPath);
            await unlink(result.filePath).catch(() => {});
            if (existsSync(oggPath)) {
              try {
                const rec = (globalThis as any).__piTelegramVoiceEventRecorder__;
                if (typeof rec === "function") rec("xai-voice", null, { phase: "ffmpeg-success", oggPath });
              } catch {}

              const config = getVoiceConfig();
              // Always return a clean transcriptText (for caption under voice + session history/logs).
              // The toggle only decides whether we also send it as a separate text message after the voice note.
              return {
                audioPath: oggPath,
                transcriptText: cleanText,                    // always useful for logs + caption
                sendTranscriptAsMessage: config.sendTranscript,
              };
            }
          } catch (ffmpegErr) {
            try {
              await unlink(result.filePath).catch(() => {});
              const rec = (globalThis as any).__piTelegramVoiceEventRecorder__;
              if (typeof rec === "function") rec("xai-voice", ffmpegErr, { phase: "ffmpeg-failed" });
            } catch {}
            // Never return non-ogg (mp3) to the bridge per v2 contract; throw so bridge does clean text fallback.
            throw ffmpegErr instanceof Error ? ffmpegErr : new Error("ffmpeg conversion failed");
          }
      };
      (fn as any).getVoicePromptContribution = (view: any) => {
        if (view?.voiceReplyPreferred || view?.voiceReplyRequired) {
          return "You are in voice mode. The user will hear your reply as spoken audio.\nReply ONLY with the exact text to be spoken.\nNO thinking, no markdown, no code, no extra commentary or explanations.";
        }
        return undefined;
      };
      piTelegram.registerTelegramVoiceProvider(fn as any, { id: "xai", persistent: true });
      return;
    }
  } catch {
    // fall to hack below for pure local dev
  }

  // Fallback hack for local sibling checkout (removed in published releases)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const paths = [
    resolve(__dirname, "../pi-telegram/lib/outbound-handlers"),
    resolve(__dirname, "../../pi-telegram/lib/outbound-handlers"),
  ];
  for (const p of paths) {
    try {
      const piTelegram = await import(p);
      if (typeof piTelegram.registerTelegramVoiceProvider === "function") {
        const fn = async (text: string, options: any = {}) => {
          const config = getVoiceConfig();
          const speechText = rewriteForSpeech(text, config.speechStyle);
          const cleanText = stripSpeechTags(speechText);
          setLastVoiceTranscript(cleanText);
          const result = await piVoiceAdapterV1.synthesize({
            text: speechText,
            voiceId: config.defaultVoice,
            language: options?.lang || config.defaultLanguage,
          });
          const oggPath = result.filePath.replace(/\.mp3$/i, ".voice.ogg");
          try {
            await runFfmpeg(result.filePath, oggPath);
            await unlink(result.filePath);
            if (existsSync(oggPath)) return oggPath;
          } catch {}
          // Never return mp3 in dev fallback either
          await unlink(result.filePath).catch(() => {});
          throw new Error("ffmpeg conversion failed (dev fallback)");
        };
        (fn as any).getVoicePromptContribution = (view: any) => {
          if (view?.voiceReplyPreferred || view?.voiceReplyRequired) {
            return "You are in voice mode. Reply ONLY with the exact text to be spoken. NO thinking, no markdown.";
          }
          return undefined;
        };
        piTelegram.registerTelegramVoiceProvider(fn as any, { id: "xai", persistent: true });
        return;
      }
    } catch {}
  }
}

// ─── Voice Extension Section ─────────────────────────────────────────────────

let sectionDisposer: (() => void) | undefined;

/**
 * Register a Voice Extension Section in pi-telegram's UI.
 * Provides toggles for reply mode, TTS voice, language, speech style, and transcript.
 * (Speech Tags explanation removed per user request)
 * Re-registers on every call — disposes the previous registration first.
 * Skips if the section is already present in pi-telegram's registry.
 */
export async function registerXaiVoiceTelegramSection(): Promise<void> {
  // Setup import/recordEvent once (stable). Retry *only* the register call for
  // cases where pi-telegram's section registry global isn't ready yet.
  // Uses recordTelegramRuntimeEvent for diagnostics in /telegram-status.
  // Complements reRegisterPersistentSections() + direct calls on session_start.
  let piTelegram: any;
  try {
    piTelegram = await import("@llblab/pi-telegram");
  } catch {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    piTelegram = await import(resolve(__dirname, "../pi-telegram/lib/extension-sections"));
  }
  if (typeof piTelegram.registerTelegramSection !== "function") return;

  const recordEvent =
    typeof piTelegram.recordTelegramRuntimeEvent === "function"
      ? piTelegram.recordTelegramRuntimeEvent
      : (globalThis as any).__piTelegramVoiceEventRecorder__;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      sectionDisposer?.();
      sectionDisposer = piTelegram.registerTelegramSection(
      {
        id: "pi-xai-voice",
        label: "🔊 Voice (x.ai)",
        order: 10,
        render: async (ctx: any) => {
        const config = getVoiceConfig();
        const voiceDesc = VOICE_DESCRIPTIONS[config.defaultVoice];
        return {
          text: `<b>🔊 Voice (x.ai)</b>\n\n<i>Configure xAI text-to-speech settings.</i>\n\nReply mode: <code>${config.replyMode}</code>\nVoice: <code>${config.defaultVoice}</code>${voiceDesc ? ` — <i>${voiceDesc}</i>` : ""}\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>\nTranscript: <code>${config.sendTranscript ? "on" : "off"}</code>`,
          replyMarkup: {
            inline_keyboard: [
              [{ text: "📡 Reply Mode", callback_data: ctx.callbackData("replyMode") }],
              [{ text: "🎙️ Voice", callback_data: ctx.callbackData("voice") }],
              [{ text: "🌐 Language", callback_data: ctx.callbackData("language") }],
              [{ text: "✨ Style", callback_data: ctx.callbackData("style") }],
              [
                {
                  text: `📝 Transcript: ${config.sendTranscript ? "On" : "Off"}`,
                  callback_data: ctx.callbackData(
                    "sendTranscript",
                    config.sendTranscript ? "off" : "on",
                  ),
                },
              ],
            ],
          },
        };
      },
      handleCallback: async (ctx: any) => {
        try {
          if (ctx.action === "open") {
            const config = getVoiceConfig();
            const voiceDesc = VOICE_DESCRIPTIONS[config.defaultVoice];
            await ctx.edit({
              text: `<b>🔊 Voice (x.ai)</b>\n\n<i>Configure xAI text-to-speech settings.</i>\n\nReply mode: <code>${config.replyMode}</code>\nVoice: <code>${config.defaultVoice}</code>${voiceDesc ? ` — <i>${voiceDesc}</i>` : ""}\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>\nTranscript: <code>${config.sendTranscript ? "on" : "off"}</code>`,
              replyMarkup: {
                inline_keyboard: [
                  [{ text: "📡 Reply Mode", callback_data: ctx.callbackData("replyMode") }],
                  [{ text: "🎙️ Voice", callback_data: ctx.callbackData("voice") }],
                  [{ text: "🌐 Language", callback_data: ctx.callbackData("language") }],
                  [{ text: "✨ Style", callback_data: ctx.callbackData("style") }],
                  [
                    {
                      text: `📝 Transcript: ${config.sendTranscript ? "On" : "Off"}`,
                      callback_data: ctx.callbackData(
                        "sendTranscript",
                        config.sendTranscript ? "off" : "on",
                      ),
                    },
                  ],
                ],
              },
            });
            return "handled";
          }
          if (ctx.action === "replyMode") {
            const modes: {
              value: PiTelegramVoiceConfig["replyMode"];
              label: string;
              desc: string;
            }[] = [
              {
                value: "mirror",
                label: "🔄 Mirror",
                desc: "Reply with voice only when you send voice",
              },
              { value: "voice", label: "🔊 Always voice", desc: "Always reply with voice" },
              { value: "manual", label: "✍️ Manual", desc: "Only on explicit request" },
            ];

            const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
            if (payload && modes.some((m) => m.value === payload)) {
              setVoiceConfig({ replyMode: payload as PiTelegramVoiceConfig["replyMode"] });
            }

            const config = getVoiceConfig();
            await ctx.edit({
              text: `<b>📡 Reply Mode</b>\n\n<i>Choose when the bot replies with voice.</i>\n\nCurrent: <code>${config.replyMode}</code>\n\n<b>🔄 Mirror</b> — reply with voice only when you send voice\n<b>🔊 Always voice</b> — always reply with voice\n<b>✍️ Manual</b> — only on explicit request`,
              replyMarkup: {
                inline_keyboard: modes.map((m) => [
                  {
                    text: m.value === config.replyMode ? `✅ ${m.label}` : m.label,
                    callback_data: ctx.callbackData("replyMode", m.value),
                  },
                ]),
              },
            });
            return "handled";
          }
          if (ctx.action === "voice") {
            const voices = [...XAI_VOICE_IDS];

            const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
            if (payload && payload.trim().length >= 2) {
              setVoiceConfig({ defaultVoice: payload });
            }

            const config = getVoiceConfig();
            const currentDesc = VOICE_DESCRIPTIONS[config.defaultVoice];
            const voiceButtons = voices.map((v) => [
              {
                text: v === config.defaultVoice ? `✅ ${v}` : v,
                callback_data: ctx.callbackData("voice", v),
              },
            ]);
            // Show custom voice if one is set (not in built-in list)
            if (!voices.includes(config.defaultVoice)) {
              voiceButtons.push([
                {
                  text: `🎤 ${config.defaultVoice}`,
                  callback_data: ctx.callbackData("voice", config.defaultVoice),
                },
              ]);
            }

            await ctx.edit({
              text: `<b>🎙️ TTS Voice</b>\n\n<i>Select the voice personality for speech synthesis.</i>\n\nCurrent: <code>${config.defaultVoice}</code>${currentDesc ? `\n— <i>${currentDesc}</i>` : ""}\n\n<b>Built-in voices</b>`,
              replyMarkup: {
                inline_keyboard: [
                  ...voiceButtons,
                  [
                    {
                      text: "➕ Set custom voice...",
                      callback_data: ctx.callbackData("customVoice"),
                    },
                  ],
                ],
              },
            });
            return "handled";
          }
          if (ctx.action === "customVoice") {
            await ctx.enqueuePrompt(
              "The user wants to set a custom xAI voice ID. Ask them for the voice ID they want to use. Any non-empty string is valid. Once they provide it, call set_voice_id with that ID.",
            );
            return "handled";
          }
          if (ctx.action === "style") {
            const styles: {
              value: PiTelegramVoiceConfig["speechStyle"];
              label: string;
              desc: string;
            }[] = [
              { value: "literal", label: "Literal", desc: "Read text exactly as written" },
              {
                value: "rewrite-light",
                label: "Light rewrite",
                desc: "Slight naturalization of text",
              },
              {
                value: "rewrite-tags",
                label: "Rewrite with tags",
                desc: "Add speech tags for expression",
              },
            ];

            const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
            if (payload && styles.some((s) => s.value === payload)) {
              setVoiceConfig({ speechStyle: payload as PiTelegramVoiceConfig["speechStyle"] });
            }

            const config = getVoiceConfig();
            await ctx.edit({
              text: `<b>✨ Speech Style</b>\n\n<i>How should the bot speak?</i>\n\nCurrent: <code>${config.speechStyle}</code>\n\n<b>Literal</b> — read text exactly as written\n<b>Light rewrite</b> — slight naturalization of text\n<b>Rewrite with tags</b> — add speech tags for expression`,
              replyMarkup: {
                inline_keyboard: styles.map((s) => [
                  {
                    text: s.value === config.speechStyle ? `✅ ${s.label}` : s.label,
                    callback_data: ctx.callbackData("style", s.value),
                  },
                ]),
              },
            });
            return "handled";
          }
          if (ctx.action === "language") {
            const languages = [
              { value: "auto", label: "🔍 Auto-detect" },
              { value: "de", label: "🇩🇪 German" },
              { value: "en", label: "🇬🇧 English" },
              { value: "fr", label: "🇫🇷 French" },
              { value: "es", label: "🇪🇸 Spanish" },
              { value: "it", label: "🇮🇹 Italian" },
              { value: "pt", label: "🇵🇹 Portuguese" },
              { value: "nl", label: "🇳🇱 Dutch" },
              { value: "pl", label: "🇵🇱 Polish" },
              { value: "ru", label: "🇷🇺 Russian" },
              { value: "zh", label: "🇨🇳 Chinese" },
              { value: "ja", label: "🇯🇵 Japanese" },
              { value: "ko", label: "🇰🇷 Korean" },
              { value: "ar", label: "🇸🇦 Arabic" },
              { value: "hi", label: "🇮🇳 Hindi" },
              { value: "tr", label: "🇹🇷 Turkish" },
              { value: "sv", label: "🇸🇪 Swedish" },
              { value: "cs", label: "🇨🇿 Czech" },
            ];

            const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
            if (payload && languages.some((l) => l.value === payload)) {
              setVoiceConfig({ defaultLanguage: payload });
            }

            const config = getVoiceConfig();
            await ctx.edit({
              text: `<b>🌐 Language</b>\n\n<i>Select the TTS language or use auto-detect.</i>\n\nCurrent: <code>${config.defaultLanguage}</code>`,
              replyMarkup: {
                inline_keyboard: languages.map((l) => [
                  {
                    text: l.value === config.defaultLanguage ? `✅ ${l.label}` : l.label,
                    callback_data: ctx.callbackData("language", l.value),
                  },
                ]),
              },
            });
            return "handled";
          }
          if (ctx.action === "sendTranscript") {
            const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
            const current = getVoiceConfig().sendTranscript;
            const next = payload === "on" || payload === "off" ? payload === "on" : !current;
            setVoiceConfig({ sendTranscript: next });

            const config = getVoiceConfig();
            const voiceDesc = VOICE_DESCRIPTIONS[config.defaultVoice];
            await ctx.edit({
              text: `<b>🔊 Voice (x.ai)</b>\n\n<i>Configure xAI text-to-speech settings.</i>\n\nReply mode: <code>${config.replyMode}</code>\nVoice: <code>${config.defaultVoice}</code>${voiceDesc ? ` — <i>${voiceDesc}</i>` : ""}\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>\nTranscript: <code>${config.sendTranscript ? "on" : "off"}</code>`,
              replyMarkup: {
                inline_keyboard: [
                  [{ text: "📡 Reply Mode", callback_data: ctx.callbackData("replyMode") }],
                  [{ text: "🎙️ Voice", callback_data: ctx.callbackData("voice") }],
                  [{ text: "🌐 Language", callback_data: ctx.callbackData("language") }],
                  [{ text: "✨ Style", callback_data: ctx.callbackData("style") }],
                  [
                    {
                      text: `📝 Transcript: ${config.sendTranscript ? "On" : "Off"}`,
                      callback_data: ctx.callbackData(
                        "sendTranscript",
                        config.sendTranscript ? "off" : "on",
                      ),
                    },
                  ],
                ],
              },
            });
            return "handled";
          }
          return "pass";
        } catch (err) {
          throw err;
        }
      },
    },
    { persistent: true }
  );

      // Success path: record via recordTelegramRuntimeEvent (preferred) so it appears in /telegram-status
      try {
        if (typeof recordEvent === "function") {
          recordEvent("xai-voice", null, { phase: "section-registration-success", attempt });
        }
      } catch {}

      return; // success, exit retry loop
    } catch (err) {
      // Record failure using recordTelegramRuntimeEvent when available
      try {
        if (typeof recordEvent === "function") {
          recordEvent("xai-voice", err, { phase: "section-registration-failed", attempt });
        } else {
          const rec = (globalThis as any).__piTelegramVoiceEventRecorder__;
          if (typeof rec === "function") rec("xai-voice", err, { phase: "section-registration-failed", attempt });
        }
      } catch {}

      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      // exhausted retries; failure already recorded
    }
  }
}
