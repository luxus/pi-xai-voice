/**
 * pi-xai-voice → pi-telegram voice integration
 * New architecture: voice synthesis/transcription providers + extension section.
 * Zero-coupling: uses pi-telegram public subpath APIs instead of global registry mutation.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { piVoiceAdapterV1 } from "./voice-adapter.ts";
import { DEFAULT_XAI_VOICE_ID, XAI_VOICE_IDS } from "./xai-voice.ts";
import { resolveXaiConfig } from "./xai-config.ts";

/**
 * Loads the pi-telegram bridge module.
 * In local development (especially ~/.pi/agents/... layout), it tries to find
 * the sibling checkout first before falling back to normal package resolution.
 *
 * This is the main entry point for all Telegram bridge interaction from xai-voice.
 */
/**
 * Walks upward from a starting directory, looking for a package.json
 * whose name is "@llblab/pi-telegram" or a folder literally named "pi-telegram".
 * This is much more robust than fixed relative paths.
 */
function findLocalPiTelegramRoot(startDir: string): string | null {
  let dir = startDir;
  const maxDepth = 15;

  for (let i = 0; i < maxDepth; i++) {
    // Check for package.json with the correct name
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@llblab/pi-telegram" || pkg.name === "pi-telegram") {
          return dir;
        }
      } catch {
        // ignore bad package.json
      }
    }

    // Also accept if the current folder itself is named "pi-telegram"
    if (dir.endsWith("/pi-telegram") || dir.endsWith("\\pi-telegram")) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return null;
}

export async function loadPiTelegramBridge(
  options: {
    agentsRoot?: string;
    startDir?: string;
  } = {},
): Promise<any> {
  const { agentsRoot, startDir } = options;

  // 1. Explicit agentsRoot (mainly for tests)
  if (agentsRoot) {
    const siblingIndex = join(agentsRoot, "pi-telegram", "index.ts");
    if (existsSync(siblingIndex)) {
      try {
        return await import(siblingIndex);
      } catch {}
    }
  }

  const startFrom = startDir || dirname(fileURLToPath(import.meta.url));

  // 2. Fast relative paths
  const relativeCandidates = [
    join(startFrom, "../pi-telegram/index.ts"),
    join(startFrom, "../../pi-telegram/index.ts"),
    join(startFrom, "../../../pi-telegram/index.ts"),
    join(startFrom, "../../../../pi-telegram/index.ts"),
  ];

  for (const candidate of relativeCandidates) {
    if (existsSync(candidate)) {
      try {
        return await import(candidate);
      } catch {}
    }
  }

  // 3. Explicit ~/.pi/agents detection (very common for luxus forks)
  const agentsMatch = startFrom.match(
    /(.+?[\\/]\.pi[\\/]agents[\\/]git[\\/]github\.com[\\/]luxus)[\\/]pi-xai-voice/,
  );
  if (agentsMatch) {
    const luxusRoot = agentsMatch[1];
    const siblingIndex = join(luxusRoot, "pi-telegram", "index.ts");
    if (existsSync(siblingIndex)) {
      try {
        return await import(siblingIndex);
      } catch {}
    }
  }

  // 4. Robust upward package.json / folder name walk
  const root = findLocalPiTelegramRoot(startFrom);
  if (root) {
    const indexPath = join(root, "index.ts");
    if (existsSync(indexPath)) {
      try {
        return await import(indexPath);
      } catch {}
    }
  }

  // 5. Normal package resolution
  try {
    const mod: any = await import("@llblab/pi-telegram");
    if (typeof mod.importPiTelegram === "function") {
      return await mod.importPiTelegram();
    }
    return mod;
  } catch {
    throw new Error("Could not load pi-telegram bridge");
  }
}

