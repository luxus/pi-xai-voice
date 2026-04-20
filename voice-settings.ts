import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import {
  isKeyRelease,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from "@mariozechner/pi-tui";
import { DEFAULT_XAI_VOICE_ID, XAI_VOICE_IDS, type XaiTtsVoice } from "./xai-voice.ts";

export type VoiceShortcutMode = "push-to-talk" | "toggle";
export type VoiceTtsQuality = "low" | "medium" | "high";
export type VoiceSettingsScope = "project" | "global";
export type VoiceSettingsTab = "tts" | "stt";
export type VoiceSttLanguage = "auto" | "de" | "en" | "fr" | "es" | "it" | "pt" | "nl" | "ja";

export interface VoicePreferences {
  voiceId: string;
  ttsQuality: VoiceTtsQuality;
  sttEnabled: boolean;
  sttLanguage: VoiceSttLanguage;
  shortcut: string;
  shortcutMode: VoiceShortcutMode;
  liveTranscriptEnabled: boolean;
  liveTranscriptPollingMs: number;
  liveTranscriptGhostText: boolean;
}

export const DEFAULT_VOICE_SHORTCUT = "alt+m";
export const DEFAULT_VOICE_SHORTCUT_MODE: VoiceShortcutMode = "push-to-talk";
export const DEFAULT_VOICE_TTS_QUALITY: VoiceTtsQuality = "high";
export const DEFAULT_STT_ENABLED = true;
export const DEFAULT_STT_LANGUAGE: VoiceSttLanguage = "auto";
export const DEFAULT_LIVE_TRANSCRIPT_ENABLED = true;
export const DEFAULT_LIVE_TRANSCRIPT_POLL_MS = 1000;
export const DEFAULT_LIVE_TRANSCRIPT_GHOST_TEXT = true;

export const VOICE_SHORTCUT_MODE_VALUES: VoiceShortcutMode[] = ["push-to-talk", "toggle"];
export const VOICE_TTS_QUALITY_VALUES: VoiceTtsQuality[] = ["low", "medium", "high"];
export const VOICE_STT_LANGUAGE_VALUES: VoiceSttLanguage[] = ["auto", "de", "en", "fr", "es", "it", "pt", "nl", "ja"];
export const VOICE_POLLING_VALUES = [800, 1000, 1200, 1500, 2000] as const;
export const VOICE_ID_VALUES = [...XAI_VOICE_IDS] as string[];

export const TTS_QUALITY_PRESETS: Record<
  VoiceTtsQuality,
  { codec: "mp3"; sampleRate: 22050 | 24000 | 44100; bitRate: 32000 | 64000 | 128000 }
> = {
  low: { codec: "mp3", sampleRate: 22050, bitRate: 32000 },
  medium: { codec: "mp3", sampleRate: 24000, bitRate: 64000 },
  high: { codec: "mp3", sampleRate: 44100, bitRate: 128000 },
};

const PROJECT_SETTINGS_RELATIVE_PATH = ".pi/settings.json";
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi/agent/settings.json");
const SETTINGS_TABS: VoiceSettingsTab[] = ["tts", "stt"];
const PREVIEW_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const PREVIEW_PLAYING_FRAMES = ["▁▂▃▅▇", "▂▃▅▇▆", "▃▅▇▆▃", "▅▇▆▃▂", "▇▆▃▂▁"] as const;

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function isVoiceId(value: string | undefined): value is string {
  return Boolean(value && XAI_VOICE_IDS.has(value));
}

function isShortcutMode(value: string | undefined): value is VoiceShortcutMode {
  return value === "push-to-talk" || value === "toggle";
}

function isTtsQuality(value: string | undefined): value is VoiceTtsQuality {
  return value === "low" || value === "medium" || value === "high";
}

function isSttLanguage(value: string | undefined): value is VoiceSttLanguage {
  return Boolean(value && VOICE_STT_LANGUAGE_VALUES.includes(value as VoiceSttLanguage));
}

export function resolveVoicePreferences(voiceConfig: Record<string, unknown>): VoicePreferences {
  const voiceId = getString(voiceConfig, "defaultVoice");
  const shortcut = getString(voiceConfig, "shortcut");
  const shortcutMode = getString(voiceConfig, "shortcutMode");
  const ttsQuality = getString(voiceConfig, "ttsQuality");
  const sttEnabled = getBoolean(voiceConfig, "sttEnabled");
  const sttLanguage = getString(voiceConfig, "sttLanguage");
  const liveTranscriptEnabled = getBoolean(voiceConfig, "liveTranscriptEnabled");
  const liveTranscriptPollingMs = getNumber(voiceConfig, "liveTranscriptPollingMs");
  const liveTranscriptGhostText = getBoolean(voiceConfig, "liveTranscriptGhostText");

  return {
    voiceId: isVoiceId(voiceId) ? voiceId : DEFAULT_XAI_VOICE_ID,
    ttsQuality: isTtsQuality(ttsQuality) ? ttsQuality : DEFAULT_VOICE_TTS_QUALITY,
    sttEnabled: typeof sttEnabled === "boolean" ? sttEnabled : DEFAULT_STT_ENABLED,
    sttLanguage: isSttLanguage(sttLanguage) ? sttLanguage : DEFAULT_STT_LANGUAGE,
    shortcut: shortcut || DEFAULT_VOICE_SHORTCUT,
    shortcutMode: isShortcutMode(shortcutMode) ? shortcutMode : DEFAULT_VOICE_SHORTCUT_MODE,
    liveTranscriptEnabled:
      typeof liveTranscriptEnabled === "boolean" ? liveTranscriptEnabled : DEFAULT_LIVE_TRANSCRIPT_ENABLED,
    liveTranscriptPollingMs:
      typeof liveTranscriptPollingMs === "number" && liveTranscriptPollingMs >= 200
        ? liveTranscriptPollingMs
        : DEFAULT_LIVE_TRANSCRIPT_POLL_MS,
    liveTranscriptGhostText:
      typeof liveTranscriptGhostText === "boolean"
        ? liveTranscriptGhostText
        : DEFAULT_LIVE_TRANSCRIPT_GHOST_TEXT,
  };
}

export function getProjectSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_SETTINGS_RELATIVE_PATH);
}

