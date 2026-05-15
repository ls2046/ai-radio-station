import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase } from "./db.js";
import { generateSunoTracks, getRealSunoSourceLabel, getSunoTracks, isRealSunoSource, shouldUseRealSuno } from "./suno.js";

const SUNO_POLL_MAX_RETRIES = 60;
const SUNO_POLL_INTERVAL_MS = 4000;
const SUNO_REQUEST_BUDGET_MS = 60000;
const GENERATED_AUDIO_DOWNLOAD_TIMEOUT_MS = 90000;
const GENERATED_AUDIO_DOWNLOAD_IDLE_TIMEOUT_MS = 15000;
const OPENING_HISTORY_LOOKBACK_DAYS = 7;
const OPENING_HISTORY_LIMIT = 20;
const PREFERENCE_EVENT_LIMIT = 50;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../..");
const generatedAudioDir = path.join(rootDir, "audio", "generated");

let currentPlaylist = null;
const backgroundAudioCacheJobs = new Map();

const moodLabels = {
  happy: "开心",
  relaxed: "放松",
  focused: "专注",
  energetic: "活力",
  romantic: "浪漫",
  sad: "安静",
  nostalgic: "怀旧",
  party: "派对"
};

const sunoMoodBriefs = {
  happy: {
    scene: "像一天里突然变轻的时刻，阳光、微风、朋友的笑声都在旁边，但不要廉价兴奋",
    sound: "明亮流行、轻快律动、温暖人声，旋律要有记忆点",
    avoid: "不要口号式喊麦，不要只重复开心两个字"
  },
  relaxed: {
    scene: "像下班后终于坐下来，房间灯光变软，整个人慢慢松开的片刻",
    sound: "松弛的中慢速节奏、柔和吉他或电钢琴、空气感人声",
    avoid: "不要过度煽情，不要做成纯白噪音"
  },
  focused: {
    scene: "像夜里或午后进入专注状态，桌面很安静，思绪被一点点整理清楚",
    sound: "稳定律动、低干扰旋律、克制的人声或轻电子质感",
    avoid: "不要太吵，不要大起大落，不要抢注意力"
  },
  energetic: {
    scene: "像重新打起精神出门，脚步变快，身体里有一股往前冲的劲",
    sound: "有弹性的鼓点、明亮合成器或吉他、上扬副歌",
    avoid: "不要土嗨，不要只有速度没有情绪"
  },
  romantic: {
    scene: "像傍晚街灯刚亮，两个人慢慢靠近，话不多但心意很明显",
    sound: "温柔 R&B 或抒情流行、细腻和声、亲密的人声距离",
    avoid: "不要油腻情话，不要婚礼模板感"
  },
  sad: {
    scene: "像一个人终于不用强撑，情绪安静落下来，眼泪可以慢慢流出来",
    sound: "安静慢歌、钢琴或清淡吉他、低声线人声，留出呼吸感",
    avoid: "不要狗血苦情，不要把悲伤唱得太满"
  },
  nostalgic: {
    scene: "像翻到旧照片或走过熟悉的路，过去的事轻轻浮上来",
    sound: "复古流行、温暖磁带感、柔软鼓组和有年代感的旋律",
    avoid: "不要做成老歌模仿秀，不要堆砌年代标签"
  },
  party: {
    scene: "像朋友聚在一起，灯光亮起来，气氛自然升温",
    sound: "跳舞流行、清晰鼓点、抓耳 hook，适合跟着点头",
    avoid: "不要刺耳，不要夜店噪音墙"
  }
};

function buildSunoGenerationPrompt({
  mood,
  prompt = "",
  summary = "",
  energy = "",
  themeTags = [],
  musicDirection = [],
  triggerType = "",
  chatExcerpt = []
} = {}) {
  const moodKey = mood || "relaxed";
  const moodLabel = moodLabels[moodKey] || moodKey;
  const moodBrief = sunoMoodBriefs[moodKey] || sunoMoodBriefs.relaxed;
  const cleanedPrompt = cleanPromptSentence(prompt);
  const cleanedSummary = cleanPromptSentence(summary);
  const directions = uniqueStrings([
    ...musicDirection,
    ...themeTags
  ])
    .filter((item) => item !== moodKey && item !== moodLabel)
    .slice(0, 4);
  const recentUserContext = summarizeChatExcerpt(chatExcerpt);
  const intent = cleanedSummary || cleanedPrompt || recentUserContext || `为${moodLabel}情绪生成一首歌`;
  const triggerScene = describeGenerateTrigger(triggerType);
  const energyText = cleanPromptSentence(energy);

  return [
    `请生成一首中文原创歌曲，核心情境：${intent}。`,
    recentUserContext && recentUserContext !== intent ? `连续语境：${recentUserContext}。` : "",
    `画面感：${moodBrief.scene}。`,
    `音乐方向：${directions.length ? `${directions.join("、")}；` : ""}${moodBrief.sound}。`,
    energyText ? `能量状态：${energyText}。` : "",
    triggerScene ? `触发场景：${triggerScene}。` : "",
    "歌词要像一个真实的人在这一刻说话，有具体画面和情绪推进，不要写成标签说明，也不要出现点歌指令或聊天原句。",
    `避免：${moodBrief.avoid}。`
  ].filter(Boolean).join("\n");
}

