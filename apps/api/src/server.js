import Fastify from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatReply, analyzeConversation, createHostIntroCopy, createProactiveHostTopic, createHostResponse } from "./chat.js";
import { getMiniMaxLogById, listMiniMaxLogs } from "./minimax-log-store.js";
import {
  generatePlaylist,
  getOpeningPlaylist,
  getPlaylist,
  getPlaylistHistoryDetail,
  getPlaylistHistoryList,
  getRecentPreferenceTags,
  recordListenerEvent,
  schedulePendingSunoAudioCache
} from "./playlist.js";
import { synthesizeHostVoice, getMockHostVoice } from "./tts.js";
import { createToneWav } from "./audio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
const generatedAudioDir = path.join(rootDir, "audio", "generated");

loadLocalEnv(path.join(rootDir, ".env"));

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

// Ensure audio directory exists
fs.mkdirSync(generatedAudioDir, { recursive: true });

export const app = Fastify({ logger: true });

// CORS
app.addHook("onRequest", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") return reply.code(204).send();
});

// ========== Health ==========
app.get("/health", async () => ({ ok: true, service: "ai-radio-station-api" }));

// ========== AI Chat ==========
app.post("/api/chat", async (request, reply) => {
  const body = request.body ?? {};
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const history = Array.isArray(body.history) ? body.history : [];

  if (!message) {
    return reply.code(400).send({ error: "Message is required" });
  }

  try {
    const result = await createChatReply({
      message,
      history,
      llmLogMeta: {
        entrypoint: "chat",
        triggerSource: "chat_message"
      }
    });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Chat failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Chat failed" });
  }
});

// ========== AI Analysis ==========
app.post("/api/chat/analyze", async (request, reply) => {
  const body = request.body ?? {};
  const history = Array.isArray(body.history) ? body.history : [];

  if (history.length === 0) {
    return reply.code(400).send({ error: "History is required for analysis" });
  }

  try {
    const result = await analyzeConversation(history, {
      llmLogMeta: {
        entrypoint: "chat_analyze",
        triggerSource: "conversation_analysis"
      }
    });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Analysis failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Analysis failed" });
  }
});

app.post("/api/host/respond", async (request, reply) => {
  const body = request.body ?? {};

  try {
    const result = await createHostResponse({
      sessionId: typeof body.sessionId === "string" ? body.sessionId : "default",
      event: typeof body.event === "string" ? body.event : "",
      context: body.context && typeof body.context === "object" ? body.context : {},
      allowedActions: Array.isArray(body.allowedActions) ? body.allowedActions : [],
      llmLogMeta: {
        entrypoint: "host_respond"
      }
    });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Host response generation failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Host response generation failed" });
  }
});