export function getGlobalSettingsPath(): string {
  return GLOBAL_SETTINGS_PATH;
}

function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function saveVoicePreferences(
  cwd: string,
  prefs: VoicePreferences,
  scope: VoiceSettingsScope = "project",
): string {
  const path = scope === "global" ? getGlobalSettingsPath() : getProjectSettingsPath(cwd);
  const root = readSettingsFile(path);
  const xai = root.xai && typeof root.xai === "object" ? { ...(root.xai as Record<string, unknown>) } : {};
  const voice = xai.voice && typeof xai.voice === "object" ? { ...(xai.voice as Record<string, unknown>) } : {};

  voice.defaultVoice = prefs.voiceId;
  voice.ttsQuality = prefs.ttsQuality;
  voice.sttEnabled = prefs.sttEnabled;
  if (prefs.sttLanguage === "auto") delete voice.sttLanguage;
  else voice.sttLanguage = prefs.sttLanguage;
  voice.shortcut = prefs.shortcut;
  voice.shortcutMode = prefs.shortcutMode;
  voice.liveTranscriptEnabled = prefs.liveTranscriptEnabled;
  voice.liveTranscriptPollingMs = prefs.liveTranscriptPollingMs;
  voice.liveTranscriptGhostText = prefs.liveTranscriptGhostText;

  xai.voice = voice;
  root.xai = xai;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  return path;
}

function cycleValue<T>(values: readonly T[], current: T, delta: number): T {
  const index = values.indexOf(current);
  const nextIndex = index < 0 ? 0 : (index + delta + values.length) % values.length;
  return values[nextIndex] as T;
}

