/**
 * pi-xai-voice → pi-telegram voice integration
 * New architecture: function-based handler + extension section + shared config
 * Zero-coupling: reads/writes globalThis registries created by pi-telegram.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piVoiceAdapterV1 } from "./voice-adapter.ts";
import { XAI_VOICE_IDS } from "./xai-voice.ts";

// ─── Shared Config ───────────────────────────────────────────────────────────

const VOICE_CONFIG_KEY = "__piTelegramVoiceConfig__" as const;

let onConfigChangeCallback: ((config: PiTelegramVoiceConfig) => void) | undefined;

export function onVoiceConfigChanged(callback: (config: PiTelegramVoiceConfig) => void): void {
  onConfigChangeCallback = callback;
}

export interface PiTelegramVoiceConfig {
  replyMode: "voice-received" | "always" | "on-request";
  provider: string;
  providerOptions: Record<string, unknown>;
  defaultVoice: string;
  defaultLanguage: string;
  speechStyle: "literal" | "rewrite-light" | "rewrite-tags";
  sendTranscript: boolean;
}

const DEFAULT_VOICE_CONFIG: PiTelegramVoiceConfig = {
  replyMode: "voice-received",
  provider: "xai",
  providerOptions: {},
  defaultVoice: piVoiceAdapterV1.getDefaults().voiceId || "alloy",
  defaultLanguage: piVoiceAdapterV1.getDefaults().language || "auto",
  speechStyle: "literal",
  sendTranscript: false,
};

export function getVoiceConfig(): PiTelegramVoiceConfig {
  const existing = (globalThis as Record<string, unknown>)[VOICE_CONFIG_KEY];
  if (existing && typeof existing === "object" && existing !== null) {
    return { ...DEFAULT_VOICE_CONFIG, ...(existing as Partial<PiTelegramVoiceConfig>) };
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
export async function registerXaiVoiceTelegramHandler(): Promise<void> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const piTelegram = await import(resolve(__dirname, "../pi-telegram/lib/outbound-handlers"));
    if (typeof piTelegram.registerTelegramOutboundHandler !== "function") return;

    piTelegram.registerTelegramOutboundHandler("voice", async (text, options) => {
      const config = getVoiceConfig();
      const voiceId = config.defaultVoice;
      const lang = options?.lang || config.defaultLanguage;

      // Generate TTS audio via xAI (returns MP3, Telegram sendVoice accepts it)
      const result = await piVoiceAdapterV1.synthesize({
        text,
        voiceId,
        language: lang,
      });

      return result.filePath;
    });

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
  const sections = (registry as { getSections?: () => Array<{ id: string }> }).getSections?.() ?? [];
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
      label: "🎙️ Voice (x.ai)",
      order: 10,
      render: async (ctx) => {
        const config = getVoiceConfig();
        return {
          text: `<b>🎙️ Voice (x.ai)</b>\n\nReply mode: <code>${config.replyMode}</code>\nVoice: <code>${config.defaultVoice}</code>\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>\nTranscript: <code>${config.sendTranscript ? "on" : "off"}</code>`,
          replyMarkup: {
            inline_keyboard: [
              [{ text: "Reply Mode", callback_data: ctx.callbackData("replyMode") }],
              [{ text: "Voice", callback_data: ctx.callbackData("voice") }],
              [{ text: "Language", callback_data: ctx.callbackData("language") }],
              [{ text: "Style", callback_data: ctx.callbackData("style") }],
              [{ text: `Transcript: ${config.sendTranscript ? "On" : "Off"}`, callback_data: ctx.callbackData("sendTranscript") }],
            ],
          },
        };
      },
      handleCallback: async (ctx) => {
        try {
          if (ctx.action === "open") {
          const config = getVoiceConfig();
          await ctx.edit({
            text: `<b>🎙️ Voice Settings</b>\n\nReply mode: <code>${config.replyMode}</code>\nVoice: <code>${config.defaultVoice}</code>\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>`,
            replyMarkup: {
              inline_keyboard: [
                [{ text: "Reply Mode", callback_data: ctx.callbackData("replyMode") }],
                [{ text: "Voice", callback_data: ctx.callbackData("voice") }],
                [{ text: "Language", callback_data: ctx.callbackData("language") }],
                [{ text: "Style", callback_data: ctx.callbackData("style") }],
              ],
            },
          });
          return "handled";
        }
        if (ctx.action === "replyMode") {
          const modes: { value: PiTelegramVoiceConfig["replyMode"]; label: string }[] = [
            { value: "voice-received", label: "🎙️ Voice received only" },
            { value: "always", label: "🔊 Always voice" },
            { value: "on-request", label: "💬 On request only" },
          ];

          const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
          if (payload && modes.some((m) => m.value === payload)) {
            setVoiceConfig({ replyMode: payload as PiTelegramVoiceConfig["replyMode"] });
          }

          const config = getVoiceConfig();
          await ctx.edit({
            text: `<b>🎙️ Reply Mode</b>\n\nCurrent: <code>${config.replyMode}</code>\n\nSelect when the bot replies with voice:`,
            replyMarkup: {
              inline_keyboard: [
                ...modes.map((m) => [{
                  text: m.value === config.replyMode ? `✅ ${m.label}` : m.label,
                  callback_data: ctx.callbackData("replyMode", m.value),
                }]),
              ],
            },
          });
          return "handled";
        }
        if (ctx.action === "voice") {
          const voices = [...XAI_VOICE_IDS];

          const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
          if (payload && voices.includes(payload)) {
            setVoiceConfig({ defaultVoice: payload });
          }

          const config = getVoiceConfig();
          await ctx.edit({
            text: `<b>🎙️ TTS Voice</b>\n\nCurrent: <code>${config.defaultVoice}</code>`,
            replyMarkup: {
              inline_keyboard: [
                ...voices.map((v) => [{
                  text: v === config.defaultVoice ? `✅ ${v}` : v,
                  callback_data: ctx.callbackData("voice", v),
                }]),
              ],
            },
          });
          return "handled";
        }
        if (ctx.action === "style") {
          const styles: { value: PiTelegramVoiceConfig["speechStyle"]; label: string }[] = [
            { value: "literal", label: "Literal (read as-is)" },
            { value: "rewrite-light", label: "Light rewrite" },
            { value: "rewrite-tags", label: "Rewrite with tags" },
          ];

          const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
          if (payload && styles.some((s) => s.value === payload)) {
            setVoiceConfig({ speechStyle: payload as PiTelegramVoiceConfig["speechStyle"] });
          }

          const config = getVoiceConfig();
          await ctx.edit({
            text: `<b>🎙️ Speech Style</b>\n\nCurrent: <code>${config.speechStyle}</code>`,
            replyMarkup: {
              inline_keyboard: [
                ...styles.map((s) => [{
                  text: s.value === config.speechStyle ? `✅ ${s.label}` : s.label,
                  callback_data: ctx.callbackData("style", s.value),
                }]),
              ],
            },
          });
          return "handled";
        }
        if (ctx.action === "language") {
          const languages = [
            { value: "auto", label: "🌐 Auto-detect" },
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
            text: `<b>🌐 Language</b>\n\nCurrent: <code>${config.defaultLanguage}</code>\n\nSelect TTS language:`,
            replyMarkup: {
              inline_keyboard: [
                ...languages.map((l) => [{
                  text: l.value === config.defaultLanguage ? `✅ ${l.label}` : l.label,
                  callback_data: ctx.callbackData("language", l.value),
                }]),
              ],
            },
          });
          return "handled";
        }
        if (ctx.action === "sendTranscript") {
          const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
          if (payload === "on" || payload === "off") {
            setVoiceConfig({ sendTranscript: payload === "on" });
          }

          const config = getVoiceConfig();
          await ctx.edit({
            text: `<b>📝 Transcript</b>\n\nCurrent: <code>${config.sendTranscript ? "On" : "Off"}</code>\n\nSend text transcript alongside voice message?`,
            replyMarkup: {
              inline_keyboard: [
                [{ text: config.sendTranscript ? `✅ On` : "On", callback_data: ctx.callbackData("sendTranscript", "on") }],
                [{ text: !config.sendTranscript ? `✅ Off` : "Off", callback_data: ctx.callbackData("sendTranscript", "off") }],
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
      settings: {
        label: "🎙️ Voice",
        getLabel: () => "🎙️ Voice",
        open: async (ctx) => {
          const config = getVoiceConfig();
          return {
            text: `<b>🎙️ Voice Settings</b>\n\nReply mode: <code>${config.replyMode}</code>\nVoice: <code>${config.defaultVoice}</code>\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>\nTranscript: <code>${config.sendTranscript ? "on" : "off"}</code>`,
            replyMarkup: {
              inline_keyboard: [
                [{ text: "Reply Mode", callback_data: ctx.callbackData("replyMode") }],
                [{ text: "Voice", callback_data: ctx.callbackData("voice") }],
                [{ text: "Language", callback_data: ctx.callbackData("language") }],
                [{ text: "Style", callback_data: ctx.callbackData("style") }],
                [{ text: `Transcript: ${config.sendTranscript ? "On" : "Off"}`, callback_data: ctx.callbackData("sendTranscript") }],
              ],
            },
          };
        },
      },
    });

  } catch {
    // pi-telegram not available — voice works standalone without it.
    // Silently skip. No dependency on pi-telegram.
  }
}


