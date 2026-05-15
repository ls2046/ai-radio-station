"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useMobileViewportLayout } from "../hooks/useMobileViewportLayout";
import {
  generatePlaylist,
  generatePlaylistFromConversation,
  getOpeningPlaylist,
  getPlaylistHistory,
  recordListenerEvent,
  requestHostDecision,
  generateHostVoice,
  getMusicAudioUrl,
  getApiBase,
} from "../lib/api";
import {
  Radio,
  Send,
  Music,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Headphones,
  ListMusic,
  User,
  Bot,
  RefreshCw,
  Disc3,
  X,
  Sun,
  Leaf,
  Target,
  Zap,
  Heart,
  Moon,
  Clock3,
  PartyPopper,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ===== Types =====
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface Song {
  id: string;
  title: string;
  artist: string;
  style: string;
  duration: string;
  tags: string[];
  mood: string;
  audioUrl?: string | null;
}

interface Playlist {
  id: string;
  mood: string;
  prompt: string;
  generatedAt?: string;
  songs: Song[];
  source: string;
}

interface PlaylistHistoryItem {
  id: string;
  createdAt?: string;
  mood?: string;
  source?: string;
  songs?: Partial<Song>[];
}

interface SongLibraryItem {
  key: string;
  song: Song;
  playlistId: string;
  createdAt: string;
  playlistMood: string;
}

interface MoodOption {
  key: keyof typeof moodLabels;
  label: string;
  icon: LucideIcon;
}

type MoodKey = keyof typeof moodLabels;
type HostDynamicEvent = "song_change" | "user_speak" | "proactive";

const CHAT_HISTORY_STORAGE_KEY = "aura-radio-chat-history-v2";
const PLAYER_PREFS_STORAGE_KEY = "aura-radio-player-prefs";
const HOST_SESSION_STORAGE_KEY = "aura-radio-host-session-id";
const DEFAULT_PLAYBACK_VOLUME = 0.7;
const REAL_AUDIO_READY_TIMEOUT_MS = 12000;
const MOCK_MUSIC_ROUTE_RE = /\/api\/audio\/music\//i;
const DJ_ANALYSIS_HISTORY_LIMIT = 12;
const HOST_TOPIC_MIN_PLAY_MS = 25000;
const HOST_MIDDLE_MIN_PLAY_MS = 30000;
const HOST_NEAR_END_TRIGGER_SECONDS = 12;
const HOST_TRACK_START_BROADCAST_DELAY_MS = 1200;
const OPENING_TRACK_AI_INTRO_DELAY_MS = 20000;
const HOST_TRIGGER_DEBOUNCE_MS = 8000;
const USER_SKIP_HOST_SUPPRESS_MS = 5000;
const LOCAL_HOST_FALLBACK_DEDUPE_MS = 15000;
const SUNO_PASSIVE_GENERATION_COOLDOWN_MS = 15 * 60 * 1000;
const SUNO_EXPLICIT_GENERATION_COOLDOWN_MS = 2 * 60 * 1000;
const USER_SPEAK_GENERATE_SONG_GUARD_MS = 2 * 60 * 1000;
const LOCAL_MATCH_SCORE_THRESHOLD = 6;
const RECENT_NEGATIVE_FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const RECENT_NEGATIVE_FEEDBACK_THRESHOLD = 2;
const SHORT_PAUSE_NEGATIVE_SECONDS = 18;
const MAX_RECENT_SIGNAL_COUNT = 40;
const HOST_PROMPT_LEAK_RE = /用户要求我|当前情境|现在需要|作为AI电台主播|当前歌曲[:：]|下一首[:：]|最近对话[:：]|请直接给我/i;
// Toggle this back to `false` when we want to pause the homepage intro voiceover again.
const AUTO_OPENING_VOICE_ENABLED = true;
// Toggle this back to `false` when we want to pause background host timers again.
const AUTO_SCHEDULED_HOST_TASKS_ENABLED = true;
let sharedAnalyzerAudioCtx: AudioContext | null = null;
const mediaSourceNodeCache = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const mediaOutputGainNodeCache = new WeakMap<HTMLMediaElement, GainNode>();
const moodLabels = {
  happy: "开心",
  relaxed: "放松",
  focused: "专注",
  energetic: "活力",
  romantic: "浪漫",
  sad: "安静",
  nostalgic: "怀旧",
  party: "派对",
};

const moodSceneBriefs: Record<string, { scene: string; sound: string }> = {
  happy: {
    scene: "像心情突然变轻，阳光落在身上，脚步和呼吸都慢慢亮起来",
    sound: "明亮流行、轻快律动、温暖人声，旋律要有记忆点"
  },
  relaxed: {
    scene: "像下班后终于坐下来，灯光变软，整个人从紧绷里松开",
    sound: "中慢速、柔和吉他或电钢琴、空气感人声"
  },
  focused: {
    scene: "像进入专注状态，桌面安静，思绪被一点点整理清楚",
    sound: "稳定律动、低干扰旋律、克制的人声或轻电子质感"
  },
  energetic: {
    scene: "像重新打起精神出门，脚步变快，身体里有一股往前冲的劲",
    sound: "有弹性的鼓点、明亮合成器或吉他、上扬副歌"
  },
  romantic: {
    scene: "像傍晚街灯刚亮，两个人慢慢靠近，话不多但心意很明显",
    sound: "温柔 R&B 或抒情流行、细腻和声、亲密的人声距离"
  },
  sad: {
    scene: "像一个人终于不用强撑，情绪安静落下来，眼泪可以慢慢流出来",
    sound: "安静慢歌、钢琴或清淡吉他、低声线人声，留出呼吸感"
  },
  nostalgic: {
    scene: "像翻到旧照片或走过熟悉的路，过去的事轻轻浮上来",
    sound: "复古流行、温暖磁带感、柔软鼓组和有年代感的旋律"
  },
  party: {
    scene: "像朋友聚在一起，灯光亮起来，气氛自然升温",
    sound: "跳舞流行、清晰鼓点、抓耳 hook，适合跟着点头"
  }
};

function buildPlaylistGenerationPrompt(mood: string, summary: string, musicDirection: string[] = []) {
  const label = moodLabels[mood as keyof typeof moodLabels] || mood;
  const brief = moodSceneBriefs[mood] || moodSceneBriefs.relaxed;
  const directions = musicDirection.filter((item) => item && item !== label && item !== mood).slice(0, 3);
  const creativeSummary = String(summary || "").trim() || `听众想听一首带有${label}氛围的歌`;
  return [
    `请生成一首中文原创歌曲，核心情境：${creativeSummary}。`,
    `画面感：${brief.scene}。`,
    `音乐方向：${directions.length ? `${directions.join("、")}；` : ""}${brief.sound}。`,
    "歌词要有具体画面和情绪推进；如果核心情境里包含用户点歌、生成、换歌等操作话术，请理解为创作意图，不要把操作原句写进歌词。"
  ].join("\n");
}

function normalizeMoodMatcherText(value: string) {
  return String(value || "").trim().toLowerCase();
}

function buildLocalOpeningFallback(
  dayPart: string,
  currentTrack?: Pick<Song, "title"> | null,
  _nextTrack?: Pick<Song, "title"> | null
) {
  const trackPart = currentTrack?.title
    ? `现在先从《${currentTrack.title}》开始。`
    : "先给你留一段呼吸感，我们慢慢把状态找回来。";
  return `${dayPart}好，这里是 R-Studio。${trackPart}你不用着急表达，我会顺着音乐一直陪你听。`;
}

function mapLegacyEventToDynamic(event: string): HostDynamicEvent | null {
  if (!event) return null;
  if (event === "song_change" || event === "user_speak" || event === "proactive") return event;
  if (event === "listener_message") return "user_speak";
  if (event === "page_opened") return "song_change";
  if (event === "track_changed" || event === "track_started" || event === "playlist_generated") return "song_change";
  if (event === "scheduled_check" || event === "idle_gap") return "proactive";
  return null;
}

function buildLocalHostFallbackByEvent(
  event: HostDynamicEvent,
  payload: {
    currentTrack?: Song | null;
    nextTrack?: Song | null;
    recentUserLine?: string;
  }
) {
  if (event === "user_speak") {
    if (payload.recentUserLine) {
      return "我听到你这句了，我们先顺着这个感觉继续。音乐我会轻轻托着，你想到什么再告诉我就好。";
    }
    return "我在这儿，你不用赶时间。先听一会儿，等你想说的时候我接着你。";
  }
  if (event === "proactive") {
    const currentTitle = payload.currentTrack?.title ? `《${payload.currentTrack.title}》` : "这首歌";
    const nextTitle = payload.nextTrack?.title ? `，下一首会接《${payload.nextTrack.title}》` : "";
    return `这会儿的氛围挺稳，我先陪你把这段听完。现在播到${currentTitle}${nextTitle}，你就安心待在这里。`;
  }
  const currentTitle = payload.currentTrack?.title ? `《${payload.currentTrack.title}》` : "这首";
  return `我们继续听${currentTitle}。我把节奏放轻一点，陪你把这一段完整走完。`;
}

// ===== Clock Hook =====
function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (!now) {
    return { time: "--:--:--", date: "----------" };
  }
  const dateLabel = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekdayLabel = now.toLocaleDateString("zh-CN", { weekday: "short" });
  return {
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    date: `${dateLabel} ${weekdayLabel}`,
  };
}

function parseDurationToSeconds(duration?: string | null) {
  if (!duration) return 0;
  const parts = duration.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }
  return parts[0] || 0;
}

