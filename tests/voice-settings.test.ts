import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveVoicePreferences, type VoicePreferences } from "../voice-settings";

function createPreferences(overrides: Partial<VoicePreferences> = {}): VoicePreferences {
  return {
    voiceId: "eve",
    ttsQuality: "high",
    sttEnabled: true,
    sttLanguage: "auto",
    shortcut: "alt+m",
    shortcutMode: "push-to-talk",
    liveTranscriptEnabled: true,
    liveTranscriptPollingMs: 1000,
    liveTranscriptGhostText: true,
    tagAmount: "moderate",
    speechStyle: "literal",
    defaultLanguage: "auto",
    sendTranscript: false,
    telegramEnabled: true,
    ...overrides,
  };
}

describe("voice settings persistence", () => {
  it("does not persist pi-telegram voice reply policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-xai-voice-settings-"));
    try {
      const path = saveVoicePreferences(cwd, createPreferences(), "project");
      const saved = JSON.parse(await readFile(path, "utf8"));

      expect(saved.xai.voice.replyMode).toBeUndefined();
      expect(saved.xai.voice.telegramEnabled).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
