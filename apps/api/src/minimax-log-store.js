import crypto from "node:crypto";
import { getDatabase } from "./db.js";

function safeJsonStringify(value, fallback = "null") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function safeJsonParse(raw, fallback = null) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildPromptPreview(messages) {
  const items = Array.isArray(messages) ? messages : [];
  const lastUserMessage = [...items].reverse().find((item) => item?.role === "user" && typeof item.content === "string");
  const source = lastUserMessage?.content || "";
  return source.replace(/\s+/g, " ").trim().slice(0, 220);
}

function buildResponsePreview(responseText) {
  return String(responseText || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function hydrateMiniMaxLogRow(row) {
  const requestMessages = safeJsonParse(row.request_messages_json, []);
  const requestParams = safeJsonParse(row.request_params_json, {});
  const responseJson = safeJsonParse(row.response_json, null);

  return {
    id: row.id,
    createdAt: row.created_at,
    entrypoint: row.entrypoint,
    triggerSource: row.trigger_source || "",
    model: row.model,
    status: row.status,
    errorMessage: row.error_message || "",
    responseText: row.response_text || "",
    responseJson,
    requestMessages,
    requestParams,
    promptPreview: buildPromptPreview(requestMessages),
    responsePreview: buildResponsePreview(row.response_text || "")
  };
}

export function recordMiniMaxLlmLog({
  entrypoint,
  triggerSource = "",
  model,
  requestMessages,
  requestParams,
  responseText = "",
  responseJson = null,
  status,
  errorMessage = ""
}) {
  const db = getDatabase();
  const safeEntrypoint = String(entrypoint || "").trim().slice(0, 80);
  if (!safeEntrypoint) return null;

  const safeTriggerSource = String(triggerSource || "").trim().slice(0, 80);
  const safeModel = String(model || "").trim().slice(0, 120) || "unknown";
  const safeStatus = String(status || "").trim().slice(0, 24) || "success";
  const safeErrorMessage = String(errorMessage || "").trim().slice(0, 1000);

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO minimax_logs (
      id,
      created_at,
      entrypoint,
      trigger_source,
      model,
      request_messages_json,
      request_params_json,
      response_text,
      response_json,
      status,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    new Date().toISOString(),
    safeEntrypoint,
    safeTriggerSource || null,
    safeModel,
    safeJsonStringify(Array.isArray(requestMessages) ? requestMessages : [] , "[]"),
    safeJsonStringify(requestParams && typeof requestParams === "object" ? requestParams : {}, "{}"),
    responseText ? String(responseText).slice(0, 20000) : null,
    responseJson == null ? null : safeJsonStringify(responseJson),
    safeStatus,
    safeErrorMessage || null
  );

  return id;
}

export function listMiniMaxLogs(filters = {}) {
  const db = getDatabase();
  const conditions = [];
  const params = [];

  if (typeof filters.entrypoint === "string" && filters.entrypoint.trim()) {
    conditions.push("entrypoint = ?");
    params.push(filters.entrypoint.trim());
  }
  if (typeof filters.triggerSource === "string" && filters.triggerSource.trim()) {
    conditions.push("trigger_source = ?");
    params.push(filters.triggerSource.trim());
  }
  if (typeof filters.status === "string" && filters.status.trim()) {
    conditions.push("status = ?");
    params.push(filters.status.trim());
  }

  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
    : 50;

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT
      id,
      created_at,
      entrypoint,
      trigger_source,
      model,
      request_messages_json,
      request_params_json,
      response_text,
      response_json,
      status,
      error_message
    FROM minimax_logs
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map((row) => hydrateMiniMaxLogRow(row));
}

export function getMiniMaxLogById(id) {
  const safeId = String(id || "").trim();
  if (!safeId) return null;
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      id,
      created_at,
      entrypoint,
      trigger_source,
      model,
      request_messages_json,
      request_params_json,
      response_text,
      response_json,
      status,
      error_message
    FROM minimax_logs
    WHERE id = ?
    LIMIT 1
  `).get(safeId);

  return row ? hydrateMiniMaxLogRow(row) : null;
}
