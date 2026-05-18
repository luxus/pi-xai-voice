import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPiTelegramBridge,
  registerXaiVoiceTelegramHandler,
  registerXaiVoiceTelegramSection,
} from "../voice-telegram-bus";

describe("loadPiTelegramBridge - sibling resolution", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-agents-test-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("finds sibling pi-telegram in ~/.pi/agents/git/github.com/luxus/ layout", async () => {
    const agentsRoot = join(tempRoot, "agents", "git", "github.com", "luxus");
    const telegramDir = join(agentsRoot, "pi-telegram");

    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(telegramDir, { recursive: true }).then(() =>
        writeFile(
          join(telegramDir, "index.ts"),
          `
            export function registerTelegramVoiceSynthesisProvider() {}
            export function registerTelegramSection() {}
            export async function importPiTelegram() { return import('./index.ts'); }
          `,
        ),
      ),
    );

    const bridge = await loadPiTelegramBridge({ agentsRoot });

    expect(bridge).toBeDefined();
    expect(typeof bridge.registerTelegramVoiceSynthesisProvider).toBe("function");
    expect(typeof bridge.registerTelegramSection).toBe("function");
  });

  it("falls back to normal package resolution when no sibling pi-telegram exists", async () => {
    const agentsRoot = join(tempRoot, "agents", "git", "github.com", "luxus");

    // When no sibling is present, it should still succeed via normal package resolution
    // (in this test environment it may resolve to a workspace version)
    const bridge = await loadPiTelegramBridge({ agentsRoot });

    expect(bridge).toBeDefined();
  });

  it("registerXaiVoiceTelegramHandler uses the loader and succeeds when a sibling is present", async () => {
    const agentsRoot = join(tempRoot, "agents", "git", "github.com", "luxus");
    const telegramDir = join(agentsRoot, "pi-telegram");

    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(telegramDir, { recursive: true }).then(() =>
        mkdir(join(telegramDir, "lib"), { recursive: true }).then(() =>
          writeFile(
            join(telegramDir, "lib", "voice.ts"),
            `
              export function registerTelegramVoiceSynthesisProvider(fn: any, opts: any) {
                // no-op stub for test
              }
              export function registerTelegramVoiceTranscriptionProvider(fn: any, opts: any) {
                // no-op stub for test
              }
            `,
          ),
        ),
      ),
    );

    // Should not early-return due to import failure; now exercises submodule("voice") via agentsRoot/lib/voice.ts
    await expect(registerXaiVoiceTelegramHandler({ agentsRoot })).resolves.not.toThrow();
  });

  it("registerXaiVoiceTelegramSection uses the loader and succeeds when a sibling is present", async () => {
    const agentsRoot = join(tempRoot, "agents", "git", "github.com", "luxus");
    const telegramDir = join(agentsRoot, "pi-telegram");

    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(telegramDir, { recursive: true });
      await mkdir(join(telegramDir, "lib"), { recursive: true });
      await writeFile(
        join(telegramDir, "lib", "extension-sections.ts"),
        `
          export function registerTelegramSection() {}
          export function getTelegramSectionDiagnostics() { return []; }
        `,
      );
    });

    await expect(registerXaiVoiceTelegramSection({ agentsRoot })).resolves.not.toThrow();
  });

  it("auto-discovers sibling pi-telegram by walking up when no agentsRoot is provided", async () => {
    const luxusRoot = join(tempRoot, ".pi", "agents", "git", "github.com", "luxus");
    const telegramDir = join(luxusRoot, "pi-telegram");
    const deepVoiceDir = join(luxusRoot, "pi-xai-voice", "lib", "some", "nested", "dir");

    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(telegramDir, { recursive: true });
      await mkdir(deepVoiceDir, { recursive: true });

      await writeFile(
        join(telegramDir, "index.ts"),
        `
          export function registerTelegramVoiceSynthesisProvider() {}
          export function registerTelegramSection() {}
          export async function importPiTelegram() { return import('./index.ts'); }
        `,
      );
      await writeFile(join(deepVoiceDir, "dummy.ts"), "// test file");
    });

    const bridge = await loadPiTelegramBridge({ startDir: deepVoiceDir });

    expect(bridge).toBeDefined();
    expect(typeof bridge.registerTelegramVoiceSynthesisProvider).toBe("function");
  });

  it("robustly finds sibling using package.json walk even from very deep paths", async () => {
    // Simulate the real ~/.pi/agents layout but deep inside the voice package
    const base = join(tempRoot, ".pi", "agents", "git", "github.com", "luxus");
    const telegramDir = join(base, "pi-telegram");
    const veryDeep = join(base, "pi-xai-voice", "dist", "lib", "internal", "voice", "bus");

    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(telegramDir, { recursive: true });
      await mkdir(veryDeep, { recursive: true });

      await writeFile(
        join(telegramDir, "package.json"),
        JSON.stringify({ name: "@llblab/pi-telegram" }),
      );
      await writeFile(
        join(telegramDir, "index.ts"),
        `
          export function registerTelegramVoiceSynthesisProvider() {}
          export function registerTelegramSection() {}
        `,
      );

      await writeFile(join(veryDeep, "some-file.ts"), "// deep");
    });

    const bridge = await loadPiTelegramBridge({ startDir: veryDeep });

    expect(bridge).toBeDefined();
    expect(typeof bridge.registerTelegramVoiceSynthesisProvider).toBe("function");
  });
});
