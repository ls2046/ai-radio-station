import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createToneWav } from "./audio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
const generatedDir = path.join(rootDir, "audio", "generated");

function normalizeApiBase(url) {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");
}

export async function synthesizeHostVoice({ text, slotId = "host-intro" }) {
  const provider = (process.env.AI_TTS_PROVIDER ?? "minimax").toLowerCase();

  // Try ByteDance OpenSpeech if configured
  if ((provider === "bytedance" || provider === "volcengine") && process.env.BYTEDANCE_TTS_APP_ID && process.env.BYTEDANCE_TTS_ACCESS_KEY) {
    try {
      const result = await synthesizeByteDanceVoice({ text, slotId });
      return result;
    } catch (error) {
      console.warn("ByteDance TTS failed, trying fallback.", error);
    }
  }

  // Try MiniMax first if configured
  if (provider === "minimax" && process.env.MINIMAX_API_KEY) {
    try {
      const result = await synthesizeMiniMaxVoice({ text, slotId });
      return result;
    } catch (error) {
      console.warn("MiniMax TTS failed, trying fallback.", error);
    }
  }

  // Try Edge TTS (browser-based TTS via API)
  if (provider === "edge") {
    try {
      const result = await synthesizeEdgeVoice({ text, slotId });
      return result;
    } catch (error) {
      console.warn("Edge TTS failed, using mock tone.", error);
    }
  }

  // Final fallback: mock tone
  return getMockHostVoice(text, slotId);
}

async function readJsonLines(stream, onLine) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await onLine(JSON.parse(trimmed));
    }
  }

  const tail = buffer.trim();
  if (tail) {
    await onLine(JSON.parse(tail));
  }
}