function cleanPromptSentence(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function summarizeChatExcerpt(chatExcerpt = []) {
  const lines = (Array.isArray(chatExcerpt) ? chatExcerpt : [])
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const role = typeof item.role === "string" ? item.role : "";
        const content = typeof item.content === "string" ? item.content : "";
        return role === "user" && content ? content : "";
      }
      return "";
    })
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-4);
  return lines.join("；");
}

function describeGenerateTrigger(triggerType = "") {
  const text = cleanPromptSentence(triggerType);
  if (!text) return "";
  const known = {
    mood_click: "听众主动点了氛围标签，需要把标签扩展成完整场景",
    listener_requested_new_track: "听众明确想要一首新的歌，要承接刚才的对话情绪",
    host_action: "主播判断此刻需要一首更贴合现场的新歌",
    chat_auto: "根据最近聊天自动补一首适合现场气氛的歌"
  };
  return known[text] || text;
}

export async function generatePlaylist(options = {}) {
  const {
    mood,
    prompt,
    count = 2,
    triggerType = "manual_api",
    openingSource = "none",
    summary = "",
    energy = "",
    themeTags = [],
    musicDirection = [],
    chatExcerpt = []
  } = options;

  const targetMood = mood || "relaxed";
  const targetCount = Math.min(Math.max(Number(count) || 1, 1), 10);
  const normalizedChatExcerpt = triggerType === "chat_auto" ? [] : chatExcerpt;
  const songsPrompt = buildSunoGenerationPrompt({
    mood: targetMood,
    prompt,
    summary,
    energy,
    themeTags,
    musicDirection,
    triggerType,
    chatExcerpt: normalizedChatExcerpt
  });

  let playlistSongs = [];
  if (shouldUseRealSuno()) {
    try {
      playlistSongs = await fetchSunoPlaylist(targetMood, songsPrompt, targetCount);
      if (playlistSongs.length === 0) {
        console.warn("Suno API returned no usable songs.");
      }
    } catch (error) {
      console.warn("Suno API request failed:", error instanceof Error ? error.message : error);
      playlistSongs = [];
    }
  } else {
    console.warn("Suno real API is disabled or missing fresh local request template; no songs generated.");
  }

  playlistSongs = preparePlaylistSongsForPlayback(playlistSongs);

  const preparedThemeTags = uniqueStrings([
    ...themeTags,
    ...musicDirection,
    ...playlistSongs.flatMap((song) => Array.isArray(song.tags) ? song.tags.slice(0, 2) : [])
  ]).slice(0, 8);

  const playlist = {
    id: `playlist-${Date.now()}`,
    mood: targetMood,
    prompt: songsPrompt,
    generatedAt: new Date().toISOString(),
    source: playlistSongs.some((song) => isRealSunoSource(song.source)) ? getRealSunoSourceLabel() : "none",
    songs: playlistSongs,
    totalDuration: playlistSongs.reduce((sum, s) => sum + parseDuration(s.duration), 0),
    openingSource
  };

  currentPlaylist = playlist;
  savePlaylistHistory({
    playlist,
    triggerType,
    openingSource,
    summary,
    energy,
    themeTags: preparedThemeTags,
    musicDirection,
    chatExcerpt: normalizedChatExcerpt
  });
  schedulePlaylistSongsLocalCache(currentPlaylist.songs);
  return playlist;
}

export function getPlaylist() {
  return currentPlaylist || createEmptyPlaylist();
}

function createEmptyPlaylist() {
  return {
    id: null,
    mood: null,
    prompt: null,
    generatedAt: null,
    source: "none",
    songs: [],
    totalDuration: 0,
    openingSource: "none"
  };
}

export async function getOpeningPlaylist() {
  const recentHistory = listRecentPlaylistHistory(OPENING_HISTORY_LIMIT, OPENING_HISTORY_LOOKBACK_DAYS);
  const openingFromHistory = buildOpeningPlaylistFromAllSongs(recentHistory);
  if (openingFromHistory) {
    schedulePlaylistSongsLocalCache(openingFromHistory.songs || []);
    currentPlaylist = openingFromHistory;
    return currentPlaylist;
  }

  const preferences = buildPreferenceProfile();
  const candidate = selectOpeningHistoryCandidate(recentHistory, preferences)
    || selectLatestPlayableHistory(recentHistory);

  if (candidate) {
    const playlistFromCandidate = materializeHistoricalPlaylist(candidate, "history");
    schedulePlaylistSongsLocalCache(candidate.songs || []);
    currentPlaylist = {
      ...playlistFromCandidate,
      songs: shuffleArray(playlistFromCandidate.songs || [])
    };
    return currentPlaylist;
  }

  currentPlaylist = createEmptyPlaylist();
  return currentPlaylist;
}

export function getPlaylistHistoryList(limit = 20) {
  return listRecentPlaylistHistory(limit);
}

export function getPlaylistHistoryDetail(id) {
  return getPlaylistHistoryById(id);
}

