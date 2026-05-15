"use client";

import { useEffect, useMemo, useState } from "react";
import { getMiniMaxLogDetail, getMiniMaxLogs, type MiniMaxLogDetail, type MiniMaxLogListItem } from "../../../lib/api";

const ENTRYPOINT_OPTIONS = [
  { value: "", label: "全部入口" },
  { value: "host_respond", label: "host_respond" },
  { value: "chat", label: "chat" },
  { value: "chat_analyze", label: "chat_analyze" }
];

const TRIGGER_OPTIONS = [
  { value: "", label: "全部触发源" },
  { value: "user_speak", label: "user_speak" },
  { value: "proactive", label: "proactive" },
  { value: "song_change", label: "song_change" },
  { value: "chat_message", label: "chat_message" },
  { value: "conversation_analysis", label: "conversation_analysis" }
];

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "success", label: "success" },
  { value: "error", label: "error" }
];

function formatTimestamp(value: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function truncateLine(value: string, limit = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function extractRawResponseContent(detail: MiniMaxLogDetail | null) {
  const content = (detail?.responseJson as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null)?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim()
    ? content.trim()
    : (detail?.responseText || "");
}

export default function MiniMaxDebugPage() {
  const [items, setItems] = useState<MiniMaxLogListItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<MiniMaxLogDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    entrypoint: "",
    triggerSource: "",
    status: ""
  });

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    setError("");

    getMiniMaxLogs({
      ...filters,
      limit: 80
    }).then((records) => {
      if (cancelled) return;
      setItems(records);
      setSelectedId((current) => {
        if (current && records.some((item) => item.id === current)) {
          return current;
        }
        return records[0]?.id || "";
      });
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : "加载日志失败");
      setItems([]);
      setSelectedId("");
    }).finally(() => {
      if (!cancelled) {
        setLoadingList(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    setError("");

    getMiniMaxLogDetail(selectedId).then((record) => {
      if (!cancelled) {
        setDetail(record);
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "加载详情失败");
        setDetail(null);
      }
    }).finally(() => {
      if (!cancelled) {
        setLoadingDetail(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectedSummary = useMemo(() => {
    if (!detail) return "";
    return detail.responsePreview || detail.responseText || detail.errorMessage || "";
  }, [detail]);

  const rawResponseContent = useMemo(() => extractRawResponseContent(detail), [detail]);

  return (
    <main className="minimax-debug-page">
      <section className="minimax-debug-shell">
        <header className="minimax-debug-header">
          <div>
            <p className="minimax-debug-eyebrow">Internal Debug</p>
            <h1>MiniMax Prompt 日志</h1>
            <p className="minimax-debug-subtitle">查看 LLM 请求 Prompt、返回内容和失败记录。当前数据源为 SQLite 数据库。</p>
          </div>
        </header>

        <section className="minimax-debug-filters">
          <label>
            <span>入口</span>
            <select value={filters.entrypoint} onChange={(event) => setFilters((current) => ({ ...current, entrypoint: event.target.value }))}>
              {ENTRYPOINT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>触发源</span>
            <select value={filters.triggerSource} onChange={(event) => setFilters((current) => ({ ...current, triggerSource: event.target.value }))}>
              {TRIGGER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>状态</span>
            <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </section>

        {error ? <p className="minimax-debug-error">{error}</p> : null}

        <section className="minimax-debug-grid">
          <aside className="minimax-debug-list">
            <div className="minimax-debug-list-head">
              <strong>请求列表</strong>
              <span>{loadingList ? "加载中..." : `${items.length} 条`}</span>
            </div>

            <div className="minimax-debug-list-body">
              {items.length > 0 ? (
                <div className="minimax-debug-table-head" aria-hidden="true">
                  <span>时间</span>
                  <span>入口</span>
                  <span>触发源</span>
                  <span>状态</span>
                  <span>Prompt 摘要</span>
                  <span>返回摘要</span>
                </div>
              ) : null}
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`minimax-debug-item ${selectedId === item.id ? "is-active" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="minimax-debug-cell minimax-debug-time">{formatTimestamp(item.createdAt)}</span>
                  <span className="minimax-debug-cell minimax-debug-entry">{item.entrypoint}</span>
                  <span className="minimax-debug-cell minimax-debug-trigger">{item.triggerSource || "—"}</span>
                  <span className="minimax-debug-cell">
                    <span className={`minimax-debug-status is-${item.status}`}>{item.status}</span>
                  </span>
                  <span className="minimax-debug-cell minimax-debug-snippet" title={item.promptPreview || ""}>
                    {truncateLine(item.promptPreview || "无 prompt 摘要")}
                  </span>
                  <span className="minimax-debug-cell minimax-debug-snippet" title={item.responsePreview || item.errorMessage || ""}>
                    {truncateLine(item.responsePreview || item.errorMessage || "无返回摘要")}
                  </span>
                </button>
              ))}
              {!loadingList && items.length === 0 ? (
                <div className="minimax-debug-empty">当前筛选条件下没有记录。</div>
              ) : null}
            </div>
          </aside>

          <section className="minimax-debug-detail">
            <div className="minimax-debug-detail-head">
              <strong>详情</strong>
              {detail ? <span>{detail.model}</span> : null}
            </div>

            {loadingDetail ? (
              <div className="minimax-debug-empty">正在加载详情...</div>
            ) : !detail ? (
              <div className="minimax-debug-empty">选择一条记录查看详情。</div>
            ) : (
              <div className="minimax-debug-panels">
                <div className="minimax-debug-card">
                  <h2>概览</h2>
                  <dl className="minimax-debug-kv">
                    <div><dt>时间</dt><dd>{formatTimestamp(detail.createdAt)}</dd></div>
                    <div><dt>入口</dt><dd>{detail.entrypoint}</dd></div>
                    <div><dt>触发源</dt><dd>{detail.triggerSource || "—"}</dd></div>
                    <div><dt>状态</dt><dd><span className={`minimax-debug-status is-${detail.status}`}>{detail.status}</span></dd></div>
                  </dl>
                </div>

                <div className="minimax-debug-card">
                  <h2>实际发出</h2>
                  <div className="minimax-debug-message-list">
                    {detail.requestMessages.map((message, index) => (
                      <section key={`${message.role || "unknown"}-${index}`} className="minimax-debug-message-block">
                        <div className="minimax-debug-message-head">
                          <span className={`minimax-debug-role is-${message.role || "unknown"}`}>{message.role || "unknown"}</span>
                        </div>
                        <pre>{message.content || ""}</pre>
                      </section>
                    ))}
                  </div>
                </div>

                <div className="minimax-debug-card">
                  <h2>实际获取</h2>
                  <pre>{rawResponseContent || "无"}</pre>
                </div>

                <div className="minimax-debug-card">
                  <h2>请求摘要</h2>
                  <p className="minimax-debug-summary">{detail.promptPreview || "无"}</p>
                </div>

                <div className="minimax-debug-card">
                  <h2>返回摘要</h2>
                  <p className="minimax-debug-summary">{selectedSummary || "无"}</p>
                </div>

                {detail.errorMessage ? (
                  <div className="minimax-debug-card">
                    <h2>错误信息</h2>
                    <pre>{detail.errorMessage}</pre>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </section>
      </section>
    </main>
  );
}