function toggleBoolean(value: boolean): boolean {
  return !value;
}

function padRight(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return text + " ".repeat(padding);
}

function centerText(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return truncateToWidth(text, width, "…");
  const left = Math.floor((width - visible) / 2);
  const right = Math.max(0, width - visible - left);
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function truncateLine(text: string, width: number): string {
  return visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
}

function isSupportedShortcut(key: string | undefined): key is string {
  if (!key) return false;
  if (key.includes("alt+") || key.includes("ctrl+") || key.includes("super+")) return true;
  return /^f\d{1,2}$/i.test(key);
}

function humanizeVoiceId(voiceId: string): string {
  if (!voiceId.trim()) return DEFAULT_XAI_VOICE_ID;
  return voiceId.charAt(0).toUpperCase() + voiceId.slice(1);
}

function describeVoice(voice: XaiTtsVoice | undefined): string {
  if (!voice) return humanizeVoiceId(DEFAULT_XAI_VOICE_ID);
  const name = voice.name?.trim();
  return name || humanizeVoiceId(voice.voiceId);
}

function tabLabel(theme: Theme, label: string, active: boolean): string {
  if (active) return theme.fg("accent", `◉ ${label}`);
  return theme.fg("dim", `○ ${label}`);
}

type VoiceSettingsRow =
  | "voiceId"
  | "ttsQuality"
  | "playPreview"
  | "sttEnabled"
  | "sttLanguage"
  | "shortcut"
  | "shortcutMode"
  | "liveTranscriptEnabled"
  | "liveTranscriptPollingMs"
  | "liveTranscriptGhostText"
  | "saveProject"
  | "saveGlobal"
  | "cancel";

interface VoiceSettingsDialogResult {
  preferences: VoicePreferences;
  scope: VoiceSettingsScope;
}

export interface VoicePreviewHandle {
  stop(): void;
  closed: Promise<void>;
}

function formatLabel(label: string): string {
  return label
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getVoiceMetadataLines(voice: XaiTtsVoice | undefined): string[] {
  if (!voice) return [];

  const lines: string[] = [`Voice ID: ${voice.voiceId}`];
  if (voice.name?.trim() && voice.name.trim().toLowerCase() !== voice.voiceId.toLowerCase()) {
    lines.push(`Name: ${voice.name.trim()}`);
  }
  if (voice.type) lines.push(`Type: ${voice.type}`);
  if (voice.tone) lines.push(`Tone: ${voice.tone}`);
  if (voice.description) lines.push(`Description: ${voice.description}`);

  const seen = new Set([voice.voiceId.toLowerCase()]);
  if (voice.name?.trim()) seen.add(voice.name.trim().toLowerCase());
  if (voice.tone?.trim()) seen.add(voice.tone.trim().toLowerCase());

  for (const [key, rawValue] of Object.entries(voice.raw)) {
    if (["voice_id", "name", "tone", "description", "preview_url", "sample_url"].includes(key)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") continue;
    const value = String(rawValue).trim();
    if (!value) continue;
    if (seen.has(value.toLowerCase())) continue;
    lines.push(`${formatLabel(key)}: ${value}`);
    if (lines.length >= 4) break;
  }

  if (voice.previewUrl) lines.push(`Preview URL: ${voice.previewUrl}`);
  return lines;
}

class VoiceSettingsDialog implements Focusable {
  focused = false;

  private activeTab: VoiceSettingsTab = "tts";
  private selected = 0;
  private capturingShortcut = false;
  private previewHandle: VoicePreviewHandle | undefined;
  private previewState: "idle" | "loading" | "playing" = "idle";
  private previewStatus: string | undefined;
  private previewAnimationFrame = 0;
  private previewAnimationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly requestRender: () => void,
    private readonly theme: Theme,
    private readonly done: (result: VoiceSettingsDialogResult | undefined) => void,
    private readonly preferences: VoicePreferences,
    private readonly voices: XaiTtsVoice[],
    private readonly onPreview: (voice: XaiTtsVoice) => Promise<VoicePreviewHandle>,
  ) {}

  private getRows(): VoiceSettingsRow[] {
    const tabRows: Record<VoiceSettingsTab, VoiceSettingsRow[]> = {
      tts: ["voiceId", "ttsQuality", "playPreview"],
      stt: [
        "sttEnabled",
        "sttLanguage",
        "shortcut",
        "shortcutMode",
        "liveTranscriptEnabled",
        "liveTranscriptPollingMs",
        "liveTranscriptGhostText",
      ],
    };

    return [...tabRows[this.activeTab], "saveProject", "saveGlobal", "cancel"];
  }

  private getSelectedRow(): VoiceSettingsRow {
    const rows = this.getRows();
    return rows[Math.min(this.selected, rows.length - 1)]!;
  }

  private ensureSelectedInBounds(): void {
    const rows = this.getRows();
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
  }

  private switchTab(delta: number): void {
    this.activeTab = cycleValue(SETTINGS_TABS, this.activeTab, delta);
    this.selected = 0;
    this.capturingShortcut = false;
    this.ensureSelectedInBounds();
  }

  private getVoiceValues(): string[] {
    const values = this.voices.map((voice) => voice.voiceId);
    return values.length ? values : VOICE_ID_VALUES;
  }

  private getSelectedVoice(): XaiTtsVoice | undefined {
    return this.voices.find((voice) => voice.voiceId === this.preferences.voiceId);
  }

  handleInput(data: string): void {
    if (this.capturingShortcut) {
      this.handleShortcutCapture(data);
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.previewState !== "idle") {
        this.stopPreview();
        return;
      }
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "tab")) {
      this.switchTab(1);
      return;
    }

    if (matchesKey(data, "shift+tab")) {
      this.switchTab(-1);
      return;
    }

    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }

    if (matchesKey(data, "down")) {
      this.selected = Math.min(this.getRows().length - 1, this.selected + 1);
      return;
    }

    if (matchesKey(data, "left")) {
      this.adjustSelected(-1);
      return;
    }

    if (matchesKey(data, "right") || matchesKey(data, "space")) {
      this.adjustSelected(1);
      return;
    }

    if (matchesKey(data, "return")) {
      const row = this.getSelectedRow();
      if (row === "playPreview") {
        void this.togglePreview();
        return;
      }
      if (row === "saveProject") {
        this.done({ scope: "project", preferences: { ...this.preferences } });
        return;
      }
      if (row === "saveGlobal") {
        this.done({ scope: "global", preferences: { ...this.preferences } });
        return;
      }
      if (row === "cancel") {
        this.done(undefined);
        return;
      }
      if (row === "shortcut") {
        this.capturingShortcut = true;
        return;
      }
      this.adjustSelected(1);
    }
  }

  private handleShortcutCapture(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) {
      this.capturingShortcut = false;
      return;
    }
    const parsed = parseKey(data);
    if (!isSupportedShortcut(parsed)) return;
    this.preferences.shortcut = parsed;
    this.capturingShortcut = false;
  }

  private stopPreview(): void {
    this.previewHandle?.stop();
    this.previewHandle = undefined;
    this.previewState = "idle";
    this.previewStatus = undefined;
    if (this.previewAnimationTimer) {
      clearInterval(this.previewAnimationTimer);
      this.previewAnimationTimer = undefined;
    }
    this.previewAnimationFrame = 0;
    this.requestRender();
  }

  private startPreviewAnimation(): void {
    if (this.previewAnimationTimer) return;
    this.previewAnimationTimer = setInterval(() => {
      this.previewAnimationFrame += 1;
      this.requestRender();
    }, 120);
  }

  private async togglePreview(): Promise<void> {
    const voice = this.getSelectedVoice();
    if (!voice?.previewUrl) return;

    if (this.previewState !== "idle") {
      this.stopPreview();
      return;
    }

    this.previewState = "loading";
    this.previewStatus = "Loading preview…";
    this.previewAnimationFrame = 0;
    this.startPreviewAnimation();
    this.requestRender();

    try {
      const handle = await this.onPreview(voice);
      this.previewHandle = handle;
      this.previewState = "playing";
      this.previewStatus = "Playing preview… Esc stops";
      this.requestRender();

      void handle.closed.finally(() => {
        if (this.previewHandle !== handle) return;
        this.previewHandle = undefined;
        this.previewState = "idle";
        this.previewStatus = undefined;
        this.requestRender();
      });
    } catch (error) {
      this.previewHandle = undefined;
      this.previewState = "idle";
      this.previewStatus = error instanceof Error ? error.message : String(error);
      this.requestRender();
    }
  }

  private adjustSelected(delta: number): void {
    switch (this.getSelectedRow()) {
      case "voiceId":
        this.preferences.voiceId = cycleValue(this.getVoiceValues(), this.preferences.voiceId, delta);
        return;
      case "ttsQuality":
        this.preferences.ttsQuality = cycleValue(VOICE_TTS_QUALITY_VALUES, this.preferences.ttsQuality, delta);
        return;
      case "playPreview":
        return;
      case "sttEnabled":
        this.preferences.sttEnabled = toggleBoolean(this.preferences.sttEnabled);
        return;
      case "sttLanguage":
        if (!this.preferences.sttEnabled) return;
        this.preferences.sttLanguage = cycleValue(VOICE_STT_LANGUAGE_VALUES, this.preferences.sttLanguage, delta);
        return;
      case "shortcut":
        if (!this.preferences.sttEnabled) return;
        this.capturingShortcut = true;
        return;
      case "shortcutMode":
        if (!this.preferences.sttEnabled) return;
        this.preferences.shortcutMode = cycleValue(
          VOICE_SHORTCUT_MODE_VALUES,
          this.preferences.shortcutMode,
          delta,
        );
        return;
      case "liveTranscriptEnabled":
        if (!this.preferences.sttEnabled) return;
        this.preferences.liveTranscriptEnabled = toggleBoolean(this.preferences.liveTranscriptEnabled);
        return;
      case "liveTranscriptPollingMs":
        if (!this.preferences.sttEnabled || !this.preferences.liveTranscriptEnabled) return;
        this.preferences.liveTranscriptPollingMs = cycleValue(
          VOICE_POLLING_VALUES,
          this.preferences.liveTranscriptPollingMs as (typeof VOICE_POLLING_VALUES)[number],
          delta,
        );
        return;
      case "liveTranscriptGhostText":
        if (!this.preferences.sttEnabled || !this.preferences.liveTranscriptEnabled) return;
        this.preferences.liveTranscriptGhostText = toggleBoolean(this.preferences.liveTranscriptGhostText);
        return;
      default:
        return;
    }
  }

  private renderPreviewHero(innerWidth: number, selectedVoice: XaiTtsVoice | undefined): string[] {
    const th = this.theme;
    if (!selectedVoice?.previewUrl) {
      return [
        th.fg("border", "│") + padRight(` ${th.fg("dim", "No preview sample available for this voice")}`, innerWidth) + th.fg("border", "│"),
      ];
    }

    const isSelected = this.getSelectedRow() === "playPreview";
    const spinner = PREVIEW_LOADING_FRAMES[this.previewAnimationFrame % PREVIEW_LOADING_FRAMES.length] ?? "⠋";
    const wave = PREVIEW_PLAYING_FRAMES[this.previewAnimationFrame % PREVIEW_PLAYING_FRAMES.length] ?? "▁▂▃▅▇";
    const buttonText =
      this.previewState === "loading"
        ? `${spinner} Loading Preview`
        : this.previewState === "playing"
          ? `■ Stop Preview ${wave}`
          : "▶ Play Voice Preview";
    const buttonColor =
      this.previewState === "playing"
        ? "warning"
        : this.previewState === "loading"
          ? "accent"
          : isSelected
            ? "accent"
            : "success";
    const hint = this.previewStatus || "Enter plays sample • Esc stops • dialog stays open";

    return [
      th.fg("border", "│") + padRight("", innerWidth) + th.fg("border", "│"),
      th.fg("border", "│") + th.fg(buttonColor, centerText(buttonText, innerWidth)) + th.fg("border", "│"),
      th.fg("border", "│") + padRight(` ${th.fg("dim", truncateToWidth(hint, innerWidth - 1, "…"))}`, innerWidth) + th.fg("border", "│"),
      th.fg("border", "│") + padRight("", innerWidth) + th.fg("border", "│"),
    ];
  }

  render(width: number): string[] {
    const panelWidth = Math.max(68, Math.min(width - 4, 92));
    const innerWidth = panelWidth - 2;
    const lines: string[] = [];
    const th = this.theme;
    const selectedVoice = this.getSelectedVoice();
    const selectedVoiceLabel = describeVoice(selectedVoice);
    const rows = this.getRows();

    const row = (content: string) =>
      th.fg("border", "│") + padRight(truncateLine(content, innerWidth), innerWidth) + th.fg("border", "│");

    const renderValue = (value: string, enabled = true, selected = false): string => {
      if (!enabled) return th.fg("dim", value);
      return selected ? th.fg("success", value) : th.fg("text", value);
    };

    const renderRow = (index: number, label: string, value: string, hint?: string, enabled = true): void => {
      const selected = index === this.selected;
      const prefix = selected ? th.fg("accent", "▶") : th.fg("dim", " ");
      const labelText = enabled
        ? selected
          ? th.fg("accent", label)
          : th.fg("text", label)
        : th.fg("dim", label);
      lines.push(row(` ${prefix} ${labelText}: ${renderValue(value, enabled, selected)}`));
      if (hint) lines.push(row(`   ${th.fg("dim", hint)}`));
    };

    lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(row(` ${th.fg("accent", "xAI Voice Settings")}`));
    lines.push(
      row(
        ` ${tabLabel(th, "TTS", this.activeTab === "tts")}  ${tabLabel(th, "STT", this.activeTab === "stt")}  ${th.fg("dim", "Tab switch section • ↑↓ select • ←→ change • Enter edit/save")}`,
      ),
    );
    lines.push(row(""));

    let rowIndex = 0;
    for (const rowId of rows) {
      switch (rowId) {
        case "voiceId":
          renderRow(rowIndex, "TTS voice", selectedVoiceLabel);
          break;
        case "ttsQuality":
          renderRow(rowIndex, "TTS quality", this.preferences.ttsQuality);
          break;
        case "playPreview":
          renderRow(
            rowIndex,
            "Voice preview",
            !selectedVoice?.previewUrl
              ? "not available"
              : this.previewState === "playing"
                ? "■ stop preview"
                : this.previewState === "loading"
                  ? "… loading preview"
                  : "▶ play preview",
            selectedVoice?.previewUrl
              ? this.previewStatus || "Plays without closing dialog"
              : "No preview URL for this voice",
            Boolean(selectedVoice?.previewUrl),
          );
          break;
        case "sttEnabled":
          renderRow(
            rowIndex,
            "Speech-to-text",
            this.preferences.sttEnabled ? "on" : "off",
            this.preferences.sttEnabled ? "Shortcut active" : "Off = cheaper + shortcut released",
          );
          break;
        case "sttLanguage":
          renderRow(
            rowIndex,
            "Language hint",
            this.preferences.sttLanguage,
            this.preferences.sttLanguage === "auto"
              ? "Default. xAI auto-detects input language"
              : "Force STT toward one language when auto guesses wrong",
            this.preferences.sttEnabled,
          );
          break;
        case "shortcut":
          renderRow(
            rowIndex,
            "Shortcut",
            this.capturingShortcut ? "press new key…" : this.preferences.shortcut,
            "Alt/Ctrl/Super or F-keys",
            this.preferences.sttEnabled,
          );
          break;
        case "shortcutMode":
          renderRow(
            rowIndex,
            "Shortcut mode",
            this.preferences.shortcutMode,
            undefined,
            this.preferences.sttEnabled,
          );
          break;
        case "liveTranscriptEnabled":
          renderRow(
            rowIndex,
            "Live text preview",
            this.preferences.liveTranscriptEnabled ? "on" : "off",
            this.preferences.liveTranscriptEnabled ? "Text appears while speaking" : "Off = cheaper final-only STT",
            this.preferences.sttEnabled,
          );
          break;
        case "liveTranscriptPollingMs":
          renderRow(
            rowIndex,
            "Live polling",
            `${this.preferences.liveTranscriptPollingMs} ms`,
            "Faster = pricier, 1000ms good middle ground",
            this.preferences.sttEnabled && this.preferences.liveTranscriptEnabled,
          );
          break;
        case "liveTranscriptGhostText":
          renderRow(
            rowIndex,
            "Ghost text",
            this.preferences.liveTranscriptGhostText ? "on" : "off",
            "Animated gray preview inside editor",
            this.preferences.sttEnabled && this.preferences.liveTranscriptEnabled,
          );
          break;
        case "saveProject":
          renderRow(rowIndex, "Save project", ".pi/settings.json");
          break;
        case "saveGlobal":
          renderRow(rowIndex, "Save global", "~/.pi/agent/settings.json");
          break;
        case "cancel":
          renderRow(rowIndex, "Cancel", "close without saving");
          break;
      }
      rowIndex += 1;
    }

    const preset = TTS_QUALITY_PRESETS[this.preferences.ttsQuality];
    const metadataLines = getVoiceMetadataLines(selectedVoice);
    lines.push(row(""));
    if (this.activeTab === "tts") {
      lines.push(row(` ${th.fg("accent", "Selected voice")}: ${th.fg("text", selectedVoiceLabel)}`));
      lines.push(...this.renderPreviewHero(innerWidth, selectedVoice));
      for (const line of metadataLines) {
        lines.push(row(` ${th.fg("dim", line)}`));
      }
      lines.push(
        row(
          ` ${th.fg("dim", `Preset: ${preset.codec} ${preset.sampleRate}Hz ${preset.bitRate / 1000}kbps`)}`,
        ),
      );
    } else {
      lines.push(row(` ${th.fg("dim", "Hint: live preview polls STT repeatedly; final-only mode is cheaper.")}`));
      lines.push(row(` ${th.fg("dim", "Language hint: auto is default; force only when detection drifts.")}`));
      if (!this.preferences.sttEnabled) {
        lines.push(row(` ${th.fg("dim", "When STT is off, shortcut is no longer intercepted by this extension.")}`));
      }
    }
    lines.push(th.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {
    this.stopPreview();
  }
}

export async function openVoiceSettingsDialog(
  ctx: ExtensionCommandContext,
  current: VoicePreferences,
  voices: XaiTtsVoice[],
  onPreview: (voice: XaiTtsVoice) => Promise<VoicePreviewHandle>,
): Promise<VoiceSettingsDialogResult | undefined> {
  const result = await ctx.ui.custom<VoiceSettingsDialogResult | undefined>(
    (tui, theme, _keybindings, done) => new VoiceSettingsDialog(() => tui.requestRender(), theme, done, { ...current }, voices, onPreview),
    {
      overlay: true,
      overlayOptions: {
        width: 92,
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
      },
    },
  );
  return result;
}