function formatDurationLabel(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ===== Header Icon =====
function PixelPet({ animate = false }: { animate?: boolean }) {
  return (
    <img
      src="/aura-host-avatar.png"
      alt="R-Studio icon"
      className={`station-header-icon ${animate ? "is-animated" : ""}`}
    />
  );
}

// ===== Dot Matrix Logo =====
function DotMatrixLogo() {
  return (
    <span className="dot-matrix station-brand-text">
      R-STUDIO
    </span>
  );
}

// ===== Equalizer Visualization =====
function getSharedAnalyzerAudioContext() {
  if (!sharedAnalyzerAudioCtx) {
    const webkitAudioContext = (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const AudioContextCtor = window.AudioContext || webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("Web Audio API is not available in this browser.");
    }
    sharedAnalyzerAudioCtx = new AudioContextCtor();
  }
  return sharedAnalyzerAudioCtx;
}

function getMediaSourceNode(audio: HTMLMediaElement, audioCtx: AudioContext) {
  const cached = mediaSourceNodeCache.get(audio);
  if (cached) return cached;
  const node = audioCtx.createMediaElementSource(audio);
  mediaSourceNodeCache.set(audio, node);
  return node;
}

function getMediaOutputGainNode(audio: HTMLMediaElement, audioCtx: AudioContext) {
  const cached = mediaOutputGainNodeCache.get(audio);
  if (cached) return cached;

  const sourceNode = getMediaSourceNode(audio, audioCtx);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 1;
  sourceNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  mediaOutputGainNodeCache.set(audio, gainNode);
  return gainNode;
}

function setMediaOutputGain(audio: HTMLMediaElement, gain: number, rampSeconds = 0.08) {
  if (typeof window === "undefined") return false;

  try {
    const audioCtx = getSharedAnalyzerAudioContext();
    const gainNode = getMediaOutputGainNode(audio, audioCtx);
    if (audioCtx.state === "suspended") {
      void audioCtx.resume().catch(() => {});
    }

    const nextGain = Math.max(0, Math.min(1, gain));
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(nextGain, now + rampSeconds);
    return true;
  } catch (error) {
    console.warn("Unable to apply Web Audio gain.", error);
    return false;
  }
}

function Equalizer({
  active,
  musicAudioRef,
  hostAudioRef,
}: {
  active: boolean;
  musicAudioRef: { current: HTMLAudioElement | null };
  hostAudioRef: { current: HTMLAudioElement | null };
}) {
  const eqWrapRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const analysisRef = useRef<{
    music: { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null;
    host: { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null;
  }>({ music: null, host: null });
  const [activeSource, setActiveSource] = useState<"idle" | "music" | "host">(active ? "music" : "idle");

  const applyBarLevels = useCallback((levels: number[]) => {
    const wrap = eqWrapRef.current;
    if (!wrap) return;
    levels.forEach((level, index) => {
      wrap.style.setProperty(`--eq-bar-${index + 1}-height`, `${level}px`);
    });
  }, []);

  useEffect(() => {
    const musicAudio = musicAudioRef.current;
    const hostAudio = hostAudioRef.current;
    if (!musicAudio || !hostAudio || analysisRef.current.music || analysisRef.current.host) return;

    const audioCtx = getSharedAnalyzerAudioContext();
    const createAnalysisNode = (audio: HTMLMediaElement) => {
      const sourceNode = getMediaSourceNode(audio, audioCtx);
      getMediaOutputGainNode(audio, audioCtx);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -12;
      analyser.smoothingTimeConstant = 0.68;
      sourceNode.connect(analyser);
      return {
        analyser,
        data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)) as Uint8Array<ArrayBuffer>,
      };
    };

    analysisRef.current = {
      music: createAnalysisNode(musicAudio),
      host: createAnalysisNode(hostAudio),
    };

    const resumeAnalysis = async () => {
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
    };

    musicAudio.addEventListener("play", resumeAnalysis);
    hostAudio.addEventListener("play", resumeAnalysis);
    if (!musicAudio.paused || !hostAudio.paused) {
      void resumeAnalysis();
    }

    return () => {
      musicAudio.removeEventListener("play", resumeAnalysis);
      hostAudio.removeEventListener("play", resumeAnalysis);
      analysisRef.current = { music: null, host: null };
    };
  }, [hostAudioRef, musicAudioRef]);

  useEffect(() => {
    const baseHeights = [8, 14, 20, 24, 16, 10];
    const maxExtraHeights = [14, 16, 18, 18, 16, 14];

    const computeLevels = (data: Uint8Array) => {
      const ranges: Array<[number, number]> = [
        [1, 3],
        [3, 7],
        [7, 13],
        [13, 20],
        [20, 28],
        [28, 40],
      ];

      return ranges.map(([start, end], index) => {
        let total = 0;
        let count = 0;
        for (let i = start; i < end && i < data.length; i += 1) {
          total += data[i];
          count += 1;
        }
        const normalized = count ? Math.min(1, ((total / count) / 255) * 1.8) : 0;
        return baseHeights[index] + (normalized * maxExtraHeights[index]);
      });
    };

    const renderFrame = () => {
      const currentAnalysis = activeSource === "host"
        ? analysisRef.current.host
        : activeSource === "music"
          ? analysisRef.current.music
          : null;

      if (!currentAnalysis) {
        applyBarLevels(baseHeights);
      } else {
        currentAnalysis.analyser.getByteFrequencyData(currentAnalysis.data);
        applyBarLevels(computeLevels(currentAnalysis.data));
      }

      animationFrameRef.current = window.requestAnimationFrame(renderFrame);
    };

    renderFrame();

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [activeSource, applyBarLevels]);

  useEffect(() => {
    const syncActiveSource = () => {
      const hostAudio = hostAudioRef.current;
      const musicAudio = musicAudioRef.current;

      if (hostAudio && !hostAudio.paused && !hostAudio.ended) {
        setActiveSource("host");
        return;
      }
      if (musicAudio && !musicAudio.paused && !musicAudio.ended) {
        setActiveSource("music");
        return;
      }
      setActiveSource(active ? "music" : "idle");
    };

    const hostAudio = hostAudioRef.current;
    const musicAudio = musicAudioRef.current;
    if (!hostAudio || !musicAudio) return;

    syncActiveSource();
    const events: Array<keyof HTMLMediaElementEventMap> = ["play", "pause", "ended", "emptied", "stalled"];
    for (const eventName of events) {
      hostAudio.addEventListener(eventName, syncActiveSource);
      musicAudio.addEventListener(eventName, syncActiveSource);
    }

    return () => {
      for (const eventName of events) {
        hostAudio.removeEventListener(eventName, syncActiveSource);
        musicAudio.removeEventListener(eventName, syncActiveSource);
      }
    };
  }, [active, hostAudioRef, musicAudioRef]);

  return (
    <div
      ref={eqWrapRef}
      className={`eq-wrap ${activeSource !== "idle" ? "is-active" : ""}`}
      aria-hidden="true"
    >
      <span className="eq-bar eq-bar-1" />
      <span className="eq-bar eq-bar-2" />
      <span className="eq-bar eq-bar-3" />
      <span className="eq-bar eq-bar-4" />
      <span className="eq-bar eq-bar-5" />
      <span className="eq-bar eq-bar-6" />
    </div>
  );
}

function sanitizeVisibleChatHistory(history: ChatMessage[]) {
  return history.filter((item) => {
    if (item.role !== "assistant") return true;
    return !HOST_PROMPT_LEAK_RE.test(item.content);
  });
}

function preventDefaultIfPossible(event: { cancelable?: boolean; preventDefault: () => void }) {
  if (event.cancelable) {
    event.preventDefault();
  }
}

export function RadioStation() {
  const clock = useClock();
  useMobileViewportLayout();
  const moodStripRef = useRef<HTMLDivElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hostAudioRef = useRef<HTMLAudioElement | null>(null);

  // ===== State =====
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isChatting, setIsChatting] = useState(false);

  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [activeMoodKey, setActiveMoodKey] = useState<MoodKey | null>(null);
  const [currentSongIndex, setCurrentSongIndex] = useState(0);
  const [isGeneratingPlaylist, setIsGeneratingPlaylist] = useState(false);
  const [allSongsLibrary, setAllSongsLibrary] = useState<SongLibraryItem[]>([]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);

  const [isGeneratingVoice, setIsGeneratingVoice] = useState(false);
  const [isHostSpeaking, setIsHostSpeaking] = useState(false);

  const [showPlaylistPanel, setShowPlaylistPanel] = useState(false);

  const autoGenerateInFlightRef = useRef(false);
  const pendingAutoHistoryRef = useRef<ChatMessage[] | null>(null);
  const lastAutoGenerateSignatureRef = useRef("");
  const songStartTimeRef = useRef<number>(0);
  const playlistRef = useRef<Playlist | null>(null);
	  const currentSongIndexRef = useRef<number>(0);
	  const playbackRequestIdRef = useRef(0);
	  const pendingAutoplayRef = useRef(false);
  const pendingHostVoiceAutoplayRef = useRef(false);
  const openingVoicePlayedRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const chatHistoryRef = useRef<ChatMessage[]>(chatHistory);
  const isPlayingRef = useRef(false);
  const isGeneratingVoiceRef = useRef(false);
  const hostDecisionInFlightRef = useRef(false);
  const lastHostTriggerStartedAtRef = useRef(0);
  const playbackStartHostKeyRef = useRef("");
  const openingTrackStartHostKeyRef = useRef("");
  const openingTrackStartTimerRef = useRef<number | null>(null);
  const middleHostKeyRef = useRef("");
  const nearEndHostKeyRef = useRef("");
  const lastUserInteractionAtRef = useRef(Date.now());
  const musicVolumeBeforeHostVoiceRef = useRef(DEFAULT_PLAYBACK_VOLUME);
  const hostSessionIdRef = useRef("default");
  const lastLocalFallbackRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const lastSunoGenerationAtRef = useRef(0);
  const isGeneratingPlaylistRef = useRef(false);
  const suppressTrackChangedHostRef = useRef<{ trackId: string; until: number } | null>(null);
  const userSkipHostTimerRef = useRef<number | null>(null);
  const allSongsLibraryRef = useRef<SongLibraryItem[]>([]);
  const recentListenerSignalsRef = useRef<Array<{
    eventType: string;
    at: number;
    mood?: string;
    playlistId?: string;
    playbackSeconds?: number;
  }>>([]);

  const [playbackProgressPercent, setPlaybackProgressPercent] = useState(0);
  const [playbackCurrentTime, setPlaybackCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const isSeekingRef = useRef(false);
  const progressPointerIdRef = useRef<number | null>(null);
  const progressTouchIdRef = useRef<number | null>(null);

  useEffect(() => { chatHistoryRef.current = chatHistory; }, [chatHistory]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { isGeneratingPlaylistRef.current = isGeneratingPlaylist; }, [isGeneratingPlaylist]);
  useEffect(() => { isGeneratingVoiceRef.current = isGeneratingVoice; }, [isGeneratingVoice]);
  useEffect(() => { playlistRef.current = playlist; }, [playlist]);
  useEffect(() => { currentSongIndexRef.current = currentSongIndex; }, [currentSongIndex]);
  useEffect(() => { allSongsLibraryRef.current = allSongsLibrary; }, [allSongsLibrary]);
  useEffect(() => {
    const nextMood = playlist?.mood;
    if (nextMood && nextMood in moodLabels) {
      setActiveMoodKey(nextMood as MoodKey);
    }
  }, [playlist?.mood]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const syncPlaybackProgress = () => {
      if (isSeekingRef.current) return;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : parseDurationToSeconds(playlistRef.current?.songs?.[currentSongIndexRef.current]?.duration);
      const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      setPlaybackCurrentTime(currentTime);
      if (duration > 0) {
        setPlaybackProgressPercent(Math.min(100, Math.max(0, (currentTime / duration) * 100)));
      } else {
        setPlaybackProgressPercent(0);
      }
    };

    const resetPlaybackProgress = () => {
      setPlaybackCurrentTime(0);
      setPlaybackProgressPercent(0);
    };

    syncPlaybackProgress();
    audio.addEventListener("timeupdate", syncPlaybackProgress);
    audio.addEventListener("durationchange", syncPlaybackProgress);
    audio.addEventListener("loadedmetadata", syncPlaybackProgress);
    audio.addEventListener("loadeddata", syncPlaybackProgress);
    audio.addEventListener("seeking", syncPlaybackProgress);
    audio.addEventListener("emptied", resetPlaybackProgress);
    audio.addEventListener("ended", resetPlaybackProgress);

    return () => {
      audio.removeEventListener("timeupdate", syncPlaybackProgress);
      audio.removeEventListener("durationchange", syncPlaybackProgress);
      audio.removeEventListener("loadedmetadata", syncPlaybackProgress);
      audio.removeEventListener("loadeddata", syncPlaybackProgress);
      audio.removeEventListener("seeking", syncPlaybackProgress);
      audio.removeEventListener("emptied", resetPlaybackProgress);
      audio.removeEventListener("ended", resetPlaybackProgress);
    };
  }, [currentSongIndex]);

  const handleMoodStripWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const strip = moodStripRef.current;
    if (!strip) return;
    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (horizontalDelta === 0) return;
    strip.scrollLeft += horizontalDelta;
  }, []);

  const seekToPointerPosition = useCallback((clientX: number) => {
    const bar = progressBarRef.current;
    const audio = audioRef.current;
    if (!bar || !audio) return;

    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;

    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : parseDurationToSeconds(playlistRef.current?.songs?.[currentSongIndexRef.current]?.duration);

    setPlaybackProgressPercent(ratio * 100);
    setPlaybackCurrentTime(duration * ratio);

    if (duration > 0) {
      audio.currentTime = duration * ratio;
      songStartTimeRef.current = Date.now() - (audio.currentTime * 1000);
    }
  }, []);

  const handleProgressPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    preventDefaultIfPossible(event);
    const bar = progressBarRef.current;
    if (!bar) return;
    isSeekingRef.current = true;
    progressPointerIdRef.current = event.pointerId;
    setIsSeeking(true);
    if (!bar.hasPointerCapture(event.pointerId)) {
      bar.setPointerCapture(event.pointerId);
    }
    seekToPointerPosition(event.clientX);
  }, [seekToPointerPosition]);

  const handleProgressPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if (!isSeekingRef.current || progressPointerIdRef.current !== event.pointerId) return;
    preventDefaultIfPossible(event);
    seekToPointerPosition(event.clientX);
  }, [seekToPointerPosition]);

  const handleProgressPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const bar = progressBarRef.current;
    if (bar?.hasPointerCapture(event.pointerId)) {
      bar.releasePointerCapture(event.pointerId);
    }
    if (progressPointerIdRef.current === event.pointerId) {
      progressPointerIdRef.current = null;
      isSeekingRef.current = false;
      setIsSeeking(false);
    }
  }, []);

  useEffect(() => {
    const bar = progressBarRef.current;
    if (!bar) return;

    const handleBarTouchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) return;
      preventDefaultIfPossible(event);
      progressTouchIdRef.current = touch.identifier;
      isSeekingRef.current = true;
      setIsSeeking(true);
      seekToPointerPosition(touch.clientX);
    };

    bar.addEventListener("touchstart", handleBarTouchStart, { passive: false });
    return () => {
      bar.removeEventListener("touchstart", handleBarTouchStart);
    };
  }, [seekToPointerPosition]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWindowPointerMove = (event: PointerEvent) => {
      if (!isSeekingRef.current) return;
      if (progressPointerIdRef.current !== null && event.pointerId !== progressPointerIdRef.current) return;
      preventDefaultIfPossible(event);
      seekToPointerPosition(event.clientX);
    };

    const handleWindowPointerEnd = (event: PointerEvent) => {
      if (!isSeekingRef.current) return;
      if (progressPointerIdRef.current !== null && event.pointerId !== progressPointerIdRef.current) return;
      progressPointerIdRef.current = null;
      isSeekingRef.current = false;
      setIsSeeking(false);
    };

    const handleWindowTouchMove = (event: TouchEvent) => {
      if (!isSeekingRef.current) return;
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === progressTouchIdRef.current
      ) || Array.from(event.touches).find(
        (item) => item.identifier === progressTouchIdRef.current
      );
      if (!touch) return;
      preventDefaultIfPossible(event);
      seekToPointerPosition(touch.clientX);
    };

    const handleWindowTouchEnd = (event: TouchEvent) => {
      if (!isSeekingRef.current) return;
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === progressTouchIdRef.current
      );
      if (!touch) return;
      progressTouchIdRef.current = null;
      isSeekingRef.current = false;
      setIsSeeking(false);
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerEnd);
    window.addEventListener("pointercancel", handleWindowPointerEnd);
    window.addEventListener("touchmove", handleWindowTouchMove, { passive: false });
    window.addEventListener("touchend", handleWindowTouchEnd, { passive: false });
    window.addEventListener("touchcancel", handleWindowTouchEnd, { passive: false });
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerEnd);
      window.removeEventListener("pointercancel", handleWindowPointerEnd);
      window.removeEventListener("touchmove", handleWindowTouchMove);
      window.removeEventListener("touchend", handleWindowTouchEnd);
      window.removeEventListener("touchcancel", handleWindowTouchEnd);
    };
  }, [seekToPointerPosition]);

	  const isRealPlayableCandidate = (url: string) => {
	    if (!url) return false;
	    if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) return false;
    try {
      const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
      if (MOCK_MUSIC_ROUTE_RE.test(parsed.pathname)) return false;
    } catch {
      if (MOCK_MUSIC_ROUTE_RE.test(url)) return false;
    }
	    return true;
	  };

	  const hasPlayableSongAudio = (song?: Partial<Song> | null) => {
	    if (!song?.audioUrl) return false;
	    return isRealPlayableCandidate(getMusicAudioUrl(song.audioUrl));
	  };

  const waitForAudioReady = (audio: HTMLAudioElement) => new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timeoutId = setTimeout(() => finish(false), REAL_AUDIO_READY_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeoutId);
      audio.removeEventListener("loadedmetadata", onReady);
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("stalled", onError);
    };

    audio.addEventListener("loadedmetadata", onReady, { once: true });
    audio.addEventListener("canplay", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.addEventListener("stalled", onError, { once: true });
    audio.load();
  });

	  const playSong = useCallback(async (song?: Song | null) => {
    const audio = audioRef.current;
    if (!audio || !song) return false;

    const primaryUrl = song?.audioUrl ? getMusicAudioUrl(song.audioUrl) : "";
    if (!isRealPlayableCandidate(primaryUrl)) {
      return false;
    }

    try {
      if (audio.src !== primaryUrl) {
        audio.src = primaryUrl;
      }
      const ready = await waitForAudioReady(audio);
      if (!ready) return false;
      audio.volume = DEFAULT_PLAYBACK_VOLUME;
      await audio.play();
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "NotAllowedError") {
        pendingAutoplayRef.current = true;
      }
	      return false;
	    }
	  }, []);

	  const playSongAndSyncState = useCallback(async (song?: Song | null) => {
	    const requestId = playbackRequestIdRef.current + 1;
	    playbackRequestIdRef.current = requestId;
	    const expectedSongId = song?.id || "";
	    const ok = await playSong(song);
	    if (playbackRequestIdRef.current !== requestId) {
	      return ok;
	    }
	    const activeSong = playlistRef.current?.songs?.[currentSongIndexRef.current] || null;
	    if (expectedSongId && activeSong?.id !== expectedSongId) {
	      return ok;
	    }
	    setIsPlaying(ok);
	    if (ok) {
	      songStartTimeRef.current = Date.now();
	    }
	    return ok;
	  }, [playSong]);

  const buildAutoGenerateSignature = (history: ChatMessage[]) => {
    const stableHistory = history.map((item) => `${item.role}:${item.content}`).join("||");
    return `${history.length}::${stableHistory}`;
  };

  const buildApiHistory = (history: ChatMessage[]) => history.map((item) => ({ role: item.role, content: item.content }));
  const buildListenerFocusedHistory = (history: ChatMessage[]) => history
    .filter((item) => item.role === "user")
    .slice(-4)
    .map((item) => ({ role: item.role, content: item.content }));

  const getCurrentDayPart = () => {
    const hour = new Date().getHours();
    if (hour < 5) return "深夜";
    if (hour < 8) return "清晨";
    if (hour < 11) return "上午";
    if (hour < 13) return "中午";
    if (hour < 17) return "下午";
    if (hour < 19) return "傍晚";
    if (hour < 23) return "晚上";
    return "深夜";
  };

  const getOrCreateHostSessionId = () => {
    if (hostSessionIdRef.current !== "default") {
      return hostSessionIdRef.current;
    }

    if (typeof window === "undefined") {
      return hostSessionIdRef.current;
    }

    const stored = window.localStorage.getItem(HOST_SESSION_STORAGE_KEY);
    if (stored && stored.trim()) {
      hostSessionIdRef.current = stored.trim();
      return hostSessionIdRef.current;
    }

    const nextId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `host-session-${Date.now()}`;
    window.localStorage.setItem(HOST_SESSION_STORAGE_KEY, nextId);
    hostSessionIdRef.current = nextId;
    return nextId;
  };

  const toHostTrackPayload = (song?: Song | null) => {
    if (!song) return null;
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      style: song.style,
      mood: song.mood,
      duration: song.duration,
      audioUrl: song.audioUrl ?? null,
      tags: song.tags,
    };
  };

  const getPlaybackProgressMs = () => {
    if (!songStartTimeRef.current) return 0;
    return Math.max(0, Date.now() - songStartTimeRef.current);
  };

  const toSongModel = (rawSong: Partial<Song> | null | undefined, fallback: { id: string; mood: string }, index: number): Song => {
    const title = typeof rawSong?.title === "string" && rawSong.title.trim() ? rawSong.title.trim() : `未命名曲目 ${index + 1}`;
    const artist = typeof rawSong?.artist === "string" && rawSong.artist.trim() ? rawSong.artist.trim() : "Unknown Artist";
    const style = typeof rawSong?.style === "string" && rawSong.style.trim() ? rawSong.style.trim() : "mixed";
    const duration = typeof rawSong?.duration === "string" && rawSong.duration.trim() ? rawSong.duration.trim() : "00:00";
    const id = typeof rawSong?.id === "string" && rawSong.id.trim() ? rawSong.id.trim() : `${fallback.id}-${index}`;
    return {
      id,
      title,
      artist,
      style,
      duration,
      tags: Array.isArray(rawSong?.tags) ? rawSong.tags : [],
      mood: typeof rawSong?.mood === "string" && rawSong.mood.trim() ? rawSong.mood.trim() : fallback.mood,
      audioUrl: typeof rawSong?.audioUrl === "string" && rawSong.audioUrl.trim() ? rawSong.audioUrl : null,
    };
  };

  const getSongTitleKey = (song?: Partial<Song> | null) => {
    const title = typeof song?.title === "string" ? song.title : "";
    return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  };

	  const dedupeSongsByTitle = <T extends Partial<Song>>(songs: T[]): T[] => {
	    const byTitle = new Map<string, T>();
	    const untitled: T[] = [];
	    for (const song of songs) {
	      const titleKey = getSongTitleKey(song);
	      if (!titleKey) {
	        untitled.push(song);
	        continue;
	      }
	      const existing = byTitle.get(titleKey);
	      if (!existing || (!hasPlayableSongAudio(existing) && hasPlayableSongAudio(song))) {
	        byTitle.set(titleKey, song);
	      }
	    }
	    return [...untitled, ...byTitle.values()];
	  };

	  const dedupeSongLibraryByTitle = (library: SongLibraryItem[]): SongLibraryItem[] => {
	    const byTitle = new Map<string, SongLibraryItem>();
	    const untitled: SongLibraryItem[] = [];
	    for (const item of library) {
	      const titleKey = getSongTitleKey(item.song);
	      if (!titleKey) {
	        untitled.push(item);
	        continue;
	      }
	      const existing = byTitle.get(titleKey);
	      if (!existing || (!hasPlayableSongAudio(existing.song) && hasPlayableSongAudio(item.song))) {
	        byTitle.set(titleKey, item);
	      }
	    }
	    return [...untitled, ...byTitle.values()];
	  };

  const mergeSongLibraryByTitle = (existing: SongLibraryItem[], incoming: SongLibraryItem[]) => {
    const merged = dedupeSongLibraryByTitle(existing);
    const existingTitleToIndex = new Map<string, number>();
    merged.forEach((item, index) => {
      const titleKey = getSongTitleKey(item.song);
      if (titleKey && !existingTitleToIndex.has(titleKey)) {
        existingTitleToIndex.set(titleKey, index);
      }
    });

    let firstRelevantIndex = -1;
    for (const item of incoming) {
      const titleKey = getSongTitleKey(item.song);
	      const existingIndex = titleKey ? existingTitleToIndex.get(titleKey) : undefined;
	      if (existingIndex !== undefined) {
	        if (!hasPlayableSongAudio(merged[existingIndex]?.song) && hasPlayableSongAudio(item.song)) {
	          merged[existingIndex] = item;
	        }
	        if (firstRelevantIndex === -1) firstRelevantIndex = existingIndex;
	        continue;
	      }

      const nextIndex = merged.length;
      merged.push(item);
      if (titleKey) existingTitleToIndex.set(titleKey, nextIndex);
      if (firstRelevantIndex === -1) firstRelevantIndex = nextIndex;
    }

    return {
      mergedLibrary: merged,
      startIndex: firstRelevantIndex === -1 ? Math.max(0, merged.length - 1) : firstRelevantIndex,
    };
  };

  const buildSongLibrary = useCallback((histories: PlaylistHistoryItem[], fallbackPlaylist: Playlist | null): SongLibraryItem[] => {
    const next: SongLibraryItem[] = [];
    const rows = Array.isArray(histories) ? histories : [];

    for (const history of rows) {
      const songs = Array.isArray(history?.songs) ? history.songs : [];
      const createdAt = typeof history?.createdAt === "string" ? history.createdAt : new Date().toISOString();
      const playlistMood = typeof history?.mood === "string" && history.mood.trim() ? history.mood : "relaxed";
      const playlistId = typeof history?.id === "string" && history.id.trim() ? history.id : `history-${createdAt}`;

      songs.forEach((rawSong, index) => {
        const song = toSongModel(rawSong, { id: playlistId, mood: playlistMood }, index);
        next.push({
          key: `${playlistId}-${song.id}-${index}`,
          song,
          playlistId,
          createdAt,
          playlistMood,
        });
      });
    }

    if (next.length === 0 && fallbackPlaylist?.songs?.length) {
      const createdAt = fallbackPlaylist.generatedAt || new Date().toISOString();
      fallbackPlaylist.songs.forEach((song, index) => {
        const normalized = toSongModel(song, { id: fallbackPlaylist.id || "fallback", mood: fallbackPlaylist.mood || "relaxed" }, index);
        next.push({
          key: `${fallbackPlaylist.id || "fallback"}-${normalized.id}-${index}`,
          song: normalized,
          playlistId: fallbackPlaylist.id || "fallback",
          createdAt,
          playlistMood: fallbackPlaylist.mood || "relaxed",
        });
      });
    }

    return dedupeSongLibraryByTitle(next);
  }, []);

  const refreshAllSongsLibrary = useCallback(async (fallbackPlaylist: Playlist | null = null) => {
    try {
      const result = await getPlaylistHistory(200) as { items?: PlaylistHistoryItem[] };
      const histories = Array.isArray(result?.items) ? result.items : [];
      setAllSongsLibrary(buildSongLibrary(histories, fallbackPlaylist || playlistRef.current));
    } catch {
      setAllSongsLibrary(buildSongLibrary([], fallbackPlaylist || playlistRef.current));
    }
  }, [buildSongLibrary]);

	  const buildAllSongsPlaybackPlaylist = (library: SongLibraryItem[], moodOverride?: string): Playlist | null => {
	    const dedupedLibrary = dedupeSongLibraryByTitle(library).filter((item) => hasPlayableSongAudio(item.song));
	    if (!dedupedLibrary.length) return null;
    return {
      id: `all-songs-${Date.now()}`,
      mood: moodOverride || dedupedLibrary[0]?.playlistMood || dedupedLibrary[0]?.song?.mood || "relaxed",
      prompt: "全部歌曲连续播放",
      generatedAt: new Date().toISOString(),
      source: "history-all",
      songs: dedupedLibrary.map((item) => item.song),
    };
  };

  const appendGeneratedSongsToLibrary = (generatedPlaylist: Playlist) => {
    const createdAt = generatedPlaylist.generatedAt || new Date().toISOString();
    const playlistId = generatedPlaylist.id || `generated-${Date.now()}`;
    const playlistMood = generatedPlaylist.mood || "relaxed";
    const generatedItems = generatedPlaylist.songs.map((rawSong: Partial<Song>, index: number) => {
      const song = toSongModel(rawSong, { id: playlistId, mood: playlistMood }, index);
      return {
        key: `${playlistId}-${song.id}-${index}`,
        song,
        playlistId,
        createdAt,
        playlistMood,
      };
    });

    const { mergedLibrary, startIndex } = mergeSongLibraryByTitle(allSongsLibraryRef.current, generatedItems);
    allSongsLibraryRef.current = mergedLibrary;
    setAllSongsLibrary(mergedLibrary);

    return {
      mergedLibrary,
      startIndex,
    };
  };

  const reportEvent = useCallback((
    eventType?: string,
    extra?: {
      playlistId?: string | null;
      songId?: string | null;
      mood?: string | null;
      tags?: string[];
      messageExcerpt?: string;
      context?: Record<string, unknown>;
    }
  ) => {
    const safeEventType = typeof eventType === "string" ? eventType.trim() : "";
    if (!safeEventType) return;

    const activePlaylist = playlistRef.current;
    const activeSong = activePlaylist?.songs?.[currentSongIndexRef.current] || null;
    const context = extra?.context && typeof extra.context === "object" ? extra.context : {};
    const mood = typeof extra?.mood === "string" && extra.mood.trim()
      ? extra.mood.trim()
      : (activePlaylist?.mood || activeSong?.mood || "");
    const playlistId = typeof extra?.playlistId === "string" && extra.playlistId.trim()
      ? extra.playlistId.trim()
      : (activePlaylist?.id || "");
    const songId = typeof extra?.songId === "string" && extra.songId.trim()
      ? extra.songId.trim()
      : (activeSong?.id || "");
    const tags = Array.isArray(extra?.tags) && extra.tags.length
      ? extra.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).slice(0, 12)
      : Array.isArray(activeSong?.tags)
        ? activeSong.tags.slice(0, 8)
        : [];
    const messageExcerpt = typeof extra?.messageExcerpt === "string" ? extra.messageExcerpt : "";
    const playbackSeconds = typeof context.playbackSeconds === "number" && Number.isFinite(context.playbackSeconds)
      ? context.playbackSeconds
      : undefined;

    recentListenerSignalsRef.current = [
      ...recentListenerSignalsRef.current,
      {
        eventType: safeEventType,
        at: Date.now(),
        mood: mood || undefined,
        playlistId: playlistId || undefined,
        playbackSeconds,
      }
    ].slice(-MAX_RECENT_SIGNAL_COUNT);

    void recordListenerEvent({
      eventType: safeEventType,
      playlistId: playlistId || null,
      songId: songId || null,
      mood: mood || null,
      tags,
      messageExcerpt,
      context,
    }).catch(() => {});
  }, []);

	  const inferMoodFromText = useCallback((value: string) => {
	    const normalized = normalizeMoodMatcherText(value);
	    if (!normalized) return "relaxed";

	    const directMatch = (Object.keys(moodLabels) as MoodKey[]).find((key) => key === normalized);
	    if (directMatch) return directMatch;
	    const labelMatch = (Object.keys(moodLabels) as MoodKey[]).find((key) => normalizeMoodMatcherText(moodLabels[key]) === normalized);
	    return labelMatch || "relaxed";
	  }, []);

  const inferMoodFromHistory = useCallback((history: ChatMessage[]) => {
    const recentUserText = history
      .filter((item) => item.role === "user")
      .slice(-3)
      .map((item) => item.content)
      .join(" ");
    return inferMoodFromText(recentUserText || playlistRef.current?.mood || "relaxed");
  }, [inferMoodFromText]);

  const getMoodMatchers = useCallback((mood: string) => {
    const resolvedMood = (Object.keys(moodLabels) as MoodKey[]).includes(mood as MoodKey)
      ? mood as MoodKey
      : inferMoodFromText(mood);
	    const variants = [
	      resolvedMood,
	      moodLabels[resolvedMood],
	    ]
      .map((item) => normalizeMoodMatcherText(item))
      .filter(Boolean);
    return Array.from(new Set(variants));
  }, [inferMoodFromText]);

  const scoreLibraryItemForMood = useCallback((item: SongLibraryItem, mood: string) => {
    const matchers = getMoodMatchers(mood);
    if (!matchers.length) return 0;

    const playlistMood = normalizeMoodMatcherText(item.playlistMood || "");
    const songMood = normalizeMoodMatcherText(item.song.mood || "");
    const style = normalizeMoodMatcherText(item.song.style || "");
    const title = normalizeMoodMatcherText(item.song.title || "");
    const artist = normalizeMoodMatcherText(item.song.artist || "");
    const tags = Array.isArray(item.song.tags)
      ? item.song.tags.map((tag) => normalizeMoodMatcherText(tag))
      : [];

    let score = 0;
    if (matchers.includes(playlistMood)) score += 5;
    if (matchers.includes(songMood)) score += 4;
    if (tags.some((tag) => matchers.some((matcher) => tag === matcher))) score += 3;
    if (tags.some((tag) => matchers.some((matcher) => tag.includes(matcher)))) score += 2;
    if (matchers.some((matcher) => style.includes(matcher))) score += 2;
    if (matchers.some((matcher) => title.includes(matcher))) score += 1;
    if (matchers.some((matcher) => artist.includes(matcher))) score += 1;

    const createdAt = Date.parse(item.createdAt || "");
    if (Number.isFinite(createdAt)) {
      const ageMs = Date.now() - createdAt;
      if (ageMs <= 7 * 24 * 60 * 60 * 1000) score += 1;
    }

    return score;
  }, [getMoodMatchers]);

  const getBestLocalMoodMatch = useCallback((mood: string) => {
    const resolvedMood = (Object.keys(moodLabels) as MoodKey[]).includes(mood as MoodKey)
      ? mood
      : inferMoodFromText(mood);
    let bestIndex = -1;
	    let bestScore = 0;

	    allSongsLibraryRef.current.forEach((item, index) => {
	      if (!hasPlayableSongAudio(item.song)) return;
	      const score = scoreLibraryItemForMood(item, resolvedMood);
	      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return {
      mood: resolvedMood,
      index: bestIndex,
      score: bestScore,
      item: bestIndex >= 0 ? allSongsLibraryRef.current[bestIndex] : null,
    };
  }, [inferMoodFromText, scoreLibraryItemForMood]);

  const hasRecentNegativeFeedback = useCallback((options?: { mood?: string; playlistId?: string }) => {
    const now = Date.now();
    const targetMood = options?.mood ? inferMoodFromText(options.mood) : "";
    const relevantSignals = recentListenerSignalsRef.current.filter((signal) => {
      if (now - signal.at > RECENT_NEGATIVE_FEEDBACK_WINDOW_MS) return false;
      if (options?.playlistId && signal.playlistId && signal.playlistId !== options.playlistId) return false;
      if (targetMood && signal.mood && inferMoodFromText(signal.mood) !== targetMood) return false;

      if (signal.eventType === "skip_next" || signal.eventType === "skip_prev") return true;
      if (signal.eventType === "pause") {
        return typeof signal.playbackSeconds === "number" && signal.playbackSeconds <= SHORT_PAUSE_NEGATIVE_SECONDS;
      }
      return false;
    });

    return relevantSignals.length >= RECENT_NEGATIVE_FEEDBACK_THRESHOLD;
  }, [inferMoodFromText]);

  const decidePlaylistStrategy = useCallback((input: { mood: string; triggerType: string }) => {
    const resolvedMood = inferMoodFromText(input.mood || playlistRef.current?.mood || "relaxed");
    const bestLocal = getBestLocalMoodMatch(resolvedMood);
    const prefersFreshSuno = input.triggerType === "listener_requested_new_track";
    const passiveTrigger = input.triggerType === "chat_auto" || input.triggerType === "opening_generated";
    const cooldownMs = passiveTrigger
      ? SUNO_PASSIVE_GENERATION_COOLDOWN_MS
      : SUNO_EXPLICIT_GENERATION_COOLDOWN_MS;
    const cooldownRemainingMs = lastSunoGenerationAtRef.current > 0
      ? Math.max(0, cooldownMs - (Date.now() - lastSunoGenerationAtRef.current))
      : 0;
    const strongLocalMatch = bestLocal.index >= 0 && bestLocal.score >= LOCAL_MATCH_SCORE_THRESHOLD;
    const recentNegativeFeedback = hasRecentNegativeFeedback({
      mood: resolvedMood,
      playlistId: bestLocal.item?.playlistId,
    });

    if (!prefersFreshSuno && strongLocalMatch && !recentNegativeFeedback) {
      return {
        mode: "local" as const,
        mood: resolvedMood,
        localIndex: bestLocal.index,
        localScore: bestLocal.score,
        cooldownRemainingMs,
        reason: "strong_local_match",
      };
    }

    if (cooldownRemainingMs > 0) {
      if (bestLocal.index >= 0) {
        return {
          mode: "local" as const,
          mood: resolvedMood,
          localIndex: bestLocal.index,
          localScore: bestLocal.score,
          cooldownRemainingMs,
          reason: "generation_cooldown_local_fallback",
        };
      }

      return {
        mode: "blocked" as const,
        mood: resolvedMood,
        localIndex: -1,
        localScore: bestLocal.score,
        cooldownRemainingMs,
        reason: "generation_cooldown",
      };
    }

    return {
      mode: "suno" as const,
      mood: resolvedMood,
      localIndex: bestLocal.index,
      localScore: bestLocal.score,
      cooldownRemainingMs: 0,
      reason: recentNegativeFeedback ? "negative_feedback_refresh" : "needs_fresh_generation",
    };
  }, [getBestLocalMoodMatch, hasRecentNegativeFeedback, inferMoodFromText]);

  function startAllSongsPlaybackAtIndex(
    library: SongLibraryItem[],
    index: number,
    options?: {
      closePanel?: boolean;
      hostEvent?: "song_change" | "page_opened";
      manualReason?: string;
      slotId?: string;
      suppressTrackIntro?: boolean;
      triggerHost?: boolean;
    }
	  ) {
	    if (!library.length) return false;
	    const dedupedLibrary = dedupeSongLibraryByTitle(library).filter((item) => hasPlayableSongAudio(item.song));
	    if (!dedupedLibrary.length) return false;
	    const requestedItem = library[Math.min(Math.max(index, 0), library.length - 1)];
    const requestedTitleKey = getSongTitleKey(requestedItem?.song);
    const matchedIndex = requestedTitleKey
      ? dedupedLibrary.findIndex((item) => getSongTitleKey(item.song) === requestedTitleKey)
      : -1;
    const safeIndex = matchedIndex >= 0
      ? matchedIndex
      : Math.min(Math.max(index, 0), dedupedLibrary.length - 1);
    const selected = dedupedLibrary[safeIndex];
    const fullListPlaylist = buildAllSongsPlaybackPlaylist(
      dedupedLibrary,
      selected?.playlistMood || selected?.song?.mood || "relaxed"
    );
    if (!selected || !fullListPlaylist) return false;

    if (options?.suppressTrackIntro && selected.song?.id) {
      suppressTrackChangedHostRef.current = {
        trackId: selected.song.id,
        until: Date.now() + 4000
      };
    }

    setPlaylist(fullListPlaylist);
    setCurrentSongIndex(safeIndex);
    setIsPlaying(true);

    if (options?.closePanel) {
      setShowPlaylistPanel(false);
    }

    if (options?.triggerHost !== false && options?.hostEvent === "page_opened") {
      const hostEvent = "page_opened";
      const openingPayload = {
        currentTrack: selected.song,
        nextTrack: fullListPlaylist.songs[safeIndex + 1] || null,
        playlistOverride: fullListPlaylist,
        mood: selected.playlistMood || selected.song.mood || "relaxed",
        justSwitchedTrack: false,
        manualReason: options?.manualReason,
        slotId: options?.slotId || `track-change-${selected.song.id || safeIndex}`
      };
      void requestHostDecisionAndApply(hostEvent, openingPayload).finally(() => {
        scheduleOpeningTrackStartBroadcast({
          currentTrack: selected.song,
          nextTrack: fullListPlaylist.songs[safeIndex + 1] || null,
          playlistOverride: fullListPlaylist,
          mood: selected.playlistMood || selected.song.mood || "relaxed",
          manualReason: "opening_track_started",
          slotId: `opening-track-start-${selected.song.id || safeIndex}`
        });
      });
    }

    return true;
  }

	  const appendHostMessage = (content: string) => {
	    const text = content.trim();
	    if (!text) return;
	    setChatHistory((prev) => {
	      const lastAssistant = [...prev].reverse().find((item) => item.role === "assistant");
	      if (lastAssistant?.content.trim() === text) return prev;
	      return [
	        ...prev,
	        {
	          role: "assistant",
	          content: text,
	          timestamp: new Date(),
	        }
	      ];
	    });
	  };

  const getRecentHostSummary = () => chatHistoryRef.current
    .filter((item) => item.role === "assistant")
    .slice(-2)
    .map((item) => item.content)
    .join(" / ");

	  const buildAllowedActions = (event: HostDynamicEvent) => {
	    const full = ["noop", "highlight_reply_only", "pause_music", "resume_music", "skip_next", "skip_prev", "play_track", "play_local_match", "generate_song", "switch_to_all_songs"];
	    if (event === "user_speak") {
	      return full;
	    }
    if (event === "song_change" || event === "proactive") {
      return full;
    }
	    return ["noop", "highlight_reply_only"];
	  };

	  const getUserSpeakGenerationGuard = () => {
	    if (isGeneratingPlaylistRef.current || autoGenerateInFlightRef.current) {
	      return {
	        blocked: true,
	        status: "新歌已经在生成或准备中，本轮不要再次触发 generate_song；如果用户继续说想要新歌，只回复他已经在路上，先等这一首。"
	      };
	    }
	    const elapsedMs = lastSunoGenerationAtRef.current > 0
	      ? Date.now() - lastSunoGenerationAtRef.current
	      : Number.POSITIVE_INFINITY;
	    if (elapsedMs < USER_SPEAK_GENERATE_SONG_GUARD_MS) {
	      const remainingSeconds = Math.ceil((USER_SPEAK_GENERATE_SONG_GUARD_MS - elapsedMs) / 1000);
	      return {
	        blocked: true,
	        status: `刚刚已经生成过一首新歌，${remainingSeconds} 秒内不要再次触发 generate_song；如果用户还说想要新歌，先引导他听当前这首或用现有播放列表承接。`
	      };
	    }
	    return { blocked: false, status: "" };
	  };

	  const buildUserSpeakAllowedActions = () => {
	    const guard = getUserSpeakGenerationGuard();
	    const actions = buildAllowedActions("user_speak");
	    return guard.blocked
	      ? actions.filter((action) => action !== "generate_song")
	      : actions;
	  };

  const startGeneratedPlaylist = useCallback(async (
    mood: string,
    meta: {
      summary: string;
      themeTags?: string[];
      musicDirection?: string[];
      triggerType: string;
    },
    options?: {
      skipHostDecision?: boolean;
      suppressTrackIntro?: boolean;
      appendToCurrentPlaylist?: boolean;
      forceGenerate?: boolean;
      generatedCount?: number;
    }
  ) => {
    const strategy = decidePlaylistStrategy({
      mood,
      triggerType: meta.triggerType,
    });
    const normalizedMood = strategy.mood;

    if (!options?.forceGenerate && strategy.mode === "local" && strategy.localIndex >= 0) {
      const localItem = allSongsLibraryRef.current[strategy.localIndex];
      if (localItem && startAllSongsPlaybackAtIndex(allSongsLibraryRef.current, strategy.localIndex, {
        triggerHost: !options?.skipHostDecision,
        suppressTrackIntro: Boolean(options?.suppressTrackIntro),
        manualReason: `${meta.triggerType}_local`,
        slotId: `local-match-${localItem.song.id || strategy.localIndex}`
      })) {
        reportEvent("playlist_auto_started", {
          playlistId: localItem.playlistId,
          songId: localItem.song.id,
          mood: localItem.playlistMood || localItem.song.mood || normalizedMood,
          tags: localItem.song.tags || [],
          context: {
            source: `${meta.triggerType}_local`,
            strategyReason: strategy.reason,
            localScore: strategy.localScore,
            cooldownRemainingMs: strategy.cooldownRemainingMs,
          }
        });
        return {
          id: localItem.playlistId,
          mood: localItem.playlistMood || normalizedMood,
          prompt: meta.summary,
          generatedAt: localItem.createdAt,
          songs: [localItem.song],
          source: "history-all",
        };
      }
    }

    if (!options?.forceGenerate && strategy.mode === "blocked") {
      return null;
    }

    const summary = meta.summary?.trim() || `听众想听一首带有${moodLabels[normalizedMood as keyof typeof moodLabels] || normalizedMood}氛围的歌`;
    const musicDirection = meta.musicDirection?.length
      ? meta.musicDirection
      : [moodSceneBriefs[normalizedMood]?.sound || moodLabels[normalizedMood as keyof typeof moodLabels] || normalizedMood];
    const result = await generatePlaylist(
      normalizedMood,
      buildPlaylistGenerationPrompt(normalizedMood, summary, musicDirection),
      options?.generatedCount || 2,
      {
        triggerType: meta.triggerType,
        summary,
        themeTags: meta.themeTags?.length ? meta.themeTags : [moodLabels[normalizedMood as keyof typeof moodLabels] || normalizedMood],
        musicDirection
      }
    );
    if (!result?.songs?.length) {
      return null;
    }
    if (result.source === "suno-official") {
      lastSunoGenerationAtRef.current = Date.now();
    }
    const { mergedLibrary, startIndex } = appendGeneratedSongsToLibrary(result);
    const generatedSongs = result.songs.map((rawSong: Partial<Song>, index: number) => toSongModel(rawSong, {
      id: result.id || `generated-${Date.now()}`,
      mood: result.mood || normalizedMood
    }, index));
    reportEvent("playlist_auto_started", {
      playlistId: result.id,
      mood: result.mood,
      tags: result.songs?.flatMap((song: Song) => song.tags || []).slice(0, 8) || [],
      context: {
        source: meta.triggerType,
        strategyReason: strategy.reason,
        localScore: strategy.localScore,
      }
    });

    if (options?.appendToCurrentPlaylist) {
      const activePlaylist = playlistRef.current;
      const activeIndex = currentSongIndexRef.current;
      const hasActiveQueue = Boolean(activePlaylist?.songs?.length);
      const activeSongs: Song[] = hasActiveQueue ? dedupeSongsByTitle<Song>(activePlaylist!.songs) : [];
      const activeSong = activePlaylist?.songs?.[activeIndex] || null;
      const activeSongTitleKey = getSongTitleKey(activeSong);
      const dedupedActiveIndex = activeSongTitleKey
        ? activeSongs.findIndex((song) => getSongTitleKey(song) === activeSongTitleKey)
        : -1;
      const normalizedActiveIndex = dedupedActiveIndex >= 0
        ? dedupedActiveIndex
        : Math.min(Math.max(activeIndex, 0), Math.max(0, activeSongs.length - 1));
      const activeTitleKeys = new Set(activeSongs.map((song) => getSongTitleKey(song)).filter(Boolean));
      const uniqueGeneratedSongs: Song[] = dedupeSongsByTitle<Song>(generatedSongs).filter((song) => {
        const titleKey = getSongTitleKey(song);
        return !titleKey || !activeTitleKeys.has(titleKey);
      });
      const insertIndex = hasActiveQueue
        ? Math.min(Math.max(normalizedActiveIndex + 1, 0), activeSongs.length)
        : 0;
      const nextPlaylist: Playlist = hasActiveQueue
        ? {
          ...activePlaylist!,
          mood: activePlaylist!.mood || result.mood || normalizedMood,
          songs: [
            ...activeSongs.slice(0, insertIndex),
            ...uniqueGeneratedSongs,
            ...activeSongs.slice(insertIndex),
          ],
        }
        : {
          id: `generated-song-${Date.now()}`,
          mood: result.mood || normalizedMood,
          prompt: summary,
          generatedAt: result.generatedAt || new Date().toISOString(),
          source: result.source || "generated-song",
          songs: dedupeSongsByTitle<Song>(generatedSongs),
        };

      const targetIndex = insertIndex;
      const targetSong = uniqueGeneratedSongs[0] || nextPlaylist.songs[targetIndex] || nextPlaylist.songs[0];
      if (options?.suppressTrackIntro && targetSong?.id) {
        suppressTrackChangedHostRef.current = { trackId: targetSong.id, until: Date.now() + 4000 };
      }
      setPlaylist(nextPlaylist);
      setCurrentSongIndex(Math.min(targetIndex, Math.max(0, nextPlaylist.songs.length - 1)));
      setIsPlaying(true);
      reportEvent("song_generated_added", {
        playlistId: nextPlaylist.id,
        songId: targetSong?.id || "",
        mood: result.mood || normalizedMood,
        tags: nextPlaylist.songs.flatMap((song: Song) => song.tags || []).slice(0, 8),
        context: {
          source: meta.triggerType,
          insertedAt: targetIndex,
          generatedCount: uniqueGeneratedSongs.length,
        }
      });
      return result;
    }

    startAllSongsPlaybackAtIndex(mergedLibrary, startIndex, {
      triggerHost: !options?.skipHostDecision,
      suppressTrackIntro: Boolean(options?.suppressTrackIntro),
      manualReason: meta.triggerType,
      slotId: `playlist-intro-${result.songs[0]?.id || "auto"}`
    });

    return result;
  }, [decidePlaylistStrategy, reportEvent]);

  const applyHostActions = useCallback(async (
    actions: Array<{ type?: string; payload?: Record<string, unknown> }> = [],
    options?: { skipHostDecision?: boolean }
  ) => {
    for (const action of actions) {
      const type = typeof action?.type === "string" ? action.type : "";
      const payload = action?.payload || {};

      if (!type || type === "noop" || type === "highlight_reply_only") {
        continue;
      }

      if (type === "pause_music") {
        audioRef.current?.pause();
        setIsPlaying(false);
        continue;
      }

	      if (type === "resume_music") {
	        const song = playlistRef.current?.songs?.[currentSongIndexRef.current];
	        if (!song) continue;
	        await playSongAndSyncState(song);
	        continue;
	      }

      if (type === "skip_next") {
        const pl = playlistRef.current;
        const nextIndex = currentSongIndexRef.current + 1;
        if (!pl || nextIndex >= pl.songs.length) continue;
        const nextSong = pl.songs[nextIndex];
        if (options?.skipHostDecision && nextSong?.id) {
          suppressTrackChangedHostRef.current = { trackId: nextSong.id, until: Date.now() + 4000 };
        }
        setCurrentSongIndex(nextIndex);
        setIsPlaying(true);
        continue;
      }

      if (type === "skip_prev") {
        const pl = playlistRef.current;
        const prevIndex = currentSongIndexRef.current - 1;
        if (!pl || prevIndex < 0) continue;
        const prevSong = pl.songs[prevIndex];
        if (options?.skipHostDecision && prevSong?.id) {
          suppressTrackChangedHostRef.current = { trackId: prevSong.id, until: Date.now() + 4000 };
        }
        setCurrentSongIndex(prevIndex);
        setIsPlaying(true);
        continue;
      }

      if (type === "play_track") {
        const trackId = typeof payload.trackId === "string" ? payload.trackId : "";
        const pl = playlistRef.current;
        const playlistIndex = pl?.songs?.findIndex((song) => song.id === trackId) ?? -1;
        if (pl && playlistIndex >= 0) {
          if (options?.skipHostDecision && pl.songs[playlistIndex]?.id) {
            suppressTrackChangedHostRef.current = { trackId: pl.songs[playlistIndex].id, until: Date.now() + 4000 };
          }
          setCurrentSongIndex(playlistIndex);
          setIsPlaying(true);
          continue;
        }
        const libraryIndex = allSongsLibraryRef.current.findIndex((item) => item.song.id === trackId);
        if (libraryIndex >= 0) {
          const targetSong = allSongsLibraryRef.current[libraryIndex]?.song;
          if (options?.skipHostDecision && targetSong?.id) {
            suppressTrackChangedHostRef.current = { trackId: targetSong.id, until: Date.now() + 4000 };
          }
          playFromAllSongs(libraryIndex);
        }
        continue;
      }

      if (type === "switch_to_all_songs") {
        const trackId = typeof payload.trackId === "string" ? payload.trackId : "";
        const fallbackTrackId = trackId || playlistRef.current?.songs?.[currentSongIndexRef.current]?.id || "";
        const targetIndex = allSongsLibraryRef.current.findIndex((item) => item.song.id === fallbackTrackId);
        if (targetIndex >= 0) {
          if (options?.skipHostDecision && allSongsLibraryRef.current[targetIndex]?.song?.id) {
            suppressTrackChangedHostRef.current = { trackId: allSongsLibraryRef.current[targetIndex].song.id, until: Date.now() + 4000 };
          }
          playFromAllSongs(targetIndex);
        } else if (allSongsLibraryRef.current.length > 0) {
          if (options?.skipHostDecision && allSongsLibraryRef.current[0]?.song?.id) {
            suppressTrackChangedHostRef.current = { trackId: allSongsLibraryRef.current[0].song.id, until: Date.now() + 4000 };
          }
          playFromAllSongs(0);
        }
        continue;
      }

      if (type === "play_local_match") {
        const targetMood = typeof payload.mood === "string" && payload.mood.trim()
          ? payload.mood
          : (playlistRef.current?.mood || "relaxed");
        const bestLocal = getBestLocalMoodMatch(targetMood);
        if (bestLocal.index >= 0) {
          startAllSongsPlaybackAtIndex(allSongsLibraryRef.current, bestLocal.index, {
            manualReason: typeof payload.reason === "string" ? payload.reason : "ai_play_local_match",
            slotId: `ai-local-match-${bestLocal.item?.song?.id || bestLocal.index}`,
            triggerHost: !options?.skipHostDecision,
            suppressTrackIntro: Boolean(options?.skipHostDecision)
          });
        }
        continue;
      }

	      if (type === "generate_song") {
	        if (getUserSpeakGenerationGuard().blocked) {
	          continue;
	        }
	        const playlistMood = typeof payload.playlistMood === "string" ? payload.playlistMood : (typeof payload.mood === "string" ? payload.mood : "relaxed");
	        const promptSummary = typeof payload.promptSummary === "string"
	          ? payload.promptSummary
	          : (typeof payload.reason === "string" ? payload.reason : "");
	        isGeneratingPlaylistRef.current = true;
	        setIsGeneratingPlaylist(true);
	        try {
          await startGeneratedPlaylist(playlistMood, {
            summary: promptSummary,
            themeTags: [playlistMood],
            musicDirection: [playlistMood],
            triggerType: typeof payload.reason === "string" ? payload.reason : "host_action"
          }, {
            skipHostDecision: Boolean(options?.skipHostDecision),
            suppressTrackIntro: Boolean(options?.skipHostDecision),
            appendToCurrentPlaylist: true,
            forceGenerate: true,
            generatedCount: 1
          });
	        } finally {
	          isGeneratingPlaylistRef.current = false;
	          setIsGeneratingPlaylist(false);
	        }
      }
    }
	  }, [playSongAndSyncState, startGeneratedPlaylist]);

  const requestHostDecisionAndApply = useCallback(async (
    event: string,
    payload: {
      currentTrack?: Song | null;
      nextTrack?: Song | null;
      playlistOverride?: Playlist | null;
      mood?: string;
      recentUserLine?: string;
      recentTranscriptOverride?: { role: string; content: string }[];
	      generatedSummary?: string;
	      musicGenerationStatus?: string;
	      recentHostSummaryOverride?: string;
      justSwitchedTrack?: boolean;
      manualReason?: string;
      appendOverride?: boolean;
      slotId?: string;
      allowedActions?: string[];
    } = {}
  ) => {
    const shouldMarkHostDecisionInFlight = true;
    if (shouldMarkHostDecisionInFlight) {
      hostDecisionInFlightRef.current = true;
      lastHostTriggerStartedAtRef.current = Date.now();
    }
    try {
    const requestStartedAt = Date.now();
    const shouldDropStaleOpeningReply = () => (
      event === "page_opened"
      && (
        chatHistoryRef.current.some((item) => item.role === "user")
        || lastUserInteractionAtRef.current > requestStartedAt
      )
    );

    const playLocalOpening = async () => {
      if (shouldDropStaleOpeningReply()) {
        return {
          reply: { shouldSpeak: false, text: "", appendToChat: false, voiceStyle: "warm" },
          source: "skipped-stale-opening-fallback"
        };
      }
      const openingText = buildLocalOpeningFallback(
        getCurrentDayPart(),
        payload.currentTrack || null,
        payload.nextTrack || null
      );
      appendHostMessage(openingText);
      await handleGenerateHostVoice(openingText, payload.slotId || "opening-local-fallback");

      const scheduleAiIntroAfterFixedOpening = () => {
        const initialPlaylist = payload.playlistOverride || playlistRef.current;
        const initialTrack = payload.currentTrack || initialPlaylist?.songs?.[currentSongIndexRef.current] || null;
        if (!initialTrack) return;

        const key = `${initialPlaylist?.id || "playlist"}:${initialTrack.id || initialTrack.title}:opening-track-start`;
        if (openingTrackStartHostKeyRef.current === key) return;
        openingTrackStartHostKeyRef.current = key;

        let aiIntroScheduled = false;
        let fallbackTimer: number | null = null;
        const runAiIntro = () => {
          if (aiIntroScheduled) return;
          aiIntroScheduled = true;
          if (fallbackTimer !== null) {
            window.clearTimeout(fallbackTimer);
            fallbackTimer = null;
          }
          if (openingTrackStartTimerRef.current !== null) {
            window.clearTimeout(openingTrackStartTimerRef.current);
          }
          openingTrackStartTimerRef.current = window.setTimeout(() => {
            openingTrackStartTimerRef.current = null;
            const pl = playlistRef.current || initialPlaylist;
            const idx = currentSongIndexRef.current;
            const current = pl?.songs?.[idx] || initialTrack;
            if (!current) return;
            if (initialTrack.id && current.id && current.id !== initialTrack.id) return;

            void requestHostDecisionAndApply("song_change", {
              currentTrack: current,
              nextTrack: pl?.songs?.[idx + 1] || payload.nextTrack || null,
              playlistOverride: pl || initialPlaylist || null,
              mood: payload.mood || pl?.mood || current.mood,
              justSwitchedTrack: true,
              manualReason: "opening_track_started",
              slotId: `opening-track-start-${current.id || idx || "current"}`
            });
          }, OPENING_TRACK_AI_INTRO_DELAY_MS);
        };

        const hostAudio = hostAudioRef.current;
        if (!hostAudio || hostAudio.paused || hostAudio.ended) {
          runAiIntro();
          return;
        }

        const cleanup = () => {
          hostAudio.removeEventListener("ended", handleHostDone);
          hostAudio.removeEventListener("pause", handleHostDone);
          hostAudio.removeEventListener("error", handleHostDone);
        };
        const handleHostDone = () => {
          cleanup();
          runAiIntro();
        };

        hostAudio.addEventListener("ended", handleHostDone, { once: true });
        hostAudio.addEventListener("pause", handleHostDone, { once: true });
        hostAudio.addEventListener("error", handleHostDone, { once: true });
        fallbackTimer = window.setTimeout(runAiIntro, 7000);
      };

      scheduleAiIntroAfterFixedOpening();
      hasOpenedRef.current = true;
      return {
        scene: "intro",
        reply: {
          shouldSpeak: true,
          text: openingText,
          appendToChat: true,
          voiceStyle: "warm"
        },
        tts: {
          shouldSynthesize: true,
          textSource: "reply"
        },
        actions: [{ type: "highlight_reply_only", payload: { reason: "local_opening_fixed" } }],
        priority: "high",
        source: "local-opening-fixed"
      };
    };

    const playFailureFallback = async (dynamicEvent: HostDynamicEvent) => {
      const fallbackText = buildLocalHostFallbackByEvent(dynamicEvent, {
        currentTrack: payload.currentTrack || null,
        nextTrack: payload.nextTrack || null,
        recentUserLine: payload.recentUserLine
      });
      const dedupeKey = `${dynamicEvent}:${fallbackText}`;
      const now = Date.now();
      const dedupeBlocked = lastLocalFallbackRef.current.key === dedupeKey
        && (now - lastLocalFallbackRef.current.at) < LOCAL_HOST_FALLBACK_DEDUPE_MS;
      if (dedupeBlocked) {
        return {
          scene: dynamicEvent === "song_change" ? "intro" : dynamicEvent === "user_speak" ? "reply" : "proactive",
          reply: {
            shouldSpeak: false,
            text: "",
            appendToChat: false,
            voiceStyle: "warm"
          },
          tts: {
            shouldSynthesize: false,
            textSource: "reply"
          },
          actions: [{ type: "highlight_reply_only", payload: { reason: "local_fallback_deduped" } }],
          priority: "low",
          source: "local-fallback-deduped"
        };
      }
      lastLocalFallbackRef.current = { key: dedupeKey, at: now };
	      const appendToChat = true;
	      if (appendToChat) {
	        appendHostMessage(fallbackText);
	      }
      await handleGenerateHostVoice(fallbackText, payload.slotId || `fallback-${dynamicEvent}`);
      return {
        scene: dynamicEvent === "song_change" ? "intro" : dynamicEvent === "user_speak" ? "reply" : "proactive",
        reply: {
          shouldSpeak: true,
          text: fallbackText,
          appendToChat,
          voiceStyle: dynamicEvent === "song_change" ? "soft" : "warm"
        },
        tts: {
          shouldSynthesize: true,
          textSource: "reply"
        },
        actions: [{ type: "highlight_reply_only", payload: { reason: "local_fallback_on_error" } }],
        priority: "medium",
        source: `local-fallback-${dynamicEvent}`
      };
    };

    if (event === "page_opened") {
      if (hasOpenedRef.current) {
        return {
          reply: { shouldSpeak: false, text: "", appendToChat: false, voiceStyle: "warm" },
          source: "skipped-already-opened"
        };
      }
      return playLocalOpening();
    }

    const dynamicEvent = mapLegacyEventToDynamic(event);
    if (!dynamicEvent) {
      return {
        reply: { shouldSpeak: false, text: "", appendToChat: false, voiceStyle: "warm" },
        source: "skipped-unsupported-event"
      };
    }

    let result;
    try {
      const playlistContext = payload.playlistOverride || playlistRef.current;
      const recentTranscript = payload.recentTranscriptOverride || buildApiHistory(chatHistoryRef.current.slice(-DJ_ANALYSIS_HISTORY_LIMIT));
      result = await requestHostDecision({
        sessionId: getOrCreateHostSessionId(),
        event: dynamicEvent,
        allowedActions: payload.allowedActions || buildAllowedActions(dynamicEvent),
        context: {
          currentTrack: toHostTrackPayload(payload.currentTrack),
          nextTrack: toHostTrackPayload(payload.nextTrack),
          playlist: playlistContext ? {
            id: playlistContext.id,
            mood: playlistContext.mood,
            source: playlistContext.source,
            songCount: playlistContext.songs.length,
            currentIndex: payload.playlistOverride ? 0 : currentSongIndexRef.current,
          } : null,
          mood: payload.mood || playlistContext?.mood || playlistContext?.songs?.[currentSongIndexRef.current]?.mood || "",
          recentUserLine: payload.recentUserLine,
          recentTranscript,
          dayPart: getCurrentDayPart(),
          playbackProgressMs: getPlaybackProgressMs(),
          isPlaying: isPlayingRef.current,
          justSwitchedTrack: Boolean(payload.justSwitchedTrack),
	          manualReason: payload.manualReason,
	          generatedSummary: payload.generatedSummary,
	          musicGenerationStatus: payload.musicGenerationStatus,
	          recentHostSummary: payload.recentHostSummaryOverride ?? getRecentHostSummary(),
        }
      });
    } catch {
      if (event === "page_opened") {
        return {
          scene: "intro",
          reply: { shouldSpeak: false, text: "", appendToChat: false, voiceStyle: "warm" },
          tts: { shouldSynthesize: false, textSource: "reply" },
          actions: [],
          source: "skipped-opening-ai-failed"
        };
      }
      return playFailureFallback(dynamicEvent);
    }

    if (shouldDropStaleOpeningReply()) {
      return {
        reply: { shouldSpeak: false, text: "", appendToChat: false, voiceStyle: "warm" },
        actions: [],
        source: "skipped-stale-opening"
      };
    }
    if (event === "page_opened") {
      hasOpenedRef.current = true;
    }

	    const spokenText = typeof result?.reply?.text === "string" ? result.reply.text.trim() : "";
	    const hasExplicitAppendOverride = typeof payload.appendOverride === "boolean";
	    const shouldSpeak = Boolean(result?.reply?.shouldSpeak && spokenText);
	    const shouldSynthesize = Boolean(result?.tts?.shouldSynthesize && spokenText);
	    const shouldAppend = Boolean(
	      spokenText && (
	        hasExplicitAppendOverride
	          ? payload.appendOverride
	          : Boolean(result?.reply?.appendToChat || shouldSpeak || shouldSynthesize)
	      )
	    );
	    const shouldSuppressFollowups = shouldSpeak || shouldSynthesize;

    if (shouldAppend) {
      appendHostMessage(spokenText);
    }

    if (shouldSpeak && shouldSynthesize) {
      await handleGenerateHostVoice(spokenText, payload.slotId || `${result.scene || dynamicEvent}-${payload.currentTrack?.id || "host"}`);
    }

    const resultMusicAction = result && typeof result === "object" && "music_action" in result
      ? result.music_action
      : null;
    const actionsToApply = Array.isArray(result?.actions) && result.actions.length > 0
      ? result.actions
      : resultMusicAction?.type
        ? [{
          type: resultMusicAction.type,
          payload: {
            mood: resultMusicAction.mood,
            reason: resultMusicAction.reason
          }
        }]
        : [];

    if (actionsToApply.length > 0) {
      await applyHostActions(actionsToApply, { skipHostDecision: shouldSuppressFollowups });
    }

    return result;
    } finally {
      if (shouldMarkHostDecisionInFlight) {
        hostDecisionInFlightRef.current = false;
      }
    }
  }, [applyHostActions, startGeneratedPlaylist]);

  const runCoordinatedHostBroadcast = useCallback(async (
    event: "song_change" | "proactive",
    payload: Parameters<typeof requestHostDecisionAndApply>[1] = {},
    options?: { minGapMs?: number }
  ) => {
    const now = Date.now();
    const minGapMs = options?.minGapMs ?? HOST_TRIGGER_DEBOUNCE_MS;
    if (typeof document !== "undefined" && document.hidden) return null;
    if (hostDecisionInFlightRef.current || isGeneratingVoiceRef.current) return null;
    if (now - lastHostTriggerStartedAtRef.current < minGapMs) return null;

    const hostAudio = hostAudioRef.current;
    if (hostAudio && !hostAudio.paused) return null;

    return requestHostDecisionAndApply(event, payload);
  }, [requestHostDecisionAndApply]);

  const scheduleOpeningTrackStartBroadcast = useCallback((payload: {
    currentTrack?: Song | null;
    nextTrack?: Song | null;
    playlistOverride?: Playlist | null;
    mood?: string;
    manualReason?: string;
    slotId?: string;
  }) => {
    if (!AUTO_SCHEDULED_HOST_TASKS_ENABLED) return;
    const currentTrack = payload.currentTrack || playlistRef.current?.songs?.[currentSongIndexRef.current] || null;
    if (!currentTrack) return;

    const key = `${payload.playlistOverride?.id || playlistRef.current?.id || "playlist"}:${currentTrack.id || currentTrack.title}:opening-track-start`;
    if (openingTrackStartHostKeyRef.current === key) return;
    openingTrackStartHostKeyRef.current = key;

    const clearPendingTimer = () => {
      if (openingTrackStartTimerRef.current !== null) {
        window.clearTimeout(openingTrackStartTimerRef.current);
        openingTrackStartTimerRef.current = null;
      }
    };

    const runAfterHostVoice = () => {
      clearPendingTimer();
      openingTrackStartTimerRef.current = window.setTimeout(() => {
        openingTrackStartTimerRef.current = null;
        const pl = playlistRef.current;
        const idx = currentSongIndexRef.current;
        const activeTrack = pl?.songs?.[idx] || null;
        const stillOnOpeningTrack = activeTrack && (
          (currentTrack.id && activeTrack.id === currentTrack.id)
          || (!currentTrack.id && activeTrack.title === currentTrack.title)
        );
        if (!stillOnOpeningTrack || !isPlayingRef.current) return;

        const startKey = `${pl?.id || "playlist"}:${activeTrack.id || activeTrack.title || idx}:start`;
        playbackStartHostKeyRef.current = startKey;
        void runCoordinatedHostBroadcast("song_change", {
          currentTrack: activeTrack,
          nextTrack: pl?.songs?.[idx + 1] || payload.nextTrack || null,
          playlistOverride: pl || payload.playlistOverride || null,
          mood: payload.mood || pl?.mood || activeTrack.mood,
          justSwitchedTrack: true,
          manualReason: payload.manualReason || "opening_track_started",
          slotId: payload.slotId || `opening-track-start-${activeTrack.id || idx}`
        }, { minGapMs: 0 });
      }, HOST_TRACK_START_BROADCAST_DELAY_MS);
    };

    const hostAudio = hostAudioRef.current;
    if (!hostAudio || hostAudio.paused || hostAudio.ended) {
      runAfterHostVoice();
      return;
    }

    const cleanup = () => {
      hostAudio.removeEventListener("ended", handleHostVoiceDone);
      hostAudio.removeEventListener("pause", handleHostVoiceDone);
      hostAudio.removeEventListener("error", handleHostVoiceDone);
    };
    const handleHostVoiceDone = () => {
      cleanup();
      runAfterHostVoice();
    };

    hostAudio.addEventListener("ended", handleHostVoiceDone, { once: true });
    hostAudio.addEventListener("pause", handleHostVoiceDone, { once: true });
    hostAudio.addEventListener("error", handleHostVoiceDone, { once: true });
  }, [runCoordinatedHostBroadcast]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let startBroadcastTimer: number | null = null;

    const handleMusicPlaybackStarted = () => {
      if (!AUTO_SCHEDULED_HOST_TASKS_ENABLED) return;
      const pl = playlistRef.current;
      const idx = currentSongIndexRef.current;
      const current = pl?.songs?.[idx];
      if (!pl?.songs?.length || !current) return;

	      const key = `${pl.id || "playlist"}:${current.id || current.title || idx}:start`;
	      if (playbackStartHostKeyRef.current === key) return;
	      playbackStartHostKeyRef.current = key;
	      const suppressInfo = suppressTrackChangedHostRef.current;
	      if (
	        suppressInfo
	        && suppressInfo.trackId === current.id
	        && Date.now() < suppressInfo.until
	      ) {
	        return;
	      }

      if (startBroadcastTimer !== null) {
        window.clearTimeout(startBroadcastTimer);
      }
      startBroadcastTimer = window.setTimeout(() => {
        startBroadcastTimer = null;
        void runCoordinatedHostBroadcast("song_change", {
          currentTrack: current,
          nextTrack: pl.songs[idx + 1] || null,
          mood: pl.mood,
          justSwitchedTrack: true,
          manualReason: "playback_started",
          slotId: `playback-start-${current.id || idx}`
        }, { minGapMs: 0 });
      }, HOST_TRACK_START_BROADCAST_DELAY_MS);
    };

    audio.addEventListener("play", handleMusicPlaybackStarted);
    return () => {
      if (startBroadcastTimer !== null) {
        window.clearTimeout(startBroadcastTimer);
      }
      audio.removeEventListener("play", handleMusicPlaybackStarted);
    };
	  }, [runCoordinatedHostBroadcast]);

	  useEffect(() => () => {
	    if (userSkipHostTimerRef.current !== null) {
	      window.clearTimeout(userSkipHostTimerRef.current);
	      userSkipHostTimerRef.current = null;
	    }
	    if (openingTrackStartTimerRef.current !== null) {
	      window.clearTimeout(openingTrackStartTimerRef.current);
	      openingTrackStartTimerRef.current = null;
	    }
	  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimedTrackHostCue = () => {
      if (!AUTO_SCHEDULED_HOST_TASKS_ENABLED) return;
      if (!isPlayingRef.current || audio.paused || audio.ended) return;

      const pl = playlistRef.current;
      const idx = currentSongIndexRef.current;
      const current = pl?.songs?.[idx];
      if (!pl?.songs?.length || !current) return;

      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : parseDurationToSeconds(current.duration);
      const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      if (duration <= 0 || currentTime <= 0) return;

      const trackKeyBase = `${pl.id || "playlist"}:${current.id || current.title || idx}`;
      const recentHistory = chatHistoryRef.current.slice(-DJ_ANALYSIS_HISTORY_LIMIT);
      const recentUserLine = [...recentHistory].reverse().find((item) => item.role === "user")?.content;

      const middleAtSeconds = Math.max(HOST_MIDDLE_MIN_PLAY_MS / 1000, duration * 0.5);
      const hasEnoughRoomBeforeEnding = (duration - currentTime) > (HOST_NEAR_END_TRIGGER_SECONDS + 6);
      const middleKey = `${trackKeyBase}:middle`;
      if (
        currentTime >= middleAtSeconds
        && hasEnoughRoomBeforeEnding
        && middleHostKeyRef.current !== middleKey
      ) {
        middleHostKeyRef.current = middleKey;
        void runCoordinatedHostBroadcast("proactive", {
          currentTrack: current,
          nextTrack: pl.songs[idx + 1] || null,
          mood: pl.mood,
          recentUserLine,
          manualReason: "track_middle",
          slotId: `host-middle-${current.id || idx}`
        });
        return;
      }

      if ((duration - currentTime) > HOST_NEAR_END_TRIGGER_SECONDS) return;
      if ((currentTime * 1000) < HOST_TOPIC_MIN_PLAY_MS) return;

      const nearEndKey = `${trackKeyBase}:near-end`;
      if (nearEndHostKeyRef.current === nearEndKey) return;
      nearEndHostKeyRef.current = nearEndKey;

      void runCoordinatedHostBroadcast("proactive", {
        currentTrack: current,
        nextTrack: pl.songs[idx + 1] || null,
        mood: pl.mood,
        recentUserLine,
        manualReason: "near_track_end",
        slotId: `host-near-end-${current.id || idx}`
      });
    };

    audio.addEventListener("timeupdate", handleTimedTrackHostCue);
    audio.addEventListener("durationchange", handleTimedTrackHostCue);
    return () => {
      audio.removeEventListener("timeupdate", handleTimedTrackHostCue);
      audio.removeEventListener("durationchange", handleTimedTrackHostCue);
    };
  }, [runCoordinatedHostBroadcast]);

  const moods: MoodOption[] = [
    { key: "happy", label: "开心", icon: Sun },
    { key: "relaxed", label: "放松", icon: Leaf },
    { key: "focused", label: "专注", icon: Target },
    { key: "energetic", label: "活力", icon: Zap },
    { key: "romantic", label: "浪漫", icon: Heart },
    { key: "sad", label: "安静", icon: Moon },
    { key: "nostalgic", label: "怀旧", icon: Clock3 },
    { key: "party", label: "派对", icon: PartyPopper },
  ];

  // ===== Auto-scroll chat =====
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // ===== Restore persisted client state =====
  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      // Always start a fresh conversation after refresh.
      window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
      window.localStorage.removeItem(HOST_SESSION_STORAGE_KEY);
      hostSessionIdRef.current = "default";
      setChatHistory([]);
      getOrCreateHostSessionId();

      const storedPrefs = window.localStorage.getItem(PLAYER_PREFS_STORAGE_KEY);
      if (storedPrefs) {
        const parsed = JSON.parse(storedPrefs);
        if (typeof parsed.currentSongIndex === "number" && Number.isFinite(parsed.currentSongIndex)) {
          setCurrentSongIndex(Math.max(0, Math.floor(parsed.currentSongIndex)));
        }
      }
    } catch (error) {
      console.warn("Failed to restore persisted radio state:", error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      // Keep refresh behavior stateless for chat history.
      window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
    } catch (error) {
      console.warn("Failed to clear chat history cache:", error);
    }
  }, [chatHistory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PLAYER_PREFS_STORAGE_KEY, JSON.stringify({
        currentSongIndex
      }));
    } catch (error) {
      console.warn("Failed to persist player prefs:", error);
    }
  }, [currentSongIndex]);

  // ===== Load all songs and start playback on mount =====
  useEffect(() => {
    let mounted = true;
    reportEvent("app_open");

    const startAllSongsPlayback = (
      library: SongLibraryItem[],
      index: number,
      options?: {
        hostEvent?: "song_change" | "page_opened";
        manualReason?: string;
        slotId?: string;
        triggerHost?: boolean;
      }
    ) => {
      if (!library.length) return false;
      const dedupedLibrary = dedupeSongLibraryByTitle(library);
      const requestedItem = library[Math.min(Math.max(index, 0), library.length - 1)];
      const requestedTitleKey = getSongTitleKey(requestedItem?.song);
      const matchedIndex = requestedTitleKey
        ? dedupedLibrary.findIndex((item) => getSongTitleKey(item.song) === requestedTitleKey)
        : -1;
      const safeIndex = matchedIndex >= 0
        ? matchedIndex
        : Math.min(Math.max(index, 0), dedupedLibrary.length - 1);
      const selected = dedupedLibrary[safeIndex];
      if (!selected) return false;
      const songs = dedupedLibrary.map((item) => item.song);
      const fullListPlaylist: Playlist = {
        id: `all-songs-${Date.now()}`,
        mood: selected.playlistMood || selected.song.mood || "relaxed",
        prompt: "全部歌曲连续播放",
        generatedAt: new Date().toISOString(),
        source: "history-all",
        songs,
      };

      setPlaylist(fullListPlaylist);
      setCurrentSongIndex(safeIndex);
      setIsPlaying(true);

	      if (options?.triggerHost !== false && options?.hostEvent === "page_opened") {
	        const hostEvent = "page_opened";
	        const openingPayload = {
	          currentTrack: selected.song,
	          nextTrack: songs[safeIndex + 1] || null,
	          playlistOverride: fullListPlaylist,
	          mood: selected.playlistMood || selected.song.mood || "relaxed",
	          justSwitchedTrack: false,
	          manualReason: options?.manualReason,
	          slotId: options?.slotId || `opening-song-${selected.song.id || safeIndex}`
	        };
	        void requestHostDecisionAndApply(hostEvent, openingPayload).finally(() => {
	          scheduleOpeningTrackStartBroadcast({
	            currentTrack: selected.song,
	            nextTrack: songs[safeIndex + 1] || null,
	            playlistOverride: fullListPlaylist,
	            mood: selected.playlistMood || selected.song.mood || "relaxed",
	            manualReason: "opening_track_started",
	            slotId: `opening-track-start-${selected.song.id || safeIndex}`
	          });
	        });
	      }

      return true;
    };

    void (async () => {
      try {
        const historyResult = await getPlaylistHistory(200) as { items?: PlaylistHistoryItem[] };
        if (!mounted) return;
        const library = buildSongLibrary(Array.isArray(historyResult?.items) ? historyResult.items : [], null);
        if (library.length > 0) {
          setAllSongsLibrary(library);
          allSongsLibraryRef.current = library;
          const randomIndex = Math.floor(Math.random() * library.length);
          const started = startAllSongsPlayback(library, randomIndex, {
            hostEvent: "page_opened",
            manualReason: "opening_all_songs",
            triggerHost: AUTO_OPENING_VOICE_ENABLED
          });
          if (started && AUTO_OPENING_VOICE_ENABLED) {
            openingVoicePlayedRef.current = true;
          }
          return;
        }
      } catch {}

      try {
        const data = await getOpeningPlaylist();
        if (!mounted) return;
        if (data.id && Array.isArray(data.songs) && data.songs.length > 0) {
          const fallbackLibrary = buildSongLibrary([], data);
          setAllSongsLibrary(fallbackLibrary);
          allSongsLibraryRef.current = fallbackLibrary;
          const started = startAllSongsPlayback(fallbackLibrary, 0, {
            hostEvent: "page_opened",
            manualReason: "opening_fallback",
            triggerHost: AUTO_OPENING_VOICE_ENABLED
          });
          if (started && AUTO_OPENING_VOICE_ENABLED) {
            openingVoicePlayedRef.current = true;
          }
          return;
        }
      } catch {}

      if (!AUTO_OPENING_VOICE_ENABLED || !mounted || openingVoicePlayedRef.current) return;
      openingVoicePlayedRef.current = true;
      void requestHostDecisionAndApply("page_opened", {
        currentTrack: null,
        nextTrack: null,
        mood: "",
        slotId: "opening-welcome-fallback"
      });
    })();

    return () => { mounted = false; };
	  }, [buildSongLibrary, reportEvent, requestHostDecisionAndApply, scheduleOpeningTrackStartBroadcast]);

  useEffect(() => {
    if (!playlist?.songs?.length) {
      if (currentSongIndex !== 0) {
        setCurrentSongIndex(0);
      }
      return;
    }

    const dedupedSongs = dedupeSongsByTitle(playlist.songs);
    if (dedupedSongs.length !== playlist.songs.length) {
      const activeTitleKey = getSongTitleKey(playlist.songs[currentSongIndex]);
      const nextIndex = activeTitleKey
        ? dedupedSongs.findIndex((song) => getSongTitleKey(song) === activeTitleKey)
        : -1;
      setPlaylist({ ...playlist, songs: dedupedSongs });
      setCurrentSongIndex(nextIndex >= 0 ? nextIndex : Math.min(currentSongIndex, dedupedSongs.length - 1));
      return;
    }

    if (currentSongIndex >= playlist.songs.length) {
      setCurrentSongIndex(playlist.songs.length - 1);
    }
  }, [playlist, currentSongIndex]);

  // ===== Audio ended handler =====
  const handleAudioEnded = useCallback(() => {
    reportEvent("song_end");
    const pl = playlistRef.current;
    const idx = currentSongIndexRef.current;
    if (pl && idx < pl.songs.length - 1) {
      setCurrentSongIndex((prev) => prev + 1);
      return;
    }
    const library = dedupeSongLibraryByTitle(allSongsLibraryRef.current);
    allSongsLibraryRef.current = library;
    if (!library.length) {
      if (pl?.songs?.length) {
        const fallbackSongs = dedupeSongsByTitle(pl.songs);
        const currentTitleKey = getSongTitleKey(pl.songs[idx]);
        const fallbackIndexes = fallbackSongs
          .map((song, songIndex) => ({ song, songIndex }))
          .filter(({ song }) => getSongTitleKey(song) !== currentTitleKey)
          .map(({ songIndex }) => songIndex);
        const nextIndex = fallbackIndexes.length
          ? fallbackIndexes[Math.floor(Math.random() * fallbackIndexes.length)]
          : 0;
        setPlaylist({ ...pl, songs: fallbackSongs });
        setCurrentSongIndex(nextIndex);
        setIsPlaying(true);
        return;
      }
      setIsPlaying(false);
      return;
    }

    const currentTrackId = pl?.songs?.[idx]?.id || "";
    const candidateIndexes = library
      .map((_, libraryIndex) => libraryIndex)
      .filter((libraryIndex) => library[libraryIndex]?.song?.id !== currentTrackId);
    const nextLibraryIndex = candidateIndexes.length
      ? candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)]
      : 0;
    const selected = library[nextLibraryIndex];
    const fullListPlaylist = buildAllSongsPlaybackPlaylist(
      library,
      selected?.playlistMood || selected?.song?.mood || "relaxed"
    );

    if (selected && fullListPlaylist) {
      setPlaylist(fullListPlaylist);
      setCurrentSongIndex(nextLibraryIndex);
      setIsPlaying(true);
      return;
    }

    setIsPlaying(false);
  }, [buildAllSongsPlaybackPlaylist, reportEvent]);

  const runAutoPlaylistGeneration = async (history: ChatMessage[]) => {
    if (isAutoGenerating || autoGenerateInFlightRef.current) {
      pendingAutoHistoryRef.current = history;
      return;
    }
    const hasUserMessage = history.some((item) => item.role === "user");
    const hasAssistantReply = history.some((item) => item.role === "assistant");
    if (!hasUserMessage || !hasAssistantReply || history.length < 3) return;

    const apiHistory = buildApiHistory(history);
    const signature = buildAutoGenerateSignature(history);
    if (lastAutoGenerateSignatureRef.current === signature) return;

    const strategy = decidePlaylistStrategy({
      mood: inferMoodFromHistory(history),
      triggerType: "chat_auto",
    });
    if (strategy.mode === "local" && strategy.localIndex >= 0) {
      const localItem = allSongsLibraryRef.current[strategy.localIndex];
      lastAutoGenerateSignatureRef.current = signature;
      if (localItem) {
        reportEvent("playlist_auto_started", {
          playlistId: localItem.playlistId,
          songId: localItem.song.id,
          mood: localItem.playlistMood || localItem.song.mood || strategy.mood,
          tags: localItem.song.tags || [],
          context: {
            source: "chat_auto_local",
            strategyReason: strategy.reason,
            localScore: strategy.localScore,
            cooldownRemainingMs: strategy.cooldownRemainingMs,
          }
        });
        startAllSongsPlaybackAtIndex(allSongsLibraryRef.current, strategy.localIndex, {
          manualReason: "chat_auto_local",
          slotId: `chat-auto-local-${localItem.song.id || strategy.localIndex}`,
        });
      }
      return;
    }

    if (strategy.mode === "blocked") {
      lastAutoGenerateSignatureRef.current = signature;
      return;
    }

    autoGenerateInFlightRef.current = true;
    setIsAutoGenerating(true);
    setIsGeneratingPlaylist(true);

    try {
      const result = await generatePlaylistFromConversation(apiHistory, 2);
      lastAutoGenerateSignatureRef.current = signature;
      reportEvent("playlist_auto_started", {
        playlistId: result.playlist?.id || null,
        mood: result.playlist?.mood || null,
        tags: result.playlist?.songs?.flatMap((song: Song) => song.tags || []).slice(0, 8) || [],
        context: {
          source: "chat_auto",
          strategyReason: strategy.reason,
          localScore: strategy.localScore,
        }
      });
      if (result?.playlist?.songs?.length) {
        if (result.playlist?.source === "suno-official") {
          lastSunoGenerationAtRef.current = Date.now();
        }
        const playlistForLibrary: Playlist = {
          id: result.playlist.id || `generated-${Date.now()}`,
          mood: result.playlist.mood || "relaxed",
          prompt: result.playlist.prompt || "自动生成歌单",
          generatedAt: result.playlist.generatedAt || new Date().toISOString(),
          source: result.playlist.source || "generated-song",
          songs: result.playlist.songs,
        };
        const { mergedLibrary, startIndex } = appendGeneratedSongsToLibrary(playlistForLibrary);
        allSongsLibraryRef.current = mergedLibrary;
        setAllSongsLibrary(mergedLibrary);

        const selected = mergedLibrary[startIndex];
        const songs = mergedLibrary.map((item) => item.song);
        const fullListPlaylist: Playlist = {
          id: `all-songs-${Date.now()}`,
          mood: selected?.playlistMood || selected?.song?.mood || "relaxed",
          prompt: "全部歌曲连续播放",
          generatedAt: new Date().toISOString(),
          source: "history-all",
          songs,
        };

        if (selected) {
          setPlaylist(fullListPlaylist);
          setCurrentSongIndex(startIndex);
          setIsPlaying(true);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsAutoGenerating(false);
      setIsGeneratingPlaylist(false);
      autoGenerateInFlightRef.current = false;

      const queuedHistory = pendingAutoHistoryRef.current;
      if (queuedHistory) {
        pendingAutoHistoryRef.current = null;
        void runAutoPlaylistGeneration(queuedHistory);
      }
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.addEventListener("ended", handleAudioEnded);
      return () => audio.removeEventListener("ended", handleAudioEnded);
    }
  }, [handleAudioEnded]);

  // ===== Play current song when index changes =====
	  useEffect(() => {
	    if (playlist && isPlaying) {
	      const song = playlist.songs[currentSongIndex];
	      void playSongAndSyncState(song);
	    }
	  }, [currentSongIndex, playlist, isPlaying, playSongAndSyncState]);

  // ===== Resume autoplay after first user interaction =====
  useEffect(() => {
    if (typeof window === "undefined") return;
    const resume = () => {
      if (pendingHostVoiceAutoplayRef.current && hostAudioRef.current) {
        hostAudioRef.current.play().then(() => {
          pendingHostVoiceAutoplayRef.current = false;
        }).catch(() => {});
      }
      if (!pendingAutoplayRef.current) return;
	      const pl = playlistRef.current;
	      if (!pl?.songs?.length) return;
	      const song = pl.songs[currentSongIndexRef.current];
	      playSongAndSyncState(song).then((ok) => {
	        if (ok) {
	          pendingAutoplayRef.current = false;
	        }
	      }).catch(() => {});
    };
    window.addEventListener("click", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("click", resume);
      window.removeEventListener("keydown", resume);
    };
	  }, [playSongAndSyncState]);

  useEffect(() => {
    const hostAudio = hostAudioRef.current;
    if (!hostAudio) return;

    const lowerMusicVolume = () => {
      const music = audioRef.current;
      if (!music) return;
      musicVolumeBeforeHostVoiceRef.current = Number.isFinite(music.volume) ? music.volume : DEFAULT_PLAYBACK_VOLUME;
      // iOS Safari ignores HTMLMediaElement.volume, so use Web Audio gain when possible.
      const appliedViaGain = setMediaOutputGain(music, 0.22);
      if (!appliedViaGain) {
        music.volume = Math.max(0.08, musicVolumeBeforeHostVoiceRef.current * 0.22);
      }
    };

    const restoreMusicVolume = () => {
      const music = audioRef.current;
      if (!music) return;
      const appliedViaGain = setMediaOutputGain(music, 1, 0.12);
      if (!appliedViaGain) {
        music.volume = musicVolumeBeforeHostVoiceRef.current || DEFAULT_PLAYBACK_VOLUME;
      }
    };

    hostAudio.addEventListener("play", lowerMusicVolume);
    hostAudio.addEventListener("ended", restoreMusicVolume);
    hostAudio.addEventListener("pause", restoreMusicVolume);
    hostAudio.addEventListener("emptied", restoreMusicVolume);
    hostAudio.addEventListener("error", restoreMusicVolume);

    return () => {
      hostAudio.removeEventListener("play", lowerMusicVolume);
      hostAudio.removeEventListener("ended", restoreMusicVolume);
      hostAudio.removeEventListener("pause", restoreMusicVolume);
      hostAudio.removeEventListener("emptied", restoreMusicVolume);
      hostAudio.removeEventListener("error", restoreMusicVolume);
    };
  }, []);

  useEffect(() => {
    const hostAudio = hostAudioRef.current;
    if (!hostAudio) return;

    const syncSpeakingState = () => {
      setIsHostSpeaking(!hostAudio.paused && !hostAudio.ended);
    };

    syncSpeakingState();
    hostAudio.addEventListener("play", syncSpeakingState);
    hostAudio.addEventListener("pause", syncSpeakingState);
    hostAudio.addEventListener("ended", syncSpeakingState);
    hostAudio.addEventListener("emptied", syncSpeakingState);
    hostAudio.addEventListener("error", syncSpeakingState);

    return () => {
      hostAudio.removeEventListener("play", syncSpeakingState);
      hostAudio.removeEventListener("pause", syncSpeakingState);
      hostAudio.removeEventListener("ended", syncSpeakingState);
      hostAudio.removeEventListener("emptied", syncSpeakingState);
      hostAudio.removeEventListener("error", syncSpeakingState);
    };
  }, []);

  // ===== Chat =====
  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatting) return;
    const userMessage: ChatMessage = { role: "user", content: chatInput.trim(), timestamp: new Date() };
    lastUserInteractionAtRef.current = Date.now();
    setChatHistory((prev) => [...prev, userMessage]);
    setChatInput("");
    setIsChatting(true);
    reportEvent("chat_send", { messageExcerpt: userMessage.content.slice(0, 120) });
	    try {
	      const nextChatHistory = [...chatHistoryRef.current, userMessage];
	      const generationGuard = getUserSpeakGenerationGuard();
	      const result = await requestHostDecisionAndApply("user_speak", {
	        currentTrack: playlistRef.current?.songs?.[currentSongIndexRef.current] || null,
	        nextTrack: playlistRef.current?.songs?.[currentSongIndexRef.current + 1] || null,
	        mood: playlistRef.current?.mood || "",
	        recentUserLine: userMessage.content,
	        recentTranscriptOverride: buildApiHistory(nextChatHistory),
	        musicGenerationStatus: generationGuard.status,
	        slotId: `listener-reply-${Date.now()}`,
	        allowedActions: generationGuard.blocked
	          ? buildUserSpeakAllowedActions()
	          : ["noop", "highlight_reply_only", "pause_music", "resume_music", "skip_next", "skip_prev", "play_track", "play_local_match", "generate_song", "switch_to_all_songs"]
	      });

      const hasReply = Boolean(result?.reply?.text);
      const resultMusicAction = result && typeof result === "object" && "music_action" in result
        ? result.music_action
        : null;
      const hasMeaningfulAction = Boolean(
        resultMusicAction?.type
        || result?.actions?.some((action) => action?.type && action.type !== "noop" && action.type !== "highlight_reply_only")
      );
      if (!hasReply && !hasMeaningfulAction) return;
    } catch {
      return;
    } finally {
      setIsChatting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
  };

  // ===== Playlist =====
	  const handleGeneratePlaylist = async (mood: string) => {
	    lastUserInteractionAtRef.current = Date.now();
	    setActiveMoodKey(mood as MoodKey);
	    reportEvent("tag_click", { mood, tags: [mood] });
	    setIsGeneratingPlaylist(true);
	    try {
	      const moodLabel = moodLabels[mood as keyof typeof moodLabels] || mood;
	      const moodBrief = moodSceneBriefs[mood] || moodSceneBriefs.relaxed;
	      const result = await startGeneratedPlaylist(mood, {
	        triggerType: "mood_click",
	        summary: `听众点了${moodLabel}氛围，想让音乐把这一刻扩展成一个更完整的场景：${moodBrief.scene}。`,
	        themeTags: [moodLabel],
	        musicDirection: [moodBrief.sound]
	      });
      if (!result?.songs?.length) {
        setActiveMoodKey(playlistRef.current?.mood && playlistRef.current.mood in moodLabels
          ? playlistRef.current.mood as MoodKey
          : null);
      }
    } catch (err) { console.error(err); }
    finally { setIsGeneratingPlaylist(false); }
  };

  // ===== Player =====
  const togglePlay = () => {
    if (!playlist) return;
    if (isPlaying) {
      const playbackSeconds = Math.round((Date.now() - songStartTimeRef.current) / 1000);
      reportEvent("pause", { context: { playbackSeconds } });
      audioRef.current?.pause();
      setIsPlaying(false);
	    } else {
	      const song = playlist.songs[currentSongIndex];
	      pendingAutoplayRef.current = false;
	      reportEvent("play");
	      void playSongAndSyncState(song);
	    }
  };

	  const skipSong = (direction: number) => {
	    if (!playlist) return;
	    const newIndex = currentSongIndex + direction;
	    if (newIndex >= 0 && newIndex < playlist.songs.length) {
	      reportEvent(direction > 0 ? "skip_next" : "skip_prev");
	      const nextSong = playlist.songs[newIndex];
	      const targetTrackId = nextSong?.id || "";
	      const manualReason = direction > 0 ? "user_skip_next" : "user_skip_prev";
	      if (targetTrackId) {
	        suppressTrackChangedHostRef.current = {
	          trackId: targetTrackId,
	          until: Date.now() + USER_SKIP_HOST_SUPPRESS_MS
	        };
	      }
	      if (userSkipHostTimerRef.current !== null) {
	        window.clearTimeout(userSkipHostTimerRef.current);
	      }
	      const requestUserSkipHostBroadcast = (attempt = 0) => {
	        userSkipHostTimerRef.current = null;
	        const pl = playlistRef.current;
	        const idx = currentSongIndexRef.current;
	        const current = pl?.songs?.[idx];
	        if (!pl?.songs?.length || !current || !isPlayingRef.current) return;
	        if (targetTrackId && current.id !== targetTrackId) return;

	        const hostAudio = hostAudioRef.current;
	        const hostBusy = hostDecisionInFlightRef.current
	          || isGeneratingVoiceRef.current
	          || Boolean(hostAudio && !hostAudio.paused && !hostAudio.ended);
	        if (hostBusy && attempt < 6) {
	          userSkipHostTimerRef.current = window.setTimeout(() => {
	            requestUserSkipHostBroadcast(attempt + 1);
	          }, 1200);
	          return;
	        }

	        suppressTrackChangedHostRef.current = null;
	        void requestHostDecisionAndApply("song_change", {
	          currentTrack: current,
	          nextTrack: pl.songs[idx + 1] || null,
	          mood: pl.mood,
	          justSwitchedTrack: true,
	          manualReason,
	          slotId: `user-skip-${current.id || idx}`
	        });
	      };
	      userSkipHostTimerRef.current = window.setTimeout(() => {
	        requestUserSkipHostBroadcast();
	      }, USER_SKIP_HOST_SUPPRESS_MS);
	      setCurrentSongIndex(newIndex);
	    }
	  };

  const playFromAllSongs = (index: number) => {
    if (!allSongsLibrary.length || index < 0 || index >= allSongsLibrary.length) return;
    lastUserInteractionAtRef.current = Date.now();
    startAllSongsPlaybackAtIndex(allSongsLibrary, index, {
      closePanel: true,
      manualReason: "playlist_manual_select",
      slotId: `track-change-manual-${allSongsLibrary[index]?.song.id || index}`,
    });
  };

  // ===== Host Voice =====
  const handleGenerateHostVoice = async (text: string, slotId?: string) => {
    setIsGeneratingVoice(true);
    try {
      const result = await generateHostVoice(text, slotId);
      const fullUrl = result.audioUrl.startsWith("http")
        ? result.audioUrl
        : `${getApiBase()}${result.audioUrl}`;
      if (hostAudioRef.current) {
        hostAudioRef.current.src = fullUrl;
        hostAudioRef.current.play().then(() => {
          pendingHostVoiceAutoplayRef.current = false;
        }).catch((error: unknown) => {
          if (error instanceof Error && error.name === "NotAllowedError") {
            pendingHostVoiceAutoplayRef.current = true;
          }
        });
      }
    } catch (err) { console.error(err); }
    finally { setIsGeneratingVoice(false); }
  };

  const currentSong = playlist?.songs[currentSongIndex];
  const currentThemeMood: MoodKey = activeMoodKey || "happy";
  const playerArtistLine = currentSong ? "Suno AI" : "选择心情，生成专属音乐";
  const totalDurationSeconds = parseDurationToSeconds(currentSong?.duration);
  const currentDurationLabel = formatDurationLabel(playbackCurrentTime);
  const totalDurationLabel = currentSong?.duration || formatDurationLabel(totalDurationSeconds) || "00:00";
  const playlistCount = allSongsLibrary.length || playlist?.songs?.length || 0;
  const hostSummary = currentSong
    ? `正在陪你播放 ${currentSong.title}，也会顺着音乐主动和你聊聊。`
    : "电台主播会陪你聊天、陪你听歌，也会顺着当下的气氛主动开个话题。";

  return (
    <div className="phone-shell" data-mood={currentThemeMood}>
      {/* Hidden audio elements */}
      <audio ref={audioRef} crossOrigin="anonymous" style={{ display: "none" }} />
      <audio ref={hostAudioRef} crossOrigin="anonymous" style={{ display: "none" }} />
      <div className="phone-content">
        <header className="station-topbar">
          <div className="station-app-icon" aria-hidden="true">
            <img src="/aura-host-avatar.png" alt="" className="station-app-icon-image" />
          </div>
          <div className="station-brand">
            <h1>R-STUDIO</h1>
            <div className="station-brand-row">
              <span>私人电台</span>
            </div>
          </div>
          <div className="station-signal" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
        </header>

        <section className="proto-card station-time-card">
          <span className="station-spark spark-1" />
          <span className="station-spark spark-2" />
          <span className="station-spark spark-3" />
          <span className="station-spark spark-4" />
          <div className="station-time-value dot-matrix" suppressHydrationWarning>{clock.time}</div>
          <div className="station-date-row">
            <span suppressHydrationWarning>{clock.date}</span>
          </div>
        </section>

        <section className="proto-card station-player-card">
          <div className="station-song-top">
            <div className="station-cover" aria-hidden="true">
              <div className="station-cover-inner">
                {isPlaying ? <Disc3 size={24} className="station-cover-icon is-playing" /> : <Headphones size={24} className="station-cover-icon" />}
              </div>
            </div>
            <div className="station-song-info">
              <h2>
                {currentSong ? currentSong.title : "等待播放..."}
                <Heart size={16} strokeWidth={1.8} className="station-heart" aria-hidden="true" />
              </h2>
              <div className="station-song-artist">{playerArtistLine}</div>
            </div>
            <div className="station-wave-shell" aria-hidden="true">
              <Equalizer active={isPlaying} musicAudioRef={audioRef} hostAudioRef={hostAudioRef} />
            </div>
          </div>

          <div className="station-progress-wrap">
            <div
              ref={progressBarRef}
              className={`station-progress-bar ${isSeeking ? "is-seeking" : ""}`}
              role="slider"
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(playbackProgressPercent)}
              onPointerDown={handleProgressPointerDown}
              onPointerMove={handleProgressPointerMove}
              onPointerUp={handleProgressPointerEnd}
              onPointerCancel={handleProgressPointerEnd}
            >
              <span className="station-progress-fill" style={{ width: `${playbackProgressPercent}%` }} />
              <span className="station-progress-knob" style={{ left: `${playbackProgressPercent}%` }} />
            </div>
            <div className="station-time-labels">
              <span>{currentDurationLabel}</span>
              <span>{totalDurationLabel}</span>
            </div>
          </div>

          <div className="station-controls">
            <button
              className="station-control-btn"
              onClick={() => skipSong(-1)}
              disabled={!playlist || currentSongIndex === 0}
              aria-label="上一首"
            >
              <SkipBack size={18} />
            </button>
            <button className="station-control-btn is-primary" onClick={togglePlay} aria-label={isPlaying ? "暂停" : "播放"}>
              {isPlaying ? <Pause size={24} /> : <Play size={24} className="play-icon" />}
            </button>
            <button
              className="station-control-btn"
              onClick={() => skipSong(1)}
              disabled={!playlist || currentSongIndex >= (playlist?.songs.length || 0) - 1}
              aria-label="下一首"
            >
              <SkipForward size={18} />
            </button>
          </div>
        </section>

        <div className="station-moods-row">
          <nav
            ref={moodStripRef}
            className="station-moods"
            onWheel={handleMoodStripWheel}
          >
            {moods.map((m) => (
              <button
                key={m.key}
                className={`station-mood-chip ${activeMoodKey === m.key ? "active" : ""}`}
                onClick={() => handleGeneratePlaylist(m.key)}
                disabled={isGeneratingPlaylist}
              >
                <m.icon size={16} />
                <span>{m.label}</span>
              </button>
            ))}
          </nav>

        </div>

        <div className="station-host-chat-stack">
          <section className="proto-card station-host-card">
            <div className={`station-host-avatar ${isHostSpeaking ? "is-speaking" : ""}`} aria-hidden="true">
              <img src="/aura-host-avatar.png" alt="" className="station-host-avatar-image" />
            </div>
            <div className="station-host-copyblock">
              <h3>
                R-Studio
                <span className="station-mini-pill">电台主播</span>
              </h3>
              <p>{hostSummary}</p>
            </div>
            <button
              className="station-playlist-chip"
              onClick={() => setShowPlaylistPanel(true)}
              type="button"
              aria-label={`全部歌曲，当前 ${playlistCount} 首`}
            >
              <span className="station-playlist-chip-icon">
                <ListMusic size={15} />
              </span>
              <span className="station-playlist-chip-label">全部歌曲</span>
            </button>
          </section>

          <section className="proto-card station-chat-card">
            <div className="station-chat-scroll">
              {chatHistory.map((msg, index) => (
                <div
                  key={index}
                  className={`station-chat-row ${msg.role === "user" ? "is-user" : "is-assistant"}`}
                >
		                  <div className={`station-chat-stack ${msg.role === "user" ? "is-user" : "is-assistant"}`}>
		                    <div className={`station-chat-bubble ${msg.role === "user" ? "is-user" : "is-assistant"}`}>
		                      {msg.content}
		                    </div>
		                  </div>
                  <div className={`station-chat-avatar ${msg.role === "user" ? "is-user" : "is-assistant"}`}>
                    {msg.role === "user"
                      ? <User size={16} className="station-chat-avatar-icon" />
                      : <div className="station-bot-face is-small" />
                    }
                  </div>
                </div>
              ))}

              <div ref={chatEndRef} />
            </div>

            <div className="station-inputbar">
              <div className="station-input-icon" aria-hidden="true">
                <Bot size={20} />
              </div>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="告诉 R-Studio 你的心情..."
                className="station-input-field"
              />
              <button
                onClick={handleSendMessage}
                disabled={isChatting || !chatInput.trim()}
                className="station-send-btn"
                aria-label="发送"
              >
                <Send size={18} />
              </button>
            </div>
          </section>
        </div>
      </div>

      {showPlaylistPanel && (
        <div className="station-modal-overlay" onClick={() => setShowPlaylistPanel(false)}>
          <div className="station-modal fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="station-modal-header">
              <div className="station-modal-title">
                <ListMusic size={14} />
                <span>全部歌曲</span>
              </div>
              <button className="station-modal-close" onClick={() => setShowPlaylistPanel(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="station-modal-body">
              {allSongsLibrary.length ? (
                allSongsLibrary.map((item, index) => {
                  const song = item.song;
                  const isActive = !!currentSong
                    && currentSong.id === song.id
                    && currentSong.title === song.title
                    && currentSong.artist === song.artist;
                  return (
                  <div
                    key={item.key}
                    className={`playlist-item ${isActive ? "active" : ""}`}
                    onClick={() => {
                      reportEvent("play", { songId: song.id, playlistId: item.playlistId });
                      playFromAllSongs(index);
                    }}
                  >
                    <span className={`playlist-index ${isActive ? "active" : ""}`}>
                      {isActive && isPlaying ? <Music size={11} /> : String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="playlist-song-meta">
                      <div className={`playlist-song-title ${isActive ? "active" : ""}`}>
                        {song.title}
                      </div>
                      <div className="playlist-song-desc">
                        {song.artist} · {song.style}
                      </div>
                    </div>
                  </div>
                );
                })
              ) : (
                <div className="station-folder-empty">
                  {isGeneratingPlaylist ? "正在为你准备歌曲..." : "暂无歌曲，先选择一个心情生成。"}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
