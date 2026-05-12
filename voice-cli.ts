#!/usr/bin/env -S node --experimental-strip-types

import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { stdin } from "node:process";
import { piVoiceAdapterV1 } from "./voice-adapter.ts";

interface ParsedArgs {
  command?: string;
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { command: rest[0], values, flags };
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "auto") return undefined;
  return trimmed;
}

function usage(): string {
  return `Usage:
  pi-xai-voice-stt --file <path> [--lang <code>]
  pi-xai-voice-tts [--text <text>] [--voice <id>] [--lang <code>] [--write-media <path>] [--format <mp3|ogg>]
  pi-xai-voice stt --file <path> [--lang <code>]
  pi-xai-voice tts [--text <text>] [--voice <id>] [--lang <code>] [--write-media <path>] [--format <mp3|ogg>]

TTS reads stdin when --text is omitted. STT prints transcript text. TTS prints the generated media path unless --write-media is provided, in which case it writes that path and prints it. Use --format ogg to convert output to OGG/Opus via ffmpeg.`;
}

async function readStdin(): Promise<string> {
  let text = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) text += chunk;
  return text;
}

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

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderrData.trim()}`));
    });

    child.on("error", (error) => {
      reject(new Error(`ffmpeg spawn failed: ${error.message}`));
    });
  });
}

async function runStt(args: ParsedArgs): Promise<void> {
  const filePath = args.values.get("file") || args.values.get("path");
  if (!filePath) throw new Error("Missing --file <path>");
  const result = await piVoiceAdapterV1.transcribe({
    filePath,
    language: normalizeOptional(args.values.get("lang") || args.values.get("language")),
  });
  process.stdout.write(result.text.trim() + "\n");
}

async function runTts(args: ParsedArgs): Promise<void> {
  const text = (args.values.get("text") ?? (await readStdin())).trim();
  if (!text) throw new Error("Missing TTS text on --text or stdin");
  const requestedPath = args.values.get("write-media") || args.values.get("out");
  const result = await piVoiceAdapterV1.synthesize({
    text,
    voiceId: normalizeOptional(args.values.get("voice") || args.values.get("voice-id")),
    language: normalizeOptional(args.values.get("lang") || args.values.get("language")),
    fileName: requestedPath,
  });

  let outputPath = result.filePath;

  const format = args.values.get("format");
  if (format === "ogg" || format === "opus") {
    const oggPath = requestedPath
      ? requestedPath.replace(/\.mp3$/i, ".ogg")
      : result.filePath.replace(/\.mp3$/i, ".ogg");
    await runFfmpeg(result.filePath, oggPath);
    await rm(result.filePath, { force: true }).catch(() => undefined);
    outputPath = oggPath;
  }

  if (requestedPath && requestedPath !== outputPath) {
    await mkdir(dirname(requestedPath), { recursive: true });
    await copyFile(outputPath, requestedPath);
    await rm(outputPath, { force: true }).catch(() => undefined);
    process.stdout.write(requestedPath + "\n");
    return;
  }
  process.stdout.write(outputPath + "\n");
}

async function main(): Promise<void> {
  const invoked = process.argv[1]?.split("/").pop() || "pi-xai-voice";
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.has("help") || parsed.flags.has("h")) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const command = invoked.endsWith("-stt")
    ? "stt"
    : invoked.endsWith("-tts")
      ? "tts"
      : parsed.command || "tts";
  if (command === "stt" || command === "transcribe") {
    await runStt(parsed);
    return;
  }
  if (command === "tts" || command === "synthesize") {
    await runTts(parsed);
    return;
  }
  throw new Error(`Unknown command: ${command || "<missing>"}\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