export function recordListenerEvent(input = {}) {
  const db = getDatabase();
  const eventType = String(input.eventType || "").trim() || "noop";
  const playlistId = typeof input.playlistId === "string" ? input.playlistId.trim().slice(0, 120) : "";
  const songId = typeof input.songId === "string" ? input.songId.trim().slice(0, 120) : "";
  const mood = typeof input.mood === "string" ? input.mood.trim().slice(0, 40) : "";
  const tags = uniqueStrings(Array.isArray(input.tags) ? input.tags : []).slice(0, 12);
  const messageExcerpt = typeof input.messageExcerpt === "string"
    ? input.messageExcerpt.trim().slice(0, 280)
    : "";
  const context = input.context && typeof input.context === "object" && !Array.isArray(input.context)
    ? input.context
    : {};

  try {
    db.prepare(`
      INSERT INTO listener_events (
        id,
        created_at,
        event_type,
        playlist_id,
        song_id,
        mood,
        tags_json,
        message_excerpt,
        context_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      new Date().toISOString(),
      eventType,
      playlistId || null,
      songId || null,
      mood || null,
      JSON.stringify(tags),
      messageExcerpt || null,
      JSON.stringify(context)
    );
  } catch (error) {
    console.warn("Failed to persist listener event:", error instanceof Error ? error.message : error);
    return {
      ok: false,
      stored: false,
      event: { eventType, playlistId, songId, mood, tags }
    };
  }

  return {
    ok: true,
    stored: true,
    event: {
      eventType,
      playlistId,
      songId,
      mood,
      tags
    }
  };
}

export function getRecentPreferenceTags(limit = 3) {
  const recentHistory = listRecentPlaylistHistory(10);
  const candidate = recentHistory.find((entry) => isUserTriggeredHistory(entry) && isRealSunoSource(entry.source) && entry.songs?.length)
    || recentHistory.find((entry) => isUserTriggeredHistory(entry) && entry.songs?.length)
    || recentHistory.find((entry) => entry.songs?.length);

  if (!candidate) return [];

  const tags = uniqueStrings([
    ...(candidate.themeTags || []),
    ...(candidate.musicDirection || []),
    ...((candidate.songs || []).flatMap((song) => Array.isArray(song.tags) ? song.tags.slice(0, 2) : []))
  ]);

  return tags.slice(0, limit);
}

function selectLatestPlayableHistory(histories) {
  const entries = Array.isArray(histories) ? histories : [];
  return entries.find((entry) => isUserTriggeredHistory(entry) && isRealSunoSource(entry.source) && entry.songs?.length)
    || entries.find((entry) => isUserTriggeredHistory(entry) && entry.songs?.length)
    || entries.find((entry) => isRealSunoSource(entry.source) && entry.songs?.length)
    || entries.find((entry) => entry.songs?.length)
    || null;
}

function buildOpeningPlaylistFromAllSongs(histories) {
  const entries = Array.isArray(histories) ? histories : [];
  if (!entries.length) return null;

  const uniqueSongs = [];
  const seen = new Set();

  for (const entry of entries) {
    for (const rawSong of entry?.songs || []) {
      const song = normalizeStoredSong(rawSong);
      const dedupKey = buildSongDedupKey(song);
      if (!dedupKey || seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      uniqueSongs.push(song);
    }
  }

  if (!uniqueSongs.length) return null;

  const shuffledSongs = shuffleArray(uniqueSongs);
  const playlistMood = entries[0]?.mood || inferMoodFromHour(new Date()) || "relaxed";
  const playlistPrompt = entries[0]?.prompt || "历史歌单随机播放";
  const playlistSource = shuffledSongs.some((song) => isRealSunoSource(song.source)) ? getRealSunoSourceLabel() : "history-all";

  return {
    id: `playlist-${Date.now()}`,
    mood: playlistMood,
    prompt: playlistPrompt,
    generatedAt: new Date().toISOString(),
    source: playlistSource,
    totalDuration: shuffledSongs.reduce((sum, song) => sum + parseDuration(song.duration), 0),
    openingSource: "history-all-random",
    songs: shuffledSongs
  };
}

function isUserTriggeredHistory(entry) {
  return entry?.triggerType === "mood_click"
    || entry?.triggerType === "chat_auto"
    || entry?.triggerType === "manual_api";
}

function materializeHistoricalPlaylist(historyEntry, openingSource = "history") {
  const songs = (historyEntry?.songs || []).map((song) => normalizeStoredSong(song));
  return {
    id: historyEntry.id,
    mood: historyEntry.mood,
    prompt: historyEntry.prompt,
    generatedAt: historyEntry.createdAt || new Date().toISOString(),
    source: historyEntry.source,
    totalDuration: songs.reduce((sum, song) => sum + parseDuration(song.duration), 0),
    openingSource,
    songs
  };
}

function buildPreferenceProfile() {
  const db = getDatabase();
  const events = db.prepare(`
    SELECT id, created_at, event_type, playlist_id, song_id, mood, tags_json, message_excerpt, context_json
    FROM listener_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(PREFERENCE_EVENT_LIMIT);

  const histories = listRecentPlaylistHistory(20);
  const moodScores = new Map();
  const tagScores = new Map();
  let preferredEnergy = "";
  let lastExplicitMood = "";
  const playlistSignals = new Map();

  for (const row of events) {
    const tags = parseJsonArray(row.tags_json);
    const context = parseJsonObject(row.context_json);
    const eventMood = row.mood || context.mood || "";

    if (row.event_type === "tag_click") {
      if (eventMood) addScore(moodScores, eventMood, 5);
      for (const tag of tags) addScore(tagScores, tag, 5);
      if (!lastExplicitMood && eventMood) lastExplicitMood = eventMood;
    }

    if (row.event_type === "chat_send") {
      if (eventMood) {
        addScore(moodScores, eventMood, 4);
        if (!lastExplicitMood) lastExplicitMood = eventMood;
      }
      for (const tag of tags) addScore(tagScores, tag, 2);
    }

    if (row.event_type === "song_end") {
      if (eventMood) addScore(moodScores, eventMood, 1);
      for (const tag of tags) addScore(tagScores, tag, 1);
    }

    if (row.event_type === "pause") {
      if (Number(context.playbackSeconds) < 30) {
        if (eventMood) addScore(moodScores, eventMood, -1);
        for (const tag of tags) addScore(tagScores, tag, -1);
      }
    }

    if (row.event_type === "skip_next") {
      if (eventMood) addScore(moodScores, eventMood, -2);
      for (const tag of tags) addScore(tagScores, tag, -2);
      if (row.playlist_id) {
        const signal = playlistSignals.get(row.playlist_id) || { skipCount: 0, songEndCount: 0, mood: eventMood, tags };
        signal.skipCount += 1;
        playlistSignals.set(row.playlist_id, signal);
      }
    }

    if (row.event_type === "song_end" && row.playlist_id) {
      const signal = playlistSignals.get(row.playlist_id) || { skipCount: 0, songEndCount: 0, mood: eventMood, tags };
      signal.songEndCount += 1;
      playlistSignals.set(row.playlist_id, signal);
    }

    if (!preferredEnergy && typeof context.energy === "string" && context.energy.trim()) {
      preferredEnergy = context.energy.trim();
    }
  }

  const latestSkipPairs = events
    .filter((row) => row.event_type === "skip_next" && row.playlist_id)
    .slice(0, 2);

  if (latestSkipPairs.length === 2 && latestSkipPairs[0].playlist_id === latestSkipPairs[1].playlist_id) {
    const mood = latestSkipPairs[0].mood || "";
    const tags = parseJsonArray(latestSkipPairs[0].tags_json);
    if (mood) addScore(moodScores, mood, -3);
    for (const tag of tags) addScore(tagScores, tag, -3);
  }

  for (const history of histories) {
    const signal = playlistSignals.get(history.id);
    if (signal?.songEndCount >= 2 && signal.skipCount === 0 && history.mood) {
      addScore(moodScores, history.mood, 3);
      for (const tag of history.themeTags || []) addScore(tagScores, tag, 2);
    }

    if (!signal && history.openingSource !== "none" && history.triggerType !== "opening_history") {
      addScore(moodScores, history.mood, 1);
      for (const tag of history.themeTags || []) addScore(tagScores, tag, 1);
    }

    if (!preferredEnergy && history.energy) {
      preferredEnergy = history.energy;
    }
  }

  return {
    preferredMood: topPositiveKey(moodScores),
    preferredTags: topPositiveKeys(tagScores, 6),
    preferredEnergy,
    lastExplicitMood,
    moodScores,
    tagScores
  };
}

function selectOpeningHistoryCandidate(histories, preferences) {
  if (!Array.isArray(histories) || histories.length === 0) return null;
  const ranked = rankOpeningHistories(histories, preferences);
  return ranked[0]?.score > 0 ? ranked[0].entry : null;
}

function rankOpeningHistories(histories, preferences) {
  if (!Array.isArray(histories) || histories.length === 0) return [];
  const hasRealHistory = histories.some((entry) => getRealPlayableRatio(entry) > 0);

  return histories
    .map((entry) => ({ entry, score: scoreOpeningHistory(entry, preferences, hasRealHistory) }))
    .sort((left, right) => right.score - left.score);
}

function scoreOpeningHistory(entry, preferences, hasRealHistory) {
  const ageHours = Math.max(0, (Date.now() - Date.parse(entry.createdAt)) / 36e5);
  const realPlayableRatio = getRealPlayableRatio(entry);
  const tagMatches = intersection(entry.themeTags || [], preferences.preferredTags);
  let score = Math.max(0, 72 - ageHours);

  score += Math.round(realPlayableRatio * 40);
  if (preferences.preferredMood && entry.mood === preferences.preferredMood) score += 18;
  if (preferences.lastExplicitMood && entry.mood === preferences.lastExplicitMood) score += 28;
  score += tagMatches.length * 6;

  if (entry.triggerType === "mood_click" || entry.triggerType === "chat_auto" || entry.triggerType === "manual_api") {
    score += 24;
  }

  if (entry.triggerType === "opening_generated") {
    score += 8;
  }

  if (entry.triggerType === "opening_history") {
    score -= 24;
  }

  if (hasRealHistory && realPlayableRatio === 0) {
    score -= 20;
  }

  if ((preferences.moodScores.get(entry.mood) || 0) < 0) {
    score -= 12;
  }

  return score;
}

function cloneHistoricalPlaylist(historyEntry, meta = {}) {
  const desiredCount = Math.max(Number(historyEntry?.songCount || historyEntry?.songs?.length || 1), 1);
  const songs = buildOpeningSongsFromHistoryPool(historyEntry, meta.historyPool || [historyEntry], desiredCount)
    .map((song) => normalizeStoredSong(song));
  return {
    id: `playlist-${Date.now()}`,
    mood: historyEntry.mood,
    prompt: historyEntry.prompt,
    generatedAt: new Date().toISOString(),
    source: historyEntry.source,
    totalDuration: songs.reduce((sum, song) => sum + parseDuration(song.duration), 0),
    openingSource: meta.openingSource || "history",
    songs
  };
}

function buildOpeningSongsFromHistoryPool(primaryEntry, historyPool = [], desiredCount = 1) {
  const primaryMood = primaryEntry?.mood || "";
  const otherEntries = historyPool.filter((entry) => entry?.id && entry.id !== primaryEntry?.id);
  const sameMoodEntries = otherEntries.filter((entry) => entry?.mood === primaryMood);
  const remainingEntries = otherEntries.filter((entry) => entry?.mood !== primaryMood);
  const pool = [primaryEntry, ...sameMoodEntries, ...remainingEntries];
  const uniqueSongs = [];
  const seen = new Set();

  for (const entry of pool) {
    for (const song of entry?.songs || []) {
      const key = buildSongDedupKey(song);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniqueSongs.push(song);
      if (uniqueSongs.length >= desiredCount) {
        return uniqueSongs;
      }
    }
  }

  return uniqueSongs;
}

function buildSongDedupKey(song) {
  const title = typeof song?.title === "string" ? song.title.trim().toLowerCase() : "";
  const artist = typeof song?.artist === "string" ? song.artist.trim().toLowerCase() : "";
  if (title) {
    return `title:${title}::${artist}`;
  }

  const audioUrl = typeof song?.audioUrl === "string" ? song.audioUrl.trim().toLowerCase() : "";
  if (audioUrl) {
    return `audio:${audioUrl}`;
  }

  const id = typeof song?.id === "string" ? song.id.trim().toLowerCase() : "";
  return id ? `id:${id}` : "";
}

function savePlaylistHistory({ playlist, triggerType, openingSource, summary, energy, themeTags, musicDirection, chatExcerpt }) {
  const db = getDatabase();
  const tags = uniqueStrings(themeTags);
  const directions = uniqueStrings(musicDirection);
  const excerpt = normalizeChatExcerpt(chatExcerpt);
  const persistedSongs = collectSongsForPersistence(playlist.songs || []);
  const persistedTotalDuration = persistedSongs.reduce((sum, song) => sum + parseDuration(song.duration), 0);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO playlist_history (
        id,
        created_at,
        trigger_type,
        opening_source,
        source,
        mood,
        prompt,
        summary,
        energy,
        theme_tags_json,
        music_direction_json,
        chat_excerpt_json,
        song_count,
        total_duration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      playlist.id,
      playlist.generatedAt,
      triggerType,
      openingSource,
      playlist.source,
      playlist.mood,
      playlist.prompt,
      summary || "",
      energy || "",
      JSON.stringify(tags),
      JSON.stringify(directions),
      JSON.stringify(excerpt),
      persistedSongs.length,
      persistedTotalDuration
    );

    const insertSong = db.prepare(`
      INSERT INTO playlist_songs (
        id,
        playlist_id,
        sort_index,
        song_id,
        title,
        artist,
        style,
        duration,
        mood,
        source,
        audio_url,
        tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [index, song] of persistedSongs.entries()) {
      const persistedAudioUrl = normalizePersistentAudioUrl(song);
      insertSong.run(
        crypto.randomUUID(),
        playlist.id,
        index,
        song.id,
        song.title,
        song.artist,
        song.style,
        song.duration,
        song.mood || playlist.mood,
        song.source || playlist.source,
        persistedAudioUrl,
        JSON.stringify(Array.isArray(song.tags) ? song.tags : [])
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    console.warn("Failed to persist playlist history:", error instanceof Error ? error.message : error);
  }
}

function collectSongsForPersistence(songs = []) {
  return (songs || [])
    .map((song) => normalizeStoredSong(song))
    .filter((song) => song?.id && song?.title && song?.source);
}

function resolveGeneratedAudioFilePath(audioUrl) {
  const raw = String(audioUrl || "").trim();
  if (!raw) return "";

  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname;
    } catch {
      return "";
    }
  }

  if (!pathname.startsWith("/api/audio/generated/")) {
    return "";
  }

  const encodedFilename = pathname.slice("/api/audio/generated/".length);
  if (!encodedFilename) return "";

  const filename = decodeURIComponent(encodedFilename);
  if (!/^[a-z0-9._-]+\.(mp3|wav)$/i.test(filename)) {
    return "";
  }

  const absoluteDir = path.resolve(generatedAudioDir);
  const absolutePath = path.resolve(path.join(generatedAudioDir, filename));
  if (!absolutePath.startsWith(`${absoluteDir}${path.sep}`)) {
    return "";
  }

  return absolutePath;
}

function listRecentPlaylistHistory(limit = 20, lookbackDays = null) {
  const db = getDatabase();
  const params = [];
  let sql = `
    SELECT
      id,
      created_at,
      trigger_type,
      opening_source,
      source,
      mood,
      prompt,
      summary,
      energy,
      theme_tags_json,
      music_direction_json,
      chat_excerpt_json,
      song_count,
      total_duration
    FROM playlist_history
  `;

  if (Number.isFinite(lookbackDays)) {
    sql += " WHERE created_at >= ? ";
    params.push(new Date(Date.now() - lookbackDays * 86400_000).toISOString());
  }

  sql += " ORDER BY created_at DESC LIMIT ? ";
  params.push(limit);

  return db.prepare(sql).all(...params).map((row) => hydratePlaylistHistoryRow(row));
}

function getPlaylistHistoryById(id) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      id,
      created_at,
      trigger_type,
      opening_source,
      source,
      mood,
      prompt,
      summary,
      energy,
      theme_tags_json,
      music_direction_json,
      chat_excerpt_json,
      song_count,
      total_duration
    FROM playlist_history
    WHERE id = ?
    LIMIT 1
  `).get(id);

  return row ? hydratePlaylistHistoryRow(row) : null;
}

function hydratePlaylistHistoryRow(row) {
  const db = getDatabase();
  const songs = db.prepare(`
    SELECT
      sort_index,
      song_id,
      title,
      artist,
      style,
      duration,
      mood,
      source,
      audio_url,
      tags_json
    FROM playlist_songs
    WHERE playlist_id = ?
    ORDER BY sort_index ASC
  `).all(row.id);

  return {
    id: row.id,
    createdAt: row.created_at,
    triggerType: row.trigger_type,
    openingSource: row.opening_source,
    source: row.source,
    mood: row.mood,
    prompt: row.prompt,
    summary: row.summary || "",
    energy: row.energy || "",
    themeTags: parseJsonArray(row.theme_tags_json),
    musicDirection: parseJsonArray(row.music_direction_json),
    chatExcerpt: parseJsonArray(row.chat_excerpt_json),
    songCount: row.song_count,
    totalDuration: row.total_duration,
    songs: songs.map((song) => normalizeStoredSong({
      id: song.song_id,
      title: song.title,
      artist: song.artist,
      style: song.style,
      duration: song.duration,
      mood: song.mood,
      source: song.source,
      audioUrl: song.audio_url || "",
      tags: parseJsonArray(song.tags_json)
    }))
  };
}

function normalizeListenerEvent(input) {
  const eventType = String(input.eventType || "").trim() || "app_open";
  const messageExcerpt = typeof input.messageExcerpt === "string" ? input.messageExcerpt.trim().slice(0, 280) : "";
  const context = input.context && typeof input.context === "object" ? input.context : {};
  const detectedMood = String(input.mood || "").trim() || String(context.mood || "").trim();

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    eventType,
    playlistId: typeof input.playlistId === "string" && input.playlistId.trim() ? input.playlistId.trim() : null,
    songId: typeof input.songId === "string" && input.songId.trim() ? input.songId.trim() : null,
    mood: detectedMood || null,
    tags: uniqueStrings(Array.isArray(input.tags) ? input.tags : Array.isArray(context.tags) ? context.tags : []),
    messageExcerpt,
    context
  };
}

function inferMoodFromHour(date) {
  const hour = date.getHours();
  if (hour >= 6 && hour <= 10) return "happy";
  if (hour >= 11 && hour <= 16) return "focused";
  if (hour >= 17 && hour <= 21) return "relaxed";
  if (hour >= 22 || hour <= 2) return "nostalgic";
  return "relaxed";
}

async function fetchSunoPlaylist(mood, prompt, count) {
  const deadline = Date.now() + SUNO_REQUEST_BUDGET_MS;
  const playlistSongs = [];
  const seen = new Set();

  if (Date.now() < deadline) {
    const batchPrompt = prompt;
    const createdTracks = await callSunoGenerate(batchPrompt);
    if (!Array.isArray(createdTracks) || createdTracks.length === 0) {
      throw new Error("Suno generate API 返回结果为空");
    }

    const readyTracks = await pollSunoTracks(createdTracks, count - playlistSongs.length, mood, deadline);
    for (const track of readyTracks) {
      if (!track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      if (!track.audioUrl) continue;
      playlistSongs.push(track);
      if (playlistSongs.length >= count) break;
    }
  }

  return playlistSongs;
}

async function callSunoGenerate(prompt) {
  return generateSunoTracks(prompt);
}

async function pollSunoTracks(createdTracks, neededCount, mood, deadline = Number.POSITIVE_INFINITY) {
  const allTracks = createdTracks
    .filter((track) => typeof track?.id === "string" && track.id.trim())
    .map((track) => normalizeSunoTrack(track, mood));

  if (allTracks.length === 0) return [];

  const targetReadyCount = Math.min(allTracks.length, neededCount);
  let pendingIds = allTracks.filter((track) => !track.audioUrl).map((track) => track.id).filter(Boolean);
  let rounds = 0;
  const erroredIds = new Set();

  while (
    pendingIds.length > 0 &&
    rounds < SUNO_POLL_MAX_RETRIES &&
    allTracks.filter((track) => track.audioUrl).length < targetReadyCount &&
    Date.now() < deadline
  ) {
    const detailList = await getSunoTracks(pendingIds);
    const detailMap = new Map(Array.isArray(detailList) ? detailList.filter((item) => item?.id).map((item) => [item.id, item]) : []);

    for (const track of allTracks) {
      if (!track.id) continue;
      const detail = detailMap.get(track.id);
      if (!detail) continue;
      if (detail.audio_url) {
        track.audioUrl = detail.audio_url;
        track.remoteAudioUrl = detail.audio_url;
      }
      if (detail.status) track.status = detail.status;
      if (detail.tags && track.tags.length === 0) track.tags = normalizeTagList(detail.tags);
      if (detail.title) track.title = detail.title;
      if (detail.status === "error") erroredIds.add(track.id);
    }

    pendingIds = allTracks
      .filter((track) => !track.audioUrl && track.id && !erroredIds.has(track.id))
      .map((track) => track.id);

    if (pendingIds.length > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(SUNO_POLL_INTERVAL_MS, remainingMs));
      rounds += 1;
    }
  }

  return allTracks;
}

function normalizeSunoTrack(track, mood) {
  const normalizedTags = normalizeTagList(track?.tags);
  const remoteAudioUrl = sanitizeAudioUrl(track?.audio_url);
  return {
    id: String(track?.id || `suno-track-${crypto.randomBytes(4).toString("hex")}`),
    title: track?.title || "Suno Track",
    artist: "Suno AI",
    style: normalizedTags[0] || mood || "ambient",
    duration: track?.duration || "3:30",
    tags: normalizedTags,
    mood: mood || "relaxed",
    generatedAt: new Date().toISOString(),
    source: getRealSunoSourceLabel(),
    status: typeof track?.status === "string" ? track.status : "",
    audioUrl: remoteAudioUrl,
    remoteAudioUrl
  };
}

function normalizeTagList(tags) {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

function sanitizeAudioUrl(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : "";
}

function isCompleteSunoAudioFileUrl(url) {
  const text = sanitizeAudioUrl(url);
  if (!text) return false;
  return /^https?:\/\/cdn\d*\.suno\.ai\//i.test(text) || /\.mp3(?:[?#].*)?$/i.test(text);
}

function normalizePlayableAudioUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  const trimmed = url.trim();
  if (trimmed.startsWith("/api/audio/generated/")) return trimmed;
  return trimmed;
}

function normalizePersistentAudioUrl(song) {
  if (!song || !isRealSunoSource(song.source)) {
    return typeof song?.audioUrl === "string" ? song.audioUrl.trim() : "";
  }

  const generatedUrl = normalizeGeneratedAudioUrl(song.audioUrl || "");
  if (generatedUrl) return generatedUrl;

  const safeId = getSafeSongId(song.id);
  const existing = findCachedSongFilename(safeId);
  return existing ? `/api/audio/generated/${encodeURIComponent(existing)}` : "";
}

function normalizeGeneratedAudioUrl(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  return trimmed.startsWith("/api/audio/generated/") ? trimmed : "";
}

function intersection(left, right) {
  const rightSet = new Set((right || []).map((value) => String(value).trim()).filter(Boolean));
  return (left || []).map((value) => String(value).trim()).filter((value) => value && rightSet.has(value));
}

function addScore(map, key, delta) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + delta);
}

