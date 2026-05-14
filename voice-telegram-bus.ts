/**
 * pi-xai-voice → pi-telegram voice integration
 * New architecture: function-based handler + extension section + shared config
 * Zero-coupling: reads/writes globalThis registries created by pi-telegram.
 */

import { appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piVoiceAdapterV1 } from "./voice-adapter.ts";
import { XAI_VOICE_IDS } from "./xai-voice.ts";

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
  // Also try recordRuntimeEvent if available
  try {
    const recordEvent = (globalThis as Record<string, unknown>).__piTelegramRecordEvent__;
    if (typeof recordEvent === "function") {
      (recordEvent as (category: string, message: string, details?: unknown) => void)(
        tag,
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
  (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY] = { ...DEFAULT_VOICE_CONFIG };
  return { ...DEFAULT_VOICE_CONFIG };
}

export function setVoiceConfig(partial: Partial<PiTelegramVoiceConfig>): void {
  const current = getVoiceConfig();
  const updated = { ...current, ...partial };
  (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY] = updated;
  onConfigChangeCallback?.(updated);
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

export async function registerXaiVoiceTelegramHandler(): Promise<void> {
  console.log('[pi-xai-voice] Registrierung mit pi-telegram versuchen...');

  const paths = [
    "pi-telegram/lib/outbound-handlers",
    "../pi-telegram/lib/outbound-handlers",
    "../../pi-telegram/lib/outbound-handlers",
    "../../../pi-telegram/lib/outbound-handlers",
  ];

  for (const p of paths) {
    try {
      const piTelegram = await import(p);
      if (typeof piTelegram.registerTelegramVoiceProvider === "function") {
        piTelegram.registerTelegramVoiceProvider(
          async (text: string, options: any = {}) => {
            console.log('[XAI-TTS] Provider called with text length:', text.length);

            const config = getVoiceConfig();
            console.log('[XAI-TTS] config voice=', config.defaultVoice, 'lang=', config.defaultLanguage, 'style=', config.speechStyle);

            // Apply speech style (tags, light rewrite, or literal)
            const speechText = rewriteForSpeech(text, config.speechStyle);
            const cleanText = stripSpeechTags(speechText);
            setLastVoiceTranscript(cleanText);
            console.log('[XAI-TTS] speechText:', speechText.substring(0, 80) + (speechText.length > 80 ? '...' : ''));

            const result = await piVoiceAdapterV1.synthesize({
              text: speechText,
              voiceId: config.defaultVoice,
              language: options?.lang || config.defaultLanguage,
            });

            console.log('[XAI-TTS] synthesize returned filePath:', result.filePath);
            console.log('[XAI-TTS] file exists?', existsSync(result.filePath));

            // Convert to OGG/Opus for Telegram (pi-telegram no longer auto-converts)
            const oggPath = result.filePath.replace(/\.mp3$/i, '.voice.ogg');
            try {
              await runFfmpeg(result.filePath, oggPath);
              await unlink(result.filePath);
              const oggExists = existsSync(oggPath);
              console.log('[XAI-TTS] ffmpeg complete:', oggPath, 'exists?', oggExists);
              if (!oggExists) {
                console.error('[XAI-TTS] OGG file not found after ffmpeg, falling back to mp3');
                return result.filePath;
              }
              return oggPath;
            } catch (err) {
              console.error('[XAI-TTS] ffmpeg failed, falling back to mp3:', err);
              return result.filePath;
            }
          },
          { id: "xai" }
        );
        console.log('[pi-xai-voice] Provider erfolgreich registriert');
        return;
      }
    } catch (e) {
      console.log('[pi-xai-voice] Import Versuch fehlgeschlagen:', p);
    }
  }
  console.warn('[pi-xai-voice] pi-telegram nicht gefunden – standalone Mode');
}

// ─── Voice Extension Section ─────────────────────────────────────────────────

let sectionDisposer: (() => void) | undefined;

function isVoiceSectionRegistered(): boolean {
  const registry = (globalThis as Record<string, unknown>).__piTelegramSectionRegistry__;
  if (!registry || typeof registry !== "object") return false;
  const sections =
    (registry as { getSections?: () => Array<{ id: string }> }).getSections?.() ?? [];
  return sections.some((s) => s.id === "pi-xai-voice");
}

/**
 * Register a Voice Extension Section in pi-telegram's UI.
 * Provides toggles for reply mode, TTS voice, and speech style.
 * Re-registers on every call — disposes the previous registration first.
 * Skips if the section is already present in pi-telegram's registry.
 */
export async function registerXaiVoiceTelegramSection(): Promise<void> {
  if (isVoiceSectionRegistered()) return;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const piTelegram = await import(resolve(__dirname, "../pi-telegram/lib/extension-sections"));
    if (typeof piTelegram.registerTelegramSection !== "function") return;

    sectionDisposer?.();
    sectionDisposer = piTelegram.registerTelegramSection({
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
              [{ text: "ℹ️ Speech Tags", callback_data: ctx.callbackData("helpTags") }],
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
                  [{ text: "ℹ️ Speech Tags", callback_data: ctx.callbackData("helpTags") }],
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
                  [{ text: "ℹ️ Speech Tags", callback_data: ctx.callbackData("helpTags") }],
                ],
              },
            });
            return "handled";
          }
          if (ctx.action === "helpTags") {
            await ctx.edit({
              text: `<b>🏷️ Speech Tags</b>\n\n<i>Make speech more expressive with inline tags.</i>\n\n<b>Inline tags</b> — placed at a specific point:\n• [pause] — brief pause\n• [long-pause] — longer pause\n• [laugh] — laugh\n• [sigh] — sigh\n• [gasp] — gasp\n\n<b>Wrapping tags</b> — wrap a section of text:\n• &lt;whisper&gt;text&lt;/whisper&gt; — whispered\n• &lt;slow&gt;text&lt;/slow&gt; — slower delivery\n• &lt;soft&gt;text&lt;/soft&gt; — softer volume\n• &lt;emphasis&gt;text&lt;/emphasis&gt; — emphasized\n\n<i>Example:</i> <code>So I walked in and [pause] there it was. [laugh] I honestly could not believe it! &lt;whisper&gt;It was a secret the whole time.&lt;/whisper&gt;</code>`,
            });
            return "handled";
          }
          return "pass";
        } catch (err) {
          throw err;
        }
      },
    });
  } catch {
    // pi-telegram not available — voice works standalone without it.
    // Silently skip. No dependency on pi-telegram.
  }
}