export async function loadPiTelegramSubmodule(
  subpath: "voice" | "extension-sections" | "outbound-handlers" | "config",
  options: { agentsRoot?: string; startDir?: string } = {},
): Promise<any> {
  const { agentsRoot, startDir } = options;

  // 1. Explicit agentsRoot (mainly for tests) - prefer lib/ subpath for submodule
  if (agentsRoot) {
    const siblingLib = join(agentsRoot, "pi-telegram", "lib", `${subpath}.ts`);
    if (existsSync(siblingLib)) {
      try {
        return await import(siblingLib);
      } catch {}
    }
  }

  const startFrom = startDir || dirname(fileURLToPath(import.meta.url));

  // 2. Fast relative paths for lib/ subpath
  const relativeCandidates = [
    join(startFrom, `../pi-telegram/lib/${subpath}.ts`),
    join(startFrom, `../../pi-telegram/lib/${subpath}.ts`),
    join(startFrom, `../../../pi-telegram/lib/${subpath}.ts`),
    join(startFrom, `../../../../pi-telegram/lib/${subpath}.ts`),
  ];

  for (const candidate of relativeCandidates) {
    if (existsSync(candidate)) {
      try {
        return await import(candidate);
      } catch {}
    }
  }

  // 3. Explicit ~/.pi/agents detection (very common for luxus forks)
  const agentsMatch = startFrom.match(
    /(.+?[\\/]\.pi[\\/]agents[\\/]git[\\/]github\.com[\\/]luxus)[\\/]pi-xai-voice/,
  );
  if (agentsMatch) {
    const luxusRoot = agentsMatch[1];
    const siblingLib = join(luxusRoot, "pi-telegram", "lib", `${subpath}.ts`);
    if (existsSync(siblingLib)) {
      try {
        return await import(siblingLib);
      } catch {}
    }
  }

  // 4. Robust upward package.json / folder name walk, then lib/ sub
  const root = findLocalPiTelegramRoot(startFrom);
  if (root) {
    const libPath = join(root, "lib", `${subpath}.ts`);
    if (existsSync(libPath)) {
      try {
        return await import(libPath);
      } catch {}
    }
  }

  // 5. Package subpath, fallback to bridge (which will also try options)
  try {
    return await import(`@llblab/pi-telegram/lib/${subpath}.ts`);
  } catch {
    return loadPiTelegramBridge(options);
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

let onConfigChangeCallback: ((config: PiTelegramVoiceConfig) => void) | undefined;
let voiceConfigOverride: PiTelegramVoiceConfig | undefined;

export function onVoiceConfigChanged(callback: (config: PiTelegramVoiceConfig) => void): void {
  onConfigChangeCallback = callback;
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
  provider: string;
  providerOptions: Record<string, unknown>;
  defaultVoice: string;
  defaultLanguage: string;
  speechStyle: "literal" | "rewrite-light" | "rewrite-tags";
  sendTranscript: boolean;
  telegramEnabled: boolean;
}

const DEFAULT_VOICE_CONFIG: PiTelegramVoiceConfig = {
  provider: "xai",
  providerOptions: {},
  defaultVoice: DEFAULT_XAI_VOICE_ID,
  defaultLanguage: "auto",
  speechStyle: "literal",
  sendTranscript: false,
  telegramEnabled: true,
};

export function getVoiceConfig(): PiTelegramVoiceConfig {
  if (voiceConfigOverride) return voiceConfigOverride;

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
      if (typeof vc.sendTranscript === "boolean") xaiPartial.sendTranscript = vc.sendTranscript;
      if (typeof vc.telegramEnabled === "boolean") xaiPartial.telegramEnabled = vc.telegramEnabled;

      const merged = { ...DEFAULT_VOICE_CONFIG, ...xaiPartial };
      voiceConfigOverride = { ...merged };
      return merged;
    }
  } catch {
    // Ignore config read errors
  }

  const merged = { ...DEFAULT_VOICE_CONFIG };
  voiceConfigOverride = { ...merged };
  return merged;
}

export function setVoiceConfig(partial: Partial<PiTelegramVoiceConfig>): void {
  const current = getVoiceConfig();
  const updated = { ...current, ...partial };
  voiceConfigOverride = updated;
  onConfigChangeCallback?.(updated);
}

// ─── Voice Outbound Handler ──────────────────────────────────────────────────