app.get("/api/debug/minimax-logs", async (request, reply) => {
  const query = request.query && typeof request.query === "object" ? request.query : {};

  try {
    const records = listMiniMaxLogs({
      entrypoint: typeof query.entrypoint === "string" ? query.entrypoint : "",
      triggerSource: typeof query.trigger_source === "string" ? query.trigger_source : "",
      status: typeof query.status === "string" ? query.status : "",
      limit: query.limit
    });
    reply.send({ items: records });
  } catch (error) {
    request.log.warn({ error }, "MiniMax log list failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "MiniMax log list failed" });
  }
});

app.get("/api/debug/minimax-logs/:id", async (request, reply) => {
  const params = request.params && typeof request.params === "object" ? request.params : {};
  const id = typeof params.id === "string" ? params.id : "";

  if (!id) {
    return reply.code(400).send({ error: "Log id is required" });
  }

  try {
    const record = getMiniMaxLogById(id);
    if (!record) {
      return reply.code(404).send({ error: "MiniMax log not found" });
    }
    reply.send(record);
  } catch (error) {
    request.log.warn({ error }, "MiniMax log detail failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "MiniMax log detail failed" });
  }
});

app.post("/api/host/topic", async (request, reply) => {
  const body = request.body ?? {};
  const history = Array.isArray(body.history) ? body.history : [];

  try {
    const result = await createProactiveHostTopic({
      currentTrack: body.currentTrack && typeof body.currentTrack === "object" ? body.currentTrack : null,
      nextTrack: body.nextTrack && typeof body.nextTrack === "object" ? body.nextTrack : null,
      mood: typeof body.mood === "string" ? body.mood : "",
      recentUserLine: typeof body.recentUserLine === "string" ? body.recentUserLine : "",
      history
    });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Host topic generation failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Host topic generation failed" });
  }
});

app.post("/api/host/intro", async (request, reply) => {
  const body = request.body ?? {};

  try {
    const result = await createHostIntroCopy({
      track: body.track && typeof body.track === "object" ? body.track : null,
      mood: typeof body.mood === "string" ? body.mood : "",
      context: typeof body.context === "string" ? body.context : ""
    });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Host intro generation failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Host intro generation failed" });
  }
});

// ========== AI Analysis + Suno Playlist in one shot ==========
app.post("/api/playlist/from-chat", async (request, reply) => {
  const body = request.body ?? {};
  const history = Array.isArray(body.history) ? body.history : [];
  const count = Math.min(Math.max(Number(body.count) || 2, 1), 10);

  if (history.length < 2) {
    return reply.code(400).send({ error: "History is required for auto playlist" });
  }

  try {
    const analysis = await analyzeConversation(history);
    const summary = typeof analysis.summary === "string" && analysis.summary.trim()
      ? analysis.summary.trim()
      : `适合${analysis.mood || "relaxed"}心情的音乐`;

    const promptParts = [summary];
    if (Array.isArray(analysis.musicDirection) && analysis.musicDirection.length > 0) {
      promptParts.push(`建议方向：${analysis.musicDirection.slice(0, 3).join("、")}`);
    }
    const recentPreferenceTags = getRecentPreferenceTags(3);
    if (recentPreferenceTags.length > 0) {
      promptParts.push(`近期偏好：${recentPreferenceTags.join("、")}`);
    }

    const playlist = await generatePlaylist({
      mood: analysis.mood || "relaxed",
      prompt: promptParts.join("。"),
      count,
      triggerType: "chat_auto",
      openingSource: "none",
      summary,
      energy: analysis.energy || "",
      themeTags: [...(analysis.themes || []), ...(analysis.musicDirection || [])],
      musicDirection: analysis.musicDirection || []
    });

    reply.send({ analysis, playlist });
  } catch (error) {
    request.log.warn({ error }, "Auto playlist generation failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Auto playlist failed" });
  }
});

// ========== Suno Playlist ==========
app.post("/api/playlist/generate", async (request, reply) => {
  const body = request.body ?? {};
  const mood = typeof body.mood === "string" ? body.mood.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const count = Math.min(Math.max(Number(body.count) || 2, 1), 10);

  try {
    const triggerType = typeof body.triggerType === "string" ? body.triggerType : "manual_api";
    const result = await generatePlaylist({
      mood,
      prompt,
      count,
      triggerType,
      openingSource: typeof body.openingSource === "string" ? body.openingSource : "none",
      summary: typeof body.summary === "string" ? body.summary : "",
      energy: typeof body.energy === "string" ? body.energy : "",
      themeTags: Array.isArray(body.themeTags) ? body.themeTags : [],
      musicDirection: Array.isArray(body.musicDirection) ? body.musicDirection : [],
      chatExcerpt: triggerType === "chat_auto" ? [] : Array.isArray(body.chatExcerpt) ? body.chatExcerpt : []
    });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Playlist generation failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Playlist generation failed" });
  }
});

app.get("/api/playlist/current", async () => getPlaylist());

app.get("/api/playlist/opening", async (request, reply) => {
  try {
    const playlist = await getOpeningPlaylist();
    reply.send(playlist);
  } catch (error) {
    request.log.warn({ error }, "Opening playlist failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Opening playlist failed" });
  }
});

app.get("/api/playlist/history", async (request, reply) => {
  try {
    const limit = Math.min(Math.max(Number(request.query?.limit) || 20, 1), 300);
    reply.send({ items: getPlaylistHistoryList(limit) });
  } catch (error) {
    request.log.warn({ error }, "Playlist history load failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Playlist history load failed" });
  }
});

app.get("/api/playlist/history/:id", async (request, reply) => {
  try {
    const item = getPlaylistHistoryDetail(request.params.id);
    if (!item) {
      return reply.code(404).send({ error: "Playlist history not found" });
    }
    reply.send(item);
  } catch (error) {
    request.log.warn({ error }, "Playlist history detail failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Playlist history detail failed" });
  }
});

app.post("/api/listener/events", async (request, reply) => {
  try {
    const result = recordListenerEvent(request.body ?? {});
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Listener event record failed");
    reply.code(500).send({ error: error instanceof Error ? error.message : "Listener event record failed" });
  }
});

