import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const SUNO_BASE_URL = "https://studio-api.prod.suno.com";
const SUNO_WEB_BASE_URL = "https://studio-api-prod.suno.com";
const DEFAULT_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
const dataDir = path.join(rootDir, "data");
const manualRequestTemplatePath = path.join(dataDir, "manual-generate-request.json");
const requestProfilePath = path.join(dataDir, "last-generate-request.json");
const execFileAsync = promisify(execFile);

export function isRealSunoSource(source) {
  return source === "suno-official" || source === "suno-api";
}

export function getRealSunoSourceLabel() {
  return "suno-official";
}

export function shouldUseRealSuno() {
  const forceReal = process.env.SUNO_ENABLE_REAL?.toLowerCase();
  const template = getFreshManualRequestTemplate();
  const authorization = getAuthorization(template);
  const sessionToken = getSessionToken(template);

  if (forceReal === "false") return false;
  const enabled = Boolean(authorization && sessionToken);
  if (forceReal === "true") return enabled;
  return enabled;
}

export async function generateSunoTracks(prompt) {
  const template = getFreshManualRequestTemplate();
  if (!template) {
    throw new Error("Suno direct request template is missing or expired");
  }

  const authorization = getAuthorization(template);
  const sessionToken = getSessionToken(template);
  const requestToken = getRequestToken(template);

  if (!authorization || !sessionToken) {
    throw new Error("Suno direct auth is incomplete; update data/manual-generate-request.json");
  }

  const payload = buildGeneratePayload(template, prompt, sessionToken, requestToken);
  const data = await requestSunoJson({
    method: "POST",
    url: `${SUNO_WEB_BASE_URL}/api/generate/v2-web/`,
    headers: buildGenerateHeaders(template, authorization),
    body: payload,
    timeoutMs: 20_000
  });
  const clips = Array.isArray(data?.clips) ? data.clips : [];

  await saveRequestProfile({
    capturedAt: new Date().toISOString(),
    userAgent: getUserAgent(template),
    deviceId: getDeviceId(template),
    model: payload.mv,
    generationType: payload.generation_type,
    tokenProvider: payload.token_provider ?? null,
    prompt: payload.prompt || "",
    gptDescriptionPrompt: payload.gpt_description_prompt || "",
    metadata: {
      web_client_pathname: payload.metadata.web_client_pathname,
      is_max_mode: Boolean(payload.metadata.is_max_mode),
      is_mumble: Boolean(payload.metadata.is_mumble),
      create_mode: String(payload.metadata.create_mode || "simple"),
      user_tier: typeof payload.metadata.user_tier === "string" ? payload.metadata.user_tier : null,
      disable_volume_normalization: Boolean(payload.metadata.disable_volume_normalization),
      lyrics_model: String(payload.metadata.lyrics_model || "default")
    }
  });

  return clips.map(normalizeClip);
}

export async function getSunoTracks(songIds = []) {
  const template = getFreshManualRequestTemplate();
  const authorization = getAuthorization(template);
  if (!authorization) {
    throw new Error("Suno direct auth is missing; update data/manual-generate-request.json");
  }

  const url = new URL(`${SUNO_BASE_URL}/api/feed/v2`);
  if (songIds.length) {
    url.searchParams.set("ids", songIds.join(","));
  }

  const data = await requestSunoJson({
    method: "GET",
    url: url.toString(),
    headers: buildBrowserHeaders(template, {
      authorization,
      includeCookie: true
    }),
    timeoutMs: 20_000
  });
  const clips = Array.isArray(data?.clips) ? data.clips : [];
  return clips.map(normalizeClip);
}

function buildGeneratePayload(template, prompt, sessionToken, requestToken) {
  const payload = JSON.parse(JSON.stringify(template?.payload || {}));
  const savedMetadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};

  payload.token = requestToken || null;
  payload.generation_type = payload.generation_type || "TEXT";
  payload.mv = process.env.SUNO_MODEL || payload.mv || "chirp-fenix";
  payload.prompt = "";
  payload.gpt_description_prompt = prompt;
  payload.make_instrumental = false;
  payload.user_uploaded_images_b64 = null;
  payload.metadata = {
    ...savedMetadata,
    web_client_pathname: savedMetadata.web_client_pathname || "/create",
    is_max_mode: savedMetadata.is_max_mode ?? false,
    is_mumble: savedMetadata.is_mumble ?? false,
    create_mode: savedMetadata.create_mode || "simple",
    user_tier: savedMetadata.user_tier || null,
    create_session_token: sessionToken,
    disable_volume_normalization: savedMetadata.disable_volume_normalization ?? false,
    lyrics_model: savedMetadata.lyrics_model || "default"
  };
  payload.override_fields = Array.isArray(payload.override_fields) ? payload.override_fields : [];
  payload.cover_clip_id = payload.cover_clip_id ?? null;
  payload.cover_start_s = payload.cover_start_s ?? null;
  payload.cover_end_s = payload.cover_end_s ?? null;
  payload.persona_id = payload.persona_id ?? null;
  payload.artist_clip_id = payload.artist_clip_id ?? null;
  payload.artist_start_s = payload.artist_start_s ?? null;
  payload.artist_end_s = payload.artist_end_s ?? null;
  payload.continue_clip_id = payload.continue_clip_id ?? null;
  payload.continued_aligned_prompt = payload.continued_aligned_prompt ?? null;
  payload.continue_at = payload.continue_at ?? null;
  payload.transaction_uuid = crypto.randomUUID();
  if (typeof process.env.SUNO_TOKEN_PROVIDER === "string" && process.env.SUNO_TOKEN_PROVIDER.trim()) {
    payload.token_provider = Number(process.env.SUNO_TOKEN_PROVIDER);
  } else if (typeof payload.token_provider !== "number") {
    payload.token_provider = null;
  }

  return payload;
}