function topPositiveKey(map) {
  return [...map.entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function topPositiveKeys(map, limit = 5) {
  return [...map.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

function getRealPlayableRatio(historyEntry) {
  if (!historyEntry?.songs?.length) return 0;
  const realSongs = historyEntry.songs.filter((song) => isRealSunoSource(song.source) && song.audioUrl);
  return realSongs.length / historyEntry.songs.length;
}

function normalizeChatExcerpt(chatExcerpt) {
  if (!Array.isArray(chatExcerpt)) return [];
  return chatExcerpt
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-6)
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, 280)
    }));
}

function parseDuration(duration) {
  if (typeof duration !== "string") return 180;
  const parts = duration.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 180;
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
}

function preparePlaylistSongsForPlayback(songs) {
  return (songs || []).map((song) => normalizeStoredSong(song));
}

function schedulePlaylistSongsLocalCache(songs) {
  for (const song of songs || []) {
    scheduleSongAudioCache(song);
  }
}

export function schedulePendingSunoAudioCache(limit = 80) {
  const db = getDatabase();
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT DISTINCT song_id, source
      FROM playlist_songs
      WHERE source IN ('suno-official', 'suno-api')
        AND song_id IS NOT NULL
        AND TRIM(song_id) != ''
        AND (audio_url IS NULL OR TRIM(audio_url) = '')
      ORDER BY rowid DESC
      LIMIT ?
    `).all(Math.max(1, Number(limit) || 80));
  } catch (error) {
    console.warn("Failed to scan pending Suno audio cache rows:", error instanceof Error ? error.message : error);
    return 0;
  }

  for (const row of rows) {
    scheduleSongAudioCache({
      id: row.song_id,
      source: row.source || getRealSunoSourceLabel(),
      remoteAudioUrl: `https://audiopipe.suno.ai/?item_id=${encodeURIComponent(row.song_id)}`
    });
  }

  return rows.length;
}

