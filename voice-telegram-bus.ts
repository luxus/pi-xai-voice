/**
 * pi-xai-voice → pi-telegram voice integration
 * New architecture: function-based handler + extension section + shared config
 * Zero-coupling: reads/writes globalThis registries created by pi-telegram.
 */

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piVoiceAdapterV1 } from "./voice-adapter.ts";
import { XAI_VOICE_IDS } from "./xai-voice.ts";

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

export function onVoiceConfigChanged(callback: (config: PiTelegramVoiceConfig) => void): void {
  onConfigChangeCallback = callback;
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
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const piTelegram = await import(resolve(__dirname, "../pi-telegram/lib/outbound-handlers"));
    if (typeof piTelegram.registerTelegramVoiceProvider !== "function") return;

    piTelegram.registerTelegramVoiceProvider(
      async (text: any, options: any) => {
        const config = getVoiceConfig();
        const voiceId = config.defaultVoice;
        const lang = options?.lang || config.defaultLanguage;

        console.error(`[xai-voice-provider] synthesize start voice=${voiceId} lang=${lang}`);

        const result = await piVoiceAdapterV1.synthesize({
          text,
          voiceId,
          language: lang,
        });

        console.error(`[xai-voice-provider] synthesize complete: ${result.filePath}`);

        // Convert MP3 → OGG/Opus (workaround for pi-telegram ffmpeg bug)
        const oggPath = result.filePath.replace(/\.mp3$/i, ".voice.ogg");
        try {
          console.error(`[xai-voice-provider] ffmpeg start: ${result.filePath} → ${oggPath}`);
          await runFfmpeg(result.filePath, oggPath);
          console.error(`[xai-voice-provider] ffmpeg complete: ${oggPath}`);

          await unlink(result.filePath);
          console.error(`[xai-voice-provider] cleanup mp3: ${result.filePath}`);

          return oggPath;
        } catch (err) {
          console.error(`[xai-voice-provider] ffmpeg failed, falling back to mp3:`, err);
          return result.filePath;
        }
      },
      { id: "xai" },
    );
  } catch {
    // pi-telegram not available — voice works standalone without it.
    // Silently skip. No dependency on pi-telegram.
  }
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
