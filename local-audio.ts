import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XaiMediaLogger } from "./xai-media-shared.ts";

const LOCAL_AUDIO_TEMP_DIR = join(tmpdir(), "pi-xai-voice", "local-audio");

export interface LocalRecording {
  child: ChildProcess;
  filePath: string;
  startedAt: number;
  microphoneDeviceIndex: number;
  sampleRate: number;
  channels: number;
  chunks: Buffer[];
  sizeBytes: number;
  stopPromise?: Promise<{ filePath: string; durationMs: number }>;
}

function pcm16ToWavBuffer(pcmBytes: Uint8Array, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBytes.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBytes.byteLength, 40);

  return Buffer.concat([header, Buffer.from(pcmBytes)]);
}

function getRecordingPcmBytes(recording: LocalRecording): Buffer {
  if (!recording.chunks.length || recording.sizeBytes <= 0) return Buffer.alloc(0);
  return Buffer.concat(recording.chunks, recording.sizeBytes);
}

export function createMicrophoneRecordingSnapshot(
  recording: LocalRecording,
  filePath = createLocalAudioTempPath("mic-live", ".wav"),
): string | undefined {
  const pcmBytes = getRecordingPcmBytes(recording);
  if (!pcmBytes.length) return undefined;
  writeFileSync(filePath, pcm16ToWavBuffer(pcmBytes, recording.sampleRate, recording.channels));
  return filePath;
}

function ensureTempDir(): string {
  if (!existsSync(LOCAL_AUDIO_TEMP_DIR)) {
    mkdirSync(LOCAL_AUDIO_TEMP_DIR, { recursive: true });
  }
  return LOCAL_AUDIO_TEMP_DIR;
}

export function createLocalAudioTempPath(prefix: string, extension: string): string {
  const dir = ensureTempDir();
  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]+/g, "-") || "audio";
  const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const random = Math.random().toString(36).slice(2, 8);
  return join(dir, `${safePrefix}-${Date.now()}-${random}${safeExtension}`);
}

export async function startMicrophoneRecording(options: {
  filePath?: string;
  microphoneDeviceIndex?: number;
  sampleRate?: number;
  channels?: number;
  log?: XaiMediaLogger;
}): Promise<LocalRecording> {
  if (process.platform !== "darwin") {
    throw new Error("Microphone recording shortcut currently supports macOS only.");
  }

  const filePath = options.filePath || createLocalAudioTempPath("mic", ".wav");
  const microphoneDeviceIndex = options.microphoneDeviceIndex ?? 0;
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-i",
    `:${microphoneDeviceIndex}`,
    "-ac",
    String(channels),
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ];

  options.log?.info?.(
    `[xai-voice] starting mic capture ffmpeg device=${microphoneDeviceIndex} sampleRate=${sampleRate}`,
  );
  const child = spawn("ffmpeg", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  const recording: LocalRecording = {
    child,
    filePath,
    startedAt: Date.now(),
    microphoneDeviceIndex,
    sampleRate,
    channels,
    chunks,
    sizeBytes: 0,
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    recording.sizeBytes += buffer.byteLength;
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      resolve();
    }, 250);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onError = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(
        new Error(
          `ffmpeg exited before recording started (code=${String(code)} signal=${String(signal)}): ${stderr.trim()}`,
        ),
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);
  });

  return recording;
}

export async function stopMicrophoneRecording(recording: LocalRecording): Promise<{
  filePath: string;
  durationMs: number;
}> {
  if (recording.stopPromise) return recording.stopPromise;

  recording.stopPromise = new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";

    recording.child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      writeFileSync(
        recording.filePath,
        pcm16ToWavBuffer(getRecordingPcmBytes(recording), recording.sampleRate, recording.channels),
      );
      resolve({
        filePath: recording.filePath,
        durationMs: Math.max(0, Date.now() - recording.startedAt),
      });
    };

    const closeTimer = setTimeout(() => {
      recording.child.kill("SIGINT");
    }, 2_000);

    recording.child.once("error", (error) => {
      clearTimeout(closeTimer);
      fail(error);
    });

    recording.child.once("close", (code, signal) => {
      clearTimeout(closeTimer);
      if (code === 0) {
        finish();
        return;
      }
      if (signal === "SIGINT") {
        finish();
        return;
      }
      fail(
        new Error(
          `ffmpeg recording stop failed (code=${String(code)} signal=${String(signal)}): ${stderr.trim()}`,
        ),
      );
    });

    try {
      if (recording.child.stdin && !recording.child.stdin.destroyed) {
        recording.child.stdin.write("q");
        recording.child.stdin.end();
      } else {
        recording.child.kill("SIGINT");
      }
    } catch (error) {
      fail(error);
    }
  });

  return recording.stopPromise;
}

export async function startAudioPlayback(
  filePath: string,
  log?: XaiMediaLogger,
): Promise<ChildProcess> {
  const command = process.platform === "darwin" ? "afplay" : "ffplay";
  const args = process.platform === "darwin" ? [filePath] : ["-nodisp", "-autoexit", "-loglevel", "error", filePath];
  log?.info?.(`[xai-voice] starting playback ${command} ${filePath}`);
  const child = spawn(command, args, {
    stdio: ["ignore", "ignore", "ignore"],
  });

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      resolve();
    }, 100);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
    };

    const onError = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    child.once("error", onError);
  });

  return child;
}

export function stopAudioPlayback(playback: ChildProcess | undefined): void {
  if (!playback || playback.killed) return;
  try {
    playback.kill("SIGTERM");
  } catch (e) {
    void e;
  }
}