function normalizeStoredSong(song) {
  if (!song || !isRealSunoSource(song.source)) {
    return song;
  }

  const safeId = getSafeSongId(song.id);
  const existing = findCachedSongFilename(safeId);
  if (existing) {
    return {
      ...song,
      audioUrl: `/api/audio/generated/${encodeURIComponent(existing)}`
    };
  }

  return {
    ...song,
    remoteAudioUrl: sanitizeAudioUrl(song.remoteAudioUrl || song.audioUrl || ""),
    audioUrl: normalizePlayableAudioUrl(song.audioUrl || "")
  };
}

function scheduleSongAudioCache(song) {
  if (!song || !isRealSunoSource(song.source)) {
    return;
  }

  const remoteAudioUrl = sanitizeAudioUrl(song.remoteAudioUrl || song.audioUrl || "");
  if (!/^https?:\/\//i.test(remoteAudioUrl)) {
    return;
  }

  const safeId = getSafeSongId(song.id);
  const existing = findCachedSongFilename(safeId);
  if (existing) {
    syncCachedSongUrl(song.id, `/api/audio/generated/${encodeURIComponent(existing)}`);
    return;
  }

  if (backgroundAudioCacheJobs.has(song.id)) {
    return;
  }

  const job = cacheSongAudioWhenReady(song)
    .catch((error) => {
      console.warn("Background song cache failed:", error instanceof Error ? error.message : error);
    })
    .finally(() => {
      backgroundAudioCacheJobs.delete(song.id);
    });

  backgroundAudioCacheJobs.set(song.id, job);
}