function normalizeClip(clip) {
  const metadata = clip?.metadata && typeof clip.metadata === "object" ? clip.metadata : {};
  return {
    id: clip?.id,
    title: clip?.title,
    audio_url: clip?.audio_url || "",
    video_url: clip?.video_url || "",
    image_url: clip?.image_url || "",
    created_at: clip?.created_at || "",
    model_name: clip?.model_name || "",
    status: clip?.status || "",
    gpt_description_prompt: metadata.gpt_description_prompt || "",
    prompt: metadata.prompt || "",
    type: metadata.type || "",
    tags: metadata.tags || [],
    negative_tags: metadata.negative_tags || "",
    duration: metadata.duration || ""
  };
}

function getFreshManualRequestTemplate() {
  const parsed = readJsonFile(manualRequestTemplatePath);
  const capturedAtValue = parsed?.capturedAt || parsed?.updatedAt;
  const payloadValue = parsed?.payload || parsed?.bodyTemplate;
  if (!capturedAtValue || !parsed?.headers || !payloadValue) {
    return null;
  }

  const capturedAt = Date.parse(capturedAtValue);
  if (!Number.isFinite(capturedAt)) {
    return null;
  }

  return {
    ...parsed,
    capturedAt: capturedAtValue,
    payload: payloadValue
  };
}

function getAuthorization(template) {
  return (process.env.SUNO_AUTHORIZATION || template?.headers?.authorization || "").trim();
}

function getBrowserToken(template) {
  return (process.env.SUNO_BROWSER_TOKEN || template?.headers?.browserToken || "").trim();
}

function getDeviceId(template) {
  return (process.env.SUNO_DEVICE_ID || template?.headers?.deviceId || "").trim();
}

function getUserAgent(template) {
  return (process.env.SUNO_BROWSER_USER_AGENT || template?.headers?.userAgent || DEFAULT_DESKTOP_UA).trim();
}

function getRequestToken(template) {
  return (process.env.SUNO_REQUEST_TOKEN || template?.payload?.token || "").trim();
}

function getSessionToken(template) {
  return (process.env.SUNO_SESSION_TOKEN || template?.payload?.metadata?.create_session_token || "").trim();
}

function getCookieHeader() {
  return (process.env.SUNO_COOKIE || process.env.SUNO_API_KEY || "").trim();
}

function buildGenerateHeaders(template, authorization) {
  return buildBrowserHeaders(template, {
    authorization,
    browserToken: getBrowserToken(template),
    includeCookie: false
  });
}

function buildBrowserHeaders(template, options = {}) {
  const headers = {
    Accept: "*/*",
    "Accept-Language": template?.headers?.acceptLanguage || "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "device-id": getDeviceId(template),
    Origin: template?.headers?.origin || "https://suno.com",
    Pragma: "no-cache",
    priority: template?.headers?.priority || "u=1, i",
    Referer: template?.headers?.referer || "https://suno.com/",
    "sec-ch-ua": template?.headers?.secChUa || "\"Chromium\";v=\"148\", \"Microsoft Edge\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
    "sec-ch-ua-mobile": template?.headers?.secChUaMobile || "?0",
    "sec-ch-ua-platform": template?.headers?.secChUaPlatform || "\"macOS\"",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": getUserAgent(template)
  };

  if (options.authorization) {
    headers.authorization = options.authorization;
  }
  if (options.browserToken) {
    headers["browser-token"] = options.browserToken;
  }
  if (options.includeCookie) {
    const cookie = getCookieHeader();
    if (cookie) {
      headers.Cookie = cookie;
    }
  }

  return headers;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function saveRequestProfile(profile) {
  try {
    fs.mkdirSync(path.dirname(requestProfilePath), { recursive: true });
    fs.writeFileSync(requestProfilePath, JSON.stringify(profile, null, 2), "utf8");
  } catch {}
}

async function requestSunoJson({ method, url, headers, body, timeoutMs = 20_000 }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suno-curl-"));
  const headerPath = path.join(tmpDir, "headers.txt");
  const bodyPath = path.join(tmpDir, "body.txt");
  try {
    const args = [
      "-sS",
      "-X",
      method,
      "--connect-timeout",
      String(Math.max(5, Math.ceil(timeoutMs / 1000))),
      "--max-time",
      String(Math.max(10, Math.ceil(timeoutMs / 1000))),
      "--dump-header",
      headerPath,
      "-o",
      bodyPath,
      url
    ];

    for (const [key, value] of Object.entries(headers || {})) {
      if (typeof value === "string" && value.length > 0) {
        args.push("-H", `${key}: ${value}`);
      }
    }

    if (body !== undefined) {
      args.push("--data-raw", JSON.stringify(body));
    }

    try {
      await execFileAsync("curl", args, { maxBuffer: 1024 * 1024 * 8 });
    } catch (error) {
      const curlBody = safeReadFile(bodyPath);
      const curlHeaders = safeReadFile(headerPath);
      throw new Error(
        `Suno curl request failed: ${error?.message || String(error)}\n${curlHeaders}\n${curlBody}`.trim()
      );
    }

    const rawHeaders = safeReadFile(headerPath);
    const rawBody = safeReadFile(bodyPath);
    const status = parseHttpStatus(rawHeaders);

    if (status < 200 || status >= 300) {
      throw new Error(`Suno request failed: ${status} ${rawBody.slice(0, 500)}`.trim());
    }

    return rawBody ? JSON.parse(rawBody) : {};
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseHttpStatus(rawHeaders) {
  const lines = String(rawHeaders || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^HTTP\/\S+\s+(\d{3})\b/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return 0;
}