// ========== ByteDance OpenSpeech TTS ==========
async function synthesizeByteDanceVoice({ text, slotId }) {
  await fs.mkdir(generatedDir, { recursive: true });

  const safeSlotId = slotId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 72);
  const baseUrl = (process.env.BYTEDANCE_TTS_URL ?? "https://openspeech.bytedance.com/api/v3/tts/unidirectional").trim();
  const apiKey = process.env.BYTEDANCE_TTS_API_KEY ?? "";
  const appId = process.env.BYTEDANCE_TTS_APP_ID ?? "";
  const accessKey = process.env.BYTEDANCE_TTS_ACCESS_KEY ?? "";
  const resourceId = process.env.BYTEDANCE_TTS_RESOURCE_ID ?? "";
  const speaker = process.env.BYTEDANCE_TTS_SPEAKER ?? "zh_female_cancan_mars_bigtts";
  const audioFormat = (process.env.BYTEDANCE_TTS_FORMAT || "mp3").toLowerCase() === "wav" ? "wav" : "mp3";
  const sampleRate = Number(process.env.BYTEDANCE_TTS_SAMPLE_RATE ?? 24000);
  const enableTimestamp = String(process.env.BYTEDANCE_TTS_ENABLE_TIMESTAMP ?? "true").toLowerCase() === "true";
  const explicitLanguage = process.env.BYTEDANCE_TTS_LANGUAGE || "zh";
  const model = process.env.BYTEDANCE_TTS_MODEL || "";
  const speechRate = Number(process.env.BYTEDANCE_TTS_SPEECH_RATE ?? 0);
  const loudnessRate = Number(process.env.BYTEDANCE_TTS_LOUDNESS_RATE ?? 0);
  const emotion = process.env.BYTEDANCE_TTS_EMOTION || "";
  const emotionScale = process.env.BYTEDANCE_TTS_EMOTION_SCALE ? Number(process.env.BYTEDANCE_TTS_EMOTION_SCALE) : null;
  const requestId = crypto.randomUUID();

  const cacheKey = [
    "bytedance-v1",
    apiKey ? "api-key" : "legacy-auth",
    speaker,
    model,
    audioFormat,
    sampleRate,
    enableTimestamp ? "1" : "0",
    explicitLanguage,
    text
  ].join("|");
  const hash = crypto.createHash("sha1").update(cacheKey).digest("hex").slice(0, 10);
  const filename = `${safeSlotId}-${hash}.${audioFormat}`;
  const filePath = path.join(generatedDir, filename);

  try {
    await fs.access(filePath);
    return {
      audioUrl: `/api/audio/generated/${encodeURIComponent(filename)}`,
      text,
      source: "bytedance",
      cached: true
    };
  } catch {
    // continue to synthesize
  }

  const additions = JSON.stringify({
    explicit_language: explicitLanguage,
    disable_markdown_filter: true,
    enable_timestamp: enableTimestamp
  });

  const headers = apiKey
    ? {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": requestId,
        "Content-Type": "application/json",
        "Connection": "keep-alive"
      }
    : {
        "X-Api-App-Id": appId,
        "X-Api-Access-Key": accessKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": requestId,
        "Content-Type": "application/json",
        "Connection": "keep-alive"
      };

  const audioParams = {
    format: audioFormat,
    sample_rate: sampleRate,
    enable_timestamp: enableTimestamp
  };
  if (Number.isFinite(speechRate) && speechRate !== 0) {
    audioParams.speech_rate = speechRate;
  }
  if (Number.isFinite(loudnessRate) && loudnessRate !== 0) {
    audioParams.loudness_rate = loudnessRate;
  }
  if (emotion) {
    audioParams.emotion = emotion;
  }
  if (emotionScale !== null && Number.isFinite(emotionScale)) {
    audioParams.emotion_scale = emotionScale;
  }

  const reqParams = {
    text,
    speaker,
    audio_params: audioParams,
    additions
  };
  if (model) {
    reqParams.model = model;
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user: {
        uid: safeSlotId || `uid-${Date.now()}`
      },
      req_params: reqParams
    })
  });

  if (!response.ok) {
    throw new Error(`ByteDance TTS request failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("ByteDance TTS returned no response body.");
  }

  const audioData = [];
  let totalBytes = 0;
  let apiError = null;
  let apiDone = false;

  await readJsonLines(response.body, async (data) => {
    const code = Number(data?.code ?? 0);
    if (code === 0 && data?.data) {
      const chunk = Buffer.from(String(data.data), "base64");
      totalBytes += chunk.length;
      audioData.push(chunk);
      return;
    }
    if (code === 0 && data?.sentence) {
      return;
    }
    if (code === 20000000) {
      apiDone = true;
      return;
    }
    if (code > 0) {
      apiError = data;
    }
  });

  if (apiError) {
    throw new Error(`ByteDance TTS failed: ${apiError.message || apiError.msg || JSON.stringify(apiError)}`);
  }
  if (!apiDone || totalBytes === 0) {
    throw new Error("ByteDance TTS returned no audio data.");
  }

  await fs.writeFile(filePath, Buffer.concat(audioData));

  return {
    audioUrl: `/api/audio/generated/${encodeURIComponent(filename)}`,
    text,
    source: "bytedance",
    cached: false
  };
}

// ========== MiniMax TTS ==========
async function synthesizeMiniMaxVoice({ text, slotId }) {
  await fs.mkdir(generatedDir, { recursive: true });

  const safeSlotId = slotId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 72);
  const voiceId = process.env.MINIMAX_VOICE_ID ?? "Chinese (Mandarin)_Warm-HeartedAunt";
  const model = process.env.MINIMAX_TTS_MODEL ?? "speech-2.8-hd";
  const baseUrl = normalizeApiBase(process.env.MINIMAX_TTS_BASE_URL ?? process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com");
  const languageBoost = process.env.MINIMAX_TTS_LANGUAGE || "Chinese";
  const outputFormat = (process.env.MINIMAX_TTS_FORMAT || "mp3").toLowerCase();
  const audioFormat = outputFormat === "wav" ? "wav" : "mp3";

  const cacheKey = [
    "minimax-v1",
    voiceId,
    model,
    audioFormat,
    process.env.MINIMAX_VOICE_SPEED ?? "",
    process.env.MINIMAX_VOICE_PITCH ?? "",
    process.env.MINIMAX_VOICE_VOLUME ?? "",
    text
  ].join("|");
  const hash = crypto.createHash("sha1").update(cacheKey).digest("hex").slice(0, 10);
  const filename = `${safeSlotId}-${hash}.${audioFormat}`;
  const filePath = path.join(generatedDir, filename);

  try {
    await fs.access(filePath);
    return {
      audioUrl: `/api/audio/generated/${encodeURIComponent(filename)}`,
      text,
      source: "minimax",
      cached: true
    };
  } catch {
    // File doesn't exist, generate it
  }

  const requestPayload = {
    model,
    text,
    stream: false,
    language_boost: languageBoost,
    output_format: "hex",
    voice_setting: {
      voice_id: voiceId,
      speed: Number(process.env.MINIMAX_VOICE_SPEED ?? 1),
      vol: Number(process.env.MINIMAX_VOICE_VOLUME ?? 1),
      pitch: Number(process.env.MINIMAX_VOICE_PITCH ?? 0)
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: audioFormat,
      channel: 1
    }
  };

  const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });

  if (!response.ok) {
    throw new Error(`MiniMax TTS request failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax TTS failed: ${data.base_resp?.status_msg ?? "unknown error"}`);
  }

  const audioHex = data.data?.audio;
  if (!audioHex) {
    throw new Error("MiniMax TTS returned no audio data.");
  }

  const buffer = Buffer.from(audioHex, "hex");
  await fs.writeFile(filePath, buffer);

  return {
    audioUrl: `/api/audio/generated/${encodeURIComponent(filename)}`,
    text,
    source: "minimax",
    cached: false
  };
}

// ========== Edge TTS (Mock - would need edge-tts package) ==========
async function synthesizeEdgeVoice({ text, slotId }) {
  // Edge TTS would require the edge-tts npm package
  // For now, throw to use fallback
  throw new Error("Edge TTS not implemented. Install edge-tts package to use.");
}

// ========== Mock Host Voice ==========
export function getMockHostVoice(text, slotId = "host-intro") {
  // Generate a unique tone based on text hash
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
  const hashNum = parseInt(hash, 16);

  const frequencies = [
    196.00, 220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00
  ];
  const secondaryFreqs = [
    293.66, 330.00, 370.00, 392.00, 440.00, 493.88, 523.25, 587.33
  ];

  const freqIndex = hashNum % frequencies.length;
  const duration = 2.5 + (hashNum % 4) * 0.5; // 2.5 - 4.0 seconds

  const tone = createToneWav({
    durationSeconds: duration,
    frequency: frequencies[freqIndex],
    secondaryFrequency: secondaryFreqs[freqIndex],
    volume: 0.25,
    pulse: true
  });

  const safeSlotId = slotId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 72);
  const filename = `${safeSlotId}-mock-${hash}.wav`;
  const filePath = path.join(generatedDir, filename);

  // Write sync for simplicity in mock mode
  fs.writeFile(filePath, tone).catch(() => {});

  return {
    audioUrl: `/api/audio/generated/${encodeURIComponent(filename)}`,
    text,
    source: "mock-tone",
    fallback: true,
    note: "Using generated tone as TTS fallback. Configure MiniMax API key for real voice."
  };
}