async function cacheSongAudioWhenReady(song) {
  const readyUrl = await waitForSunoTrackAudioReady(song);
  if (!readyUrl) {
    throw new Error(`suno audio did not complete before cache timeout: ${song?.id || "unknown"}`);
  }
  return cacheSongAudioLocally(song.id, readyUrl);
}

async function waitForSunoTrackAudioReady(song) {
  const songId = String(song?.id || "").trim();
  if (!songId) {
    return "";
  }

  for (let round = 0; round < SUNO_POLL_MAX_RETRIES; round += 1) {
    let detailList;
    try {
      detailList = await getSunoTracks([songId]);
    } catch (error) {
      if (round === SUNO_POLL_MAX_RETRIES - 1) {
        throw error;
      }
      await sleep(SUNO_POLL_INTERVAL_MS);
      continue;
    }

    const detail = Array.isArray(detailList) ? detailList.find((item) => item?.id === songId) : null;
    const status = typeof detail?.status === "string" ? detail.status.toLowerCase() : "";
    const detailAudioUrl = sanitizeAudioUrl(detail?.audio_url || "");

    if (status === "complete" && isCompleteSunoAudioFileUrl(detailAudioUrl)) {
      return detailAudioUrl;
    }

    if (status === "error") {
      throw new Error(`suno track errored before local cache: ${songId}`);
    }

    await sleep(SUNO_POLL_INTERVAL_MS);
  }

  return "";
}

