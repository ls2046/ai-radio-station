function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getApiBase() {
  const configuredBase = process.env.NEXT_PUBLIC_API_BASE;
  if (configuredBase) {
    return trimTrailingSlash(configuredBase);
  }

  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }

  return "http://localhost:4000";
}

async function fetchApi(path: string, options?: RequestInit) {
  const res = await fetch(`${getApiBase()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 204) {
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface HostTrackPayload {
  id?: string;
  title?: string;
  artist?: string;
  style?: string;
  mood?: string;
  duration?: string;
  audioUrl?: string | null;
  tags?: string[];
}

export interface HostTranscriptItem {
  role: string;
  content: string;
}

export interface HostRespondPayload {
  sessionId?: string;
  event: HostEvent;
  allowedActions?: string[];
  context?: {
    currentTrack?: HostTrackPayload | null;
    nextTrack?: HostTrackPayload | null;
    playlist?: {
      id?: string;
      mood?: string;
      source?: string;
      songCount?: number;
      currentIndex?: number;
    } | null;
    mood?: string;
    playlistMood?: string;
    recentUserLine?: string;
    recentTranscript?: HostTranscriptItem[];
    dayPart?: string;
    playbackProgressMs?: number;
    isPlaying?: boolean;
    justSwitchedTrack?: boolean;
	    manualReason?: string;
	    generatedSummary?: string;
	    musicGenerationStatus?: string;
	    summary?: string;
    recentHostSummary?: string;
  };
}

export type HostDynamicEvent = "song_change" | "user_speak" | "proactive";
export type HostLegacyEvent =
  | "page_opened"
  | "playlist_generated"
  | "track_changed"
  | "track_started"
  | "listener_message"
  | "idle_gap"
  | "scheduled_check";
export type HostEvent = HostDynamicEvent | HostLegacyEvent;

export interface HostActionPlan {
  type: string;
  payload?: Record<string, unknown>;
}

export interface HostMusicAction {
  type: string;
  mood?: string;
  reason?: string;
}

export interface HostReplyPlan {
  shouldSpeak?: boolean;
  text?: string;
  appendToChat?: boolean;
  voiceStyle?: string;
}

export interface HostTtsPlan {
  shouldSynthesize?: boolean;
  textSource?: "reply";
}

export interface HostRespondResult {
  scene?: string;
  response_mode?: string;
  reason?: string;
  reply?: HostReplyPlan;
  music_action?: HostMusicAction | null;
  tts?: HostTtsPlan;
  actions?: HostActionPlan[];
  priority?: string;
  source?: string;
  reasoningMeta?: {
    event?: string;
    inferredMood?: string;
    responseMode?: string;
    transcriptCount?: number;
    actionTypes?: string[];
  };
}

export interface MiniMaxLogListItem {
  id: string;
  createdAt: string;
  entrypoint: string;
  triggerSource: string;
  model: string;
  status: string;
  errorMessage: string;
  responseText: string;
  requestMessages: { role?: string; content?: string }[];
  requestParams: Record<string, unknown>;
  responseJson: unknown;
  promptPreview: string;
  responsePreview: string;
}

export interface MiniMaxLogDetail extends MiniMaxLogListItem {}

// AI Chat
export async function sendChatMessage(message: string, history: { role: string; content: string }[] = []) {
  return fetchApi("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, history }),
  });
}

// AI Analysis
export async function analyzeConversation(history: { role: string; content: string }[]) {
  return fetchApi("/api/chat/analyze", {
    method: "POST",
    body: JSON.stringify({ history }),
  });
}

// Analyze conversation and generate playlist in one shot
export async function generatePlaylistFromConversation(history: { role: string; content: string }[], count?: number) {
  return fetchApi("/api/playlist/from-chat", {
    method: "POST",
    body: JSON.stringify({ history, count }),
  });
}

// Generate Playlist
export async function generatePlaylist(
  mood: string,
  prompt?: string,
  count?: number,
  meta?: {
    triggerType?: string;
    openingSource?: string;
    summary?: string;
    energy?: string;
    themeTags?: string[];
    musicDirection?: string[];
  }
) {
  return fetchApi("/api/playlist/generate", {
    method: "POST",
    body: JSON.stringify({ mood, prompt, count, ...meta }),
  });
}

export async function getOpeningPlaylist() {
  return fetchApi("/api/playlist/opening");
}

// Get Current Playlist
export async function getCurrentPlaylist() {
  return fetchApi("/api/playlist/current");
}

export async function getPlaylistHistory(limit?: number) {
  const suffix = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return fetchApi(`/api/playlist/history${suffix}`);
}

export async function recordListenerEvent(payload: {
  eventType: string;
  playlistId?: string | null;
  songId?: string | null;
  mood?: string | null;
  tags?: string[];
  messageExcerpt?: string;
  context?: Record<string, unknown>;
}) {
  return fetchApi("/api/listener/events", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function requestHostDecision(payload: HostRespondPayload) {
  return fetchApi("/api/host/respond", {
    method: "POST",
    body: JSON.stringify(payload),
  }) as Promise<HostRespondResult>;
}

export const requestHostResponse = requestHostDecision;

export async function getMiniMaxLogs(filters?: {
  entrypoint?: string;
  triggerSource?: string;
  status?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.entrypoint) params.set("entrypoint", filters.entrypoint);
  if (filters?.triggerSource) params.set("trigger_source", filters.triggerSource);
  if (filters?.status) params.set("status", filters.status);
  if (typeof filters?.limit === "number") params.set("limit", String(filters.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await fetchApi(`/api/debug/minimax-logs${suffix}`);
  return (result?.items || []) as MiniMaxLogListItem[];
}

export async function getMiniMaxLogDetail(id: string) {
  return fetchApi(`/api/debug/minimax-logs/${encodeURIComponent(id)}`) as Promise<MiniMaxLogDetail>;
}

// Generate Host Voice
export async function generateHostVoice(text: string, slotId?: string) {
  return fetchApi("/api/host/voice", {
    method: "POST",
    body: JSON.stringify({ text, slotId }),
  });
}

// Get Music Audio URL
export function getMusicAudioUrl(trackId: string) {
  if (!trackId) {
    trackId = "default";
  }
  if (/^https?:\/\//i.test(trackId)) {
    return trackId;
  }
  if (trackId.startsWith("/")) {
    return `${getApiBase()}${trackId}`;
  }
  return `${getApiBase()}/api/audio/music/${encodeURIComponent(trackId)}`;
}

// Get Generated Audio URL
export function getGeneratedAudioUrl(filename: string) {
  return `${getApiBase()}/api/audio/generated/${encodeURIComponent(filename)}`;
}