// ========== AI Radio Host Voice ==========
app.post("/api/host/voice", async (request, reply) => {
  const body = request.body ?? {};
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 900) : "";
  const slotId = typeof body.slotId === "string" && body.slotId.trim() ? body.slotId.trim() : "host-intro";

  if (!text) {
    return reply.code(400).send({ error: "Host voice text is required" });
  }
  if (isBlockedHostVoiceText(text)) {
    return reply.code(400).send({ error: "Host voice text looks like prompt scaffolding and was rejected" });
  }

  try {
    const result = await synthesizeHostVoice({ text, slotId });
    reply.send(result);
  } catch (error) {
    request.log.warn({ error }, "Host voice generation failed");
    // Fallback to mock audio
    const mockAudio = getMockHostVoice(text);
    reply.send({
      text,
      audioUrl: mockAudio.audioUrl,
      source: "mock-tone",
      fallback: true,
      reason: error instanceof Error ? error.message : "TTS failed"
    });
  }
});

// ========== Audio Streaming ==========
function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader || typeof rangeHeader !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if ((start !== null && Number.isNaN(start)) || (end !== null && Number.isNaN(end))) {
    return null;
  }

  if (start === null && end === null) return null;

  if (start === null) {
    const suffixLength = end ?? 0;
    if (suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    if (end === null || end >= totalSize) {
      end = totalSize - 1;
    }
  }

  if (start < 0 || end < start || start >= totalSize) {
    return { invalid: true };
  }

  return { start, end };
}

function sendBufferAudioReply(request, reply, buffer, contentType, cacheControl = "public, max-age=86400") {
  const totalSize = buffer.length;
  const range = parseRangeHeader(request.headers.range, totalSize);

  if (range?.invalid) {
    return reply
      .code(416)
      .header("Access-Control-Allow-Origin", "*")
      .header("Accept-Ranges", "bytes")
      .header("Content-Range", `bytes */${totalSize}`)
      .send();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? (totalSize - 1);
  const chunk = buffer.subarray(start, end + 1);
  const statusCode = range ? 206 : 200;

  reply.hijack();
  reply.raw.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Content-Length": chunk.length,
    "Cache-Control": cacheControl,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${totalSize}` } : {})
  });
  reply.raw.end(chunk);
}

function sendFileAudioReply(request, reply, absolutePath, contentType, cacheControl = "public, max-age=86400") {
  const stats = fs.statSync(absolutePath);
  const totalSize = stats.size;
  const range = parseRangeHeader(request.headers.range, totalSize);

  if (range?.invalid) {
    return reply
      .code(416)
      .header("Access-Control-Allow-Origin", "*")
      .header("Accept-Ranges", "bytes")
      .header("Content-Range", `bytes */${totalSize}`)
      .send();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? (totalSize - 1);
  const chunkLength = end - start + 1;
  const statusCode = range ? 206 : 200;

  reply.hijack();
  reply.raw.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Content-Length": chunkLength,
    "Cache-Control": cacheControl,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${totalSize}` } : {})
  });

  const stream = fs.createReadStream(absolutePath, { start, end });
  stream.on("error", () => reply.raw.destroy());
  stream.pipe(reply.raw);
}

app.get("/api/audio/generated/:filename", async (request, reply) => {
  const filename = typeof request.params.filename === "string" ? request.params.filename : "";

  if (!/^[a-z0-9._-]+\.(mp3|wav)$/i.test(filename)) {
    return reply.code(404).send({ error: "Audio file not found" });
  }

  const filePath = path.join(generatedAudioDir, filename);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(path.resolve(generatedAudioDir) + path.sep)) {
    return reply.code(404).send({ error: "Audio file not found" });
  }

  try {
    const contentType = filename.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
    sendFileAudioReply(request, reply, resolved, contentType, "public, max-age=86400");
  } catch {
    reply.code(404).send({ error: "Audio file not found" });
  }
});