async function cacheSongAudioLocally(songId, remoteAudioUrl) {
  const safeId = getSafeSongId(songId);
  const existing = findCachedSongFilename(safeId);
  if (existing) {
    const localAudioUrl = `/api/audio/generated/${encodeURIComponent(existing)}`;
    syncCachedSongUrl(songId, localAudioUrl);
    return localAudioUrl;
  }

  try {
    fs.mkdirSync(generatedAudioDir, { recursive: true });
    const { buffer, contentType } = await downloadAudioBufferDirect(remoteAudioUrl);
    if (!buffer.length) {
      throw new Error("empty audio payload");
    }
    const extension = contentType.includes("wav") ? "wav" : "mp3";
    const filename = `track-${safeId}.${extension}`;
    const outputPath = path.join(generatedAudioDir, filename);
    fs.writeFileSync(outputPath, buffer);
    const localAudioUrl = `/api/audio/generated/${encodeURIComponent(filename)}`;
    syncCachedSongUrl(songId, localAudioUrl);
    return localAudioUrl;
  } catch (error) {
    throw error;
  }
}

function findCachedSongFilename(safeId) {
  for (const extension of ["mp3", "wav"]) {
    const filename = `track-${safeId}.${extension}`;
    const filepath = path.join(generatedAudioDir, filename);
    if (fs.existsSync(filepath) && fs.statSync(filepath).size > 0) {
      return filename;
    }
  }
  return "";
}