/**
 * Register a programmatic voice provider with pi-telegram.
 * The provider receives TTS text + options and returns an OGG/Opus file path.
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

let voiceProviderDisposers: Array<() => void> = [];

function disposeVoiceProviders(): void {
  for (const dispose of voiceProviderDisposers.splice(0)) {
    try {
      dispose();
    } catch {}
  }
}

export async function registerXaiVoiceTelegramHandler(
  options: { agentsRoot?: string; startDir?: string } = {},
): Promise<void> {
  let piTelegram: any;
  try {
    piTelegram = await loadPiTelegramSubmodule("voice", options);
  } catch {
    return;
  }
  const registerSynthesisProvider =
    typeof piTelegram.registerTelegramVoiceSynthesisProvider === "function"
      ? piTelegram.registerTelegramVoiceSynthesisProvider
      : undefined;
  const registerTranscriptionProvider =
    typeof piTelegram.registerTelegramVoiceTranscriptionProvider === "function"
      ? piTelegram.registerTelegramVoiceTranscriptionProvider
      : undefined;
  if (!registerSynthesisProvider && !registerTranscriptionProvider) return;

  disposeVoiceProviders();

  const transcriptionProvider = async (file: { path: string }) => {
    const config = getVoiceConfig();
    if (!config.telegramEnabled) return undefined;
    const xaiConfig = resolveXaiConfig();
    const voice =
      xaiConfig.xai && typeof xaiConfig.xai === "object"
        ? (xaiConfig.xai as Record<string, unknown>).voice
        : undefined;
    if (voice && typeof voice === "object" && !Array.isArray(voice)) {
      const vc = voice as Record<string, unknown>;
      if (vc.sttEnabled === false) return undefined;
      const sttLanguage =
        typeof vc.sttLanguage === "string" && vc.sttLanguage !== "auto"
          ? vc.sttLanguage
          : undefined;
      const result = await piVoiceAdapterV1.transcribe({
        filePath: file.path,
        language: sttLanguage,
      });
      return result.text ? { text: result.text, language: result.language } : undefined;
    }
    // malformed config: opt out of STT for safety
    return undefined;
  };

  if (registerTranscriptionProvider) {
    const dispose = registerTranscriptionProvider(transcriptionProvider, { id: "xai" });
    if (typeof dispose === "function") voiceProviderDisposers.push(dispose);
  }

  const fn = async (text: string, options: any = {}) => {
    const config = getVoiceConfig();
    if (!config.telegramEnabled) return undefined;

    // Apply speech style (tags, light rewrite, or literal)
    const speechText = rewriteForSpeech(text, config.speechStyle);
    const cleanText = stripSpeechTags(speechText);

    const lang = options?.lang || config.defaultLanguage;
    const language = lang === "auto" ? undefined : lang;

    const result = await piVoiceAdapterV1.synthesize({
      text: speechText,
      voiceId: config.defaultVoice,
      language,
    });

    // Convert to OGG/Opus for Telegram (provider responsibility)
    const oggPath = createOggOutputPath(result.filePath);
    try {
      await runFfmpeg(result.filePath, oggPath);
      await unlink(result.filePath).catch(() => {});
      if (existsSync(oggPath)) {
        return config.sendTranscript
          ? { audioPath: oggPath, transcriptText: cleanText }
          : { audioPath: oggPath };
      }
    } catch (ffmpegErr) {
      try {
        await unlink(result.filePath).catch(() => {});
        await unlink(oggPath).catch(() => {});
      } catch {}
      throw ffmpegErr instanceof Error ? ffmpegErr : new Error("ffmpeg conversion failed");
    }
  };

  if (registerSynthesisProvider) {
    const dispose = registerSynthesisProvider(fn as any, { id: "xai" });
    if (typeof dispose === "function") voiceProviderDisposers.push(dispose);
  }
}

// ─── Voice Extension Section ─────────────────────────────────────────────────

let sectionDisposer: (() => void) | undefined;

function getXaiVoiceSectionLabel(): string {
  return `🎙️ xAI Voice: ${getVoiceConfig().telegramEnabled ? "on" : "off"}`;
}

function getXaiVoiceMenuRows(ctx: any, config: PiTelegramVoiceConfig): any {
  return {
    inline_keyboard: [
      [
        {
          text: `🔌 xAI Voice: ${config.telegramEnabled ? "on" : "off"}`,
          callback_data: ctx.callbackData("enabled", config.telegramEnabled ? "off" : "on"),
        },
      ],
      [{ text: `🎙️ Voice: ${config.defaultVoice}`, callback_data: ctx.callbackData("voice") }],
      [
        {
          text: `🌐 Language: ${config.defaultLanguage}`,
          callback_data: ctx.callbackData("language"),
        },
      ],
      [{ text: `✨ Style: ${config.speechStyle}`, callback_data: ctx.callbackData("style") }],
      [
        {
          text: `📝 Transcript: ${config.sendTranscript ? "on" : "off"}`,
          callback_data: ctx.callbackData("sendTranscript", config.sendTranscript ? "off" : "on"),
        },
      ],
    ],
  };
}

function getXaiVoiceSectionText(config: PiTelegramVoiceConfig): string {
  const voiceDesc = VOICE_DESCRIPTIONS[config.defaultVoice];
  return `<b>🔊 Voice (x.ai)</b>\n\n<i>Configure xAI text-to-speech and transcription provider settings. Voice reply policy is owned by pi-telegram Settings.</i>\n\nEnabled: <code>${config.telegramEnabled ? "on" : "off"}</code>\nVoice: <code>${config.defaultVoice}</code>${voiceDesc ? ` — <i>${voiceDesc}</i>` : ""}\nLanguage: <code>${config.defaultLanguage}</code>\nStyle: <code>${config.speechStyle}</code>\nTranscript: <code>${config.sendTranscript ? "on" : "off"}</code>`;
}

/**
 * Register a Voice Extension Section in pi-telegram's UI.
 * Provides toggles for TTS voice, language, speech style, and transcript send.
 * Voice reply policy is owned by pi-telegram Settings (not duplicated here).
 * Re-registers on every call — disposes the previous registration first.
 * Skips if the section is already present in pi-telegram's registry.
 */