app.get("/api/audio/suno/:itemId", async (request, reply) => {
  const itemId = typeof request.params.itemId === "string" ? request.params.itemId.trim() : "";

  if (!/^[a-z0-9-]+$/i.test(itemId)) {
    return reply.code(404).send({ error: "Audio file not found" });
  }

  try {
    const cachedMp3 = path.join(generatedAudioDir, `suno-item-${itemId}.mp3`);
    const cachedWav = path.join(generatedAudioDir, `suno-item-${itemId}.wav`);
    const cachedPath = fs.existsSync(cachedMp3) && fs.statSync(cachedMp3).size > 0
      ? cachedMp3
      : fs.existsSync(cachedWav) && fs.statSync(cachedWav).size > 0
        ? cachedWav
        : "";

    if (cachedPath) {
      const contentType = cachedPath.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";
      sendFileAudioReply(request, reply, cachedPath, contentType, "public, max-age=86400");
      return;
    }

    let contentType = "audio/mpeg";
    let buffer = Buffer.alloc(0);

    try {
      const upstream = await fetch(`https://audiopipe.suno.ai/?item_id=${encodeURIComponent(itemId)}`, {
        signal: AbortSignal.timeout(8000)
      });
      if (upstream.ok) {
        contentType = upstream.headers.get("content-type") || contentType;
        buffer = Buffer.from(await upstream.arrayBuffer());
      }
    } catch {}

    if (!buffer.length) {
      const direct = await downloadSunoAudioDirect(itemId);
      contentType = direct.contentType || contentType;
      buffer = direct.buffer;
    }

    if (!buffer.length) {
      throw new Error("Empty audio payload");
    }

    const extension = contentType.includes("wav") ? "wav" : "mp3";
    const outputPath = path.join(generatedAudioDir, `suno-item-${itemId}.${extension}`);
    fs.writeFileSync(outputPath, buffer);

    sendBufferAudioReply(request, reply, buffer, contentType, "public, max-age=86400");
  } catch {
    reply.code(502).send({ error: "Audio stream unavailable" });
  }
});

// Mock music streaming (generated tones)
app.get("/api/audio/music/:trackId", async (request, reply) => {
  const trackId = request.params.trackId || "default";
  const presets = {
    "warm-morning": { durationSeconds: 8, frequency: 196, secondaryFrequency: 293.66, volume: 0.22 },
    "focus-work": { durationSeconds: 10, frequency: 174.61, secondaryFrequency: 261.63, volume: 0.2 },
    "chill-afternoon": { durationSeconds: 9, frequency: 146.83, secondaryFrequency: 220, volume: 0.24 },
    "evening-glow": { durationSeconds: 8.5, frequency: 130.81, secondaryFrequency: 196, volume: 0.2 },
    "late-night": { durationSeconds: 11, frequency: 110, secondaryFrequency: 164.81, volume: 0.18 },
    "default": { durationSeconds: 8, frequency: 220, secondaryFrequency: 330, volume: 0.22 }
  };

  const preset = presets[trackId] || presets["default"];
  const audio = createToneWav(preset);

  sendBufferAudioReply(request, reply, audio, "audio/wav", "no-store");
});

// ========== Utilities ==========
function isBlockedHostVoiceText(text) {
  const blockedPatterns = [
    /用户要求我/i,
    /当前情境/i,
    /现在需要/i,
    /作为ai电台主播/i,
    /请直接给我/i,
    /最近对话/i,
    /当前歌曲[:：]/i,
    /下一首[:：]/i,
    /听感分析[:：]/i,
    /任务[:：]/i,
    /要求[:：]/i,
    /(^|\n)\s*\d+\./,
    /(^|\n)\s*[一二三四五六七八九十]+\s*[、.]/,
    /\b(happy|sad|relaxed|focused|energetic|romantic|nostalgic|party)\b/i
  ];
  return blockedPatterns.some((pattern) => pattern.test(text));
}

function loadLocalEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  let pendingKey = "";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      if (pendingKey && process.env[pendingKey] !== undefined) {
        process.env[pendingKey] += trimmed.replace(/^["']|["']$/g, "");
      }
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
    pendingKey = key;
  }
}

// Start server
if (isMainModule()) {
  try {
    await app.listen({ port, host });
    console.log(`AI Radio Station API running at http://${host}:${port}`);
    setTimeout(() => {
      const queued = schedulePendingSunoAudioCache();
      if (queued > 0) {
        console.log(`Queued ${queued} pending Suno full-audio downloads.`);
      }
    }, 1000);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function downloadSunoAudioDirect(itemId) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://audiopipe.suno.ai/?item_id=${encodeURIComponent(itemId)}`, {
      headers: {
        Accept: "*/*",
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {
      if ((res.statusCode || 0) >= 400) {
        res.resume();
        reject(new Error(`Audio download failed: ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: res.headers["content-type"] || "audio/mpeg"
      }));
      res.on("error", reject);
    });

    req.setTimeout(20000, () => req.destroy(new Error("Audio download timeout")));
    req.on("error", reject);
  });
}