function getSafeSongId(songId) {
  return String(songId || "").replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 120) || crypto.randomUUID();
}

function syncCachedSongUrl(songId, localAudioUrl) {
  if (!songId || !localAudioUrl) return;

  const db = getDatabase();
  try {
    db.prepare(`
      UPDATE playlist_songs
      SET audio_url = ?
      WHERE song_id = ?
    `).run(localAudioUrl, songId);
  } catch (error) {
    console.warn("Failed to sync cached song url to database:", error instanceof Error ? error.message : error);
  }

  if (currentPlaylist?.songs?.length) {
    let changed = false;
    currentPlaylist.songs = currentPlaylist.songs.map((song) => {
      if (song.id !== songId) return song;
      changed = true;
      return {
        ...song,
        audioUrl: localAudioUrl
      };
    });
  }
}

function downloadAudioBufferDirect(audioUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    const cleanup = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const refreshIdleTimer = (req) => {
      cleanup();
      idleTimer = setTimeout(() => {
        req.destroy(new Error("audio download idle timeout"));
      }, GENERATED_AUDIO_DOWNLOAD_IDLE_TIMEOUT_MS);
    };

    const req = https.get(audioUrl, {
      headers: {
        Accept: "audio/*,*/*;q=0.8",
        Origin: "https://suno.com",
        Referer: "https://suno.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
      },
      timeout: GENERATED_AUDIO_DOWNLOAD_TIMEOUT_MS
    }, (res) => {
      if ((res.statusCode || 0) >= 400) {
        res.resume();
        finishError(new Error(`audio download failed: ${res.statusCode}`));
        return;
      }

      const chunks = [];
      refreshIdleTimer(req);
      res.on("data", (chunk) => {
        chunks.push(chunk);
        refreshIdleTimer(req);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: String(res.headers["content-type"] || "")
        });
      });
      res.on("error", finishError);
    });

    req.setTimeout(GENERATED_AUDIO_DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error("audio download timeout"));
    });
    req.on("error", finishError);
  });
}