export async function registerXaiVoiceTelegramSection(
  options: { agentsRoot?: string; startDir?: string } = {},
): Promise<void> {
  let piTelegram: any;
  try {
    piTelegram = await loadPiTelegramSubmodule("extension-sections", options);
  } catch {
    return;
  }
  if (typeof piTelegram.registerTelegramSection !== "function") return;

  let recordEvent: ((category: string, err: unknown, details?: unknown) => void) | undefined;
  try {
    const outbound = await loadPiTelegramSubmodule("outbound-handlers", options);
    if (typeof outbound.recordTelegramRuntimeEvent === "function") {
      recordEvent = outbound.recordTelegramRuntimeEvent;
    }
  } catch {
    // Runtime diagnostics are optional.
  }
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      sectionDisposer?.();
      sectionDisposer = piTelegram.registerTelegramSection({
        id: "pi-xai-voice",
        label: "🎙️ xAI Voice",
        order: 10,
        getLabel: getXaiVoiceSectionLabel,
        render: async (ctx: any) => {
          const config = getVoiceConfig();
          return {
            text: getXaiVoiceSectionText(config),
            replyMarkup: getXaiVoiceMenuRows(ctx, config),
          };
        },
        handleCallback: async (ctx: any) => {
          if (ctx.action === "open") {
            const config = getVoiceConfig();
            await ctx.edit({
              text: getXaiVoiceSectionText(config),
              replyMarkup: getXaiVoiceMenuRows(ctx, config),
            });
            return "handled";
          }
          if (ctx.action === "enabled") {
            const payload = typeof ctx.payload === "string" ? ctx.payload : undefined;
            const current = getVoiceConfig().telegramEnabled;
            const next = payload === "on" || payload === "off" ? payload === "on" : !current;
            setVoiceConfig({ telegramEnabled: next });

            const config = getVoiceConfig();
            await ctx.edit({
              text: getXaiVoiceSectionText(config),
              replyMarkup: getXaiVoiceMenuRows(ctx, config),
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
            await ctx.edit({
              text: getXaiVoiceSectionText(config),
              replyMarkup: getXaiVoiceMenuRows(ctx, config),
            });
            return "handled";
          }
          return "pass";
        },
      });

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
