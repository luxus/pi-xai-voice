/**
 * Manual test script: Check if the current credential (preferably from main pi-xai Grok Build OAuth)
 * can actually call the xAI Voice endpoints (/tts/voices and /tts).
 *
 * Run with:
 *   npx tsx scripts/test-voice-oauth.ts
 *   or
 *   bun run scripts/test-voice-oauth.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getRequiredXaiApiKey } from "../xai-config.ts";

import { XAI_API_BASE } from "../xai-media-shared.ts"; // for the base URL

const TTS_VOICES_ENDPOINT = "/tts/voices";
const TTS_ENDPOINT = "/tts";

async function main() {
  console.log("=== xAI Voice OAuth / Credential Test ===\n");

  let apiKey: string;
  let source: string;

  try {
    const result = await getRequiredXaiApiKey();
    apiKey = result.apiKey;
    source = result.source;
    console.log(`✅ Credential source: ${source}`);
    console.log(`   Key prefix: ${apiKey.slice(0, 12)}...`);
  } catch (err: any) {
    console.error("❌ Failed to obtain API key:", err.message);
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // 1. Test listing voices (lightweight)
  console.log("\n→ Testing GET /tts/voices ...");
  try {
    const res = await fetch(`${XAI_API_BASE}${TTS_VOICES_ENDPOINT}`, {
      method: "GET",
      headers,
    });

    console.log(`   Status: ${res.status} ${res.statusText}`);

    if (res.ok) {
      const data = await res.json();
      // xAI /tts/voices returns { voices: [...] }
      const voices = Array.isArray(data) ? data : (data.voices ?? data.data ?? []);
      console.log("   ✅ /tts/voices succeeded!");
      console.log(`   Voices returned: ${voices.length}`);
      if (voices.length > 0) {
        const ids = voices
          .slice(0, 5)
          .map((v: any) => v.voice_id || v.id || v.name)
          .filter(Boolean);
        if (ids.length) console.log(`   Example voices: ${ids.join(", ")}`);
      }
    } else {
      const text = await res.text().catch(() => "");
      console.log("   ❌ /tts/voices failed:");
      console.log("   ", text.slice(0, 500));
    }
  } catch (err: any) {
    console.log("   ❌ Network error calling /tts/voices:", err.message);
  }

  // 2. Small TTS test
  console.log("\n→ Testing small TTS request (/tts) ...");
  try {
    const ttsBody = {
      text: "Hello, this is a short test of the xAI voice API using the current credential.",
      voice_id: "eve", // safe default
      language: "en", // ← required by the xAI /tts endpoint
      output_format: {
        codec: "mp3",
        sample_rate: 24000,
      },
    };

    const res = await fetch(`${XAI_API_BASE}${TTS_ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify(ttsBody),
    });

    console.log(`   Status: ${res.status} ${res.statusText}`);

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to a temp file so we can verify it
      const tempDir = join(tmpdir(), "pi-xai-voice-test");
      mkdirSync(tempDir, { recursive: true });
      const outPath = join(tempDir, `test-voice-${Date.now()}.mp3`);
      writeFileSync(outPath, buffer);

      console.log("   ✅ TTS request succeeded!");
      console.log(`   Audio saved to: ${outPath}`);
      console.log(`   Size: ${(buffer.length / 1024).toFixed(1)} KB`);
    } else {
      const text = await res.text().catch(() => "");
      console.log("   ❌ TTS request failed:");
      console.log("   ", text.slice(0, 800));
    }
  } catch (err: any) {
    console.log("   ❌ Network error during TTS test:", err.message);
  }

  console.log("\n=== Test finished ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
