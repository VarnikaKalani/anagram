"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { pointsForLength } from "../lib/scoring";
import type {
  ApiResponse,
  DifficultyMode,
  RoomState,
  RoomStatePayload,
  WordSubmitPayload,
  YouState
} from "../shared/types";

type ConnectionState = "connecting" | "online" | "offline";
type ToastKind = "success" | "error" | "info";

interface ToastState {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ReconnectSession {
  code: string;
  name: string;
  playerId: string;
  reconnectToken: string;
}

const SESSION_KEY = "anagram_arena_session";
const PLAYER_NAME_KEY = "anagram_arena_name";
const DIFFICULTY_LABELS: Record<DifficultyMode, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard"
};

export default function AnagramDuelApp() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("online");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [you, setYou] = useState<YouState | null>(null);
  const [nameInput, setNameInput] = useState("Player 1");
  const [selectedMode, setSelectedMode] = useState<DifficultyMode>("medium");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(Date.now());
  const [burstIds, setBurstIds] = useState<number[]>([]);
  const [roundAllValidWords, setRoundAllValidWords] = useState<string[]>([]);
  const [showRulesModal, setShowRulesModal] = useState(false);

  const myPlayer = useMemo(() => {
    if (!room || !you) return null;
    return room.players.find((player) => player.id === you.id) ?? null;
  }, [room, you]);

  const opponentPlayer = useMemo(() => {
    if (!room || !you) return null;
    return room.players.find((player) => player.id !== you.id) ?? null;
  }, [room, you]);

  const remainingMs = useMemo(() => {
    if (!room || room.status !== "playing" || room.startTime === null) return 0;
    const endAt = room.startTime + room.durationSec * 1000;
    return Math.max(0, endAt - (nowMs + clockOffsetMs));
  }, [room, nowMs, clockOffsetMs]);

  const disconnectRemainingSec = useMemo(() => {
    if (!room?.disconnectGraceEndsAt || room.status !== "playing") return 0;
    const ms = Math.max(0, room.disconnectGraceEndsAt - (nowMs + clockOffsetMs));
    return Math.ceil(ms / 1000);
  }, [room, nowMs, clockOffsetMs]);

  const currentWord = useMemo(() => {
    if (!room) return "";
    return selectedIndices.map((index) => room.letters[index] ?? "").join("");
  }, [room, selectedIndices]);

  const submitDisabled = currentWord.length < 3 || room?.status !== "playing";
  const isHost = Boolean(room && you && room.hostId === you.id);
  const connectionLabel = connectionState === "online" ? "connected" : connectionState;
  const canStart = Boolean(
    isHost &&
    room &&
    room.players.length === 2 &&
    room.players.every((player) => player.connected) &&
    connectionState === "online"
  );

  const pushToast = useCallback((text: string, kind: ToastKind = "info") => {
    setToast({ id: Date.now(), text, kind });
  }, []);

  const triggerBurst = useCallback(() => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setBurstIds((prev) => [...prev, id]);
    window.setTimeout(() => {
      setBurstIds((prev) => prev.filter((entry) => entry !== id));
    }, 750);
  }, []);

  const playSuccessTone = useCallback(() => {
    if (!soundEnabled || typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 720;
    gain.gain.value = 0.001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.start(now);
    osc.stop(now + 0.24);
    window.setTimeout(() => void ctx.close(), 260);
  }, [soundEnabled]);

  const persistSession = useCallback((session: ReconnectSession) => {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, []);

  const clearSession = useCallback(() => {
    window.sessionStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(SESSION_KEY);
  }, []);

  const applyRoomPayload = useCallback(
    (payload: RoomStatePayload, showNotice = true) => {
      setRoom(payload.room);
      setYou(payload.you);
      setClockOffsetMs(payload.serverNow - Date.now());
      persistSession({
        code: payload.room.code,
        name: payload.you.name,
        playerId: payload.you.id,
        reconnectToken: payload.you.reconnectToken
      });
      if (showNotice && payload.notice) {
        pushToast(payload.notice, "info");
      }
      if (payload.room.status !== "playing") {
        setSelectedIndices([]);
      }
      if (payload.room.status === "finished") {
        if (payload.allValidWords) {
          setRoundAllValidWords(payload.allValidWords);
        }
      } else {
        setRoundAllValidWords([]);
      }
    },
    [persistSession, pushToast]
  );

  const requestApi = useCallback(async <T,>(path: string, init?: RequestInit): Promise<ApiResponse<T>> => {
    try {
      const response = await fetch(path, {
        ...init,
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {})
        }
      });
      const parsed = (await response.json()) as ApiResponse<T>;
      if (parsed.ok) {
        setConnectionState("online");
        return parsed;
      }
      setConnectionState(response.status >= 500 ? "offline" : "online");
      return parsed;
    } catch {
      setConnectionState("offline");
      return {
        ok: false,
        errorCode: "UNKNOWN",
        message: "Unable to reach server. Please try again."
      };
    }
  }, []);

  const pollRoomState = useCallback(
    async (quiet = true) => {
      if (!room || !you) return;
      const query = new URLSearchParams({
        code: room.code,
        playerId: you.id,
        reconnectToken: you.reconnectToken,
        t: String(Date.now())
      });
      const result = await requestApi<RoomStatePayload>(`/api/room/state?${query.toString()}`);
      if (!result.ok) {
        if (result.errorCode === "ROOM_NOT_FOUND") {
          clearSession();
          setRoom(null);
          setYou(null);
          setRoundAllValidWords([]);
          if (!quiet) {
            pushToast("Room not found.", "error");
          }
        } else if (!quiet) {
          pushToast(result.message, "error");
        }
        return;
      }

      const previousStatus = room.status;
      applyRoomPayload(result.data, false);
      if (previousStatus !== "finished" && result.data.room.status === "finished") {
        if (result.data.endReason === "all_words_found") {
          pushToast("Round ended early: all valid words were found.", "info");
        } else if (result.data.endReason === "disconnect_timeout") {
          pushToast("Round ended: opponent did not reconnect in time.", "error");
        } else {
          pushToast("Time is up.", "info");
        }
      }
    },
    [applyRoomPayload, clearSession, pushToast, requestApi, room, you]
  );

  useEffect(() => {
    // Drop legacy shared session key from localStorage to avoid cross-tab identity collisions.
    window.localStorage.removeItem(SESSION_KEY);
    const storedName = window.localStorage.getItem(PLAYER_NAME_KEY);
    if (storedName) {
      setNameInput(storedName.slice(0, 24));
    }

    const rawSession = window.sessionStorage.getItem(SESSION_KEY);
    if (rawSession) {
      try {
        const session = JSON.parse(rawSession) as ReconnectSession;
        setConnectionState("connecting");
        void requestApi<RoomStatePayload>(
          `/api/room/state?${new URLSearchParams({
            code: session.code,
            playerId: session.playerId,
            reconnectToken: session.reconnectToken
          }).toString()}`
        ).then((result) => {
          if (!result.ok) {
            clearSession();
            setRoom(null);
            setYou(null);
            return;
          }
          applyRoomPayload(result.data, false);
        });
      } catch {
        clearSession();
      }
    }

    const ticker = window.setInterval(() => setNowMs(Date.now()), 120);
    return () => window.clearInterval(ticker);
  }, [applyRoomPayload, clearSession, requestApi]);

  useEffect(() => {
    if (!room || !you) {
      return;
    }
    const timer = window.setInterval(() => {
      void pollRoomState(true);
    }, 700);
    return () => window.clearInterval(timer);
  }, [pollRoomState, room, you]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && showRulesModal) {
        setShowRulesModal(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showRulesModal]);

  const submitCurrentWord = useCallback(
    async (rawWord: string) => {
      if (!room || !you) return;
      const result = await requestApi<WordSubmitPayload>("/api/word/submit", {
        method: "POST",
        body: JSON.stringify({
          code: room.code,
          playerId: you.id,
          word: rawWord
        })
      });
      if (!result.ok) {
        pushToast(result.message, "error");
        return;
      }

      applyRoomPayload(
        {
          room: result.data.room,
          you: result.data.you,
          serverNow: result.data.serverNow,
          allValidWords: result.data.allValidWords,
          endReason: result.data.endReason
        },
        false
      );

      setSelectedIndices([]);
      if (result.data.wordResult.ok) {
        triggerBurst();
        playSuccessTone();
        pushToast(
          `${result.data.wordResult.word.toUpperCase()} accepted (+${result.data.wordResult.points ?? 0})`,
          "success"
        );
      } else {
        pushToast(result.data.wordResult.message, "error");
      }

      if (result.data.endReason === "all_words_found") {
        pushToast("Round ended early: all valid words were found.", "info");
      } else if (result.data.endReason === "disconnect_timeout") {
        pushToast("Round ended: opponent did not reconnect in time.", "error");
      } else if (result.data.endReason === "time_up") {
        pushToast("Time is up.", "info");
      }
    },
    [applyRoomPayload, playSuccessTone, pushToast, requestApi, room, triggerBurst, you]
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!room || room.status !== "playing") return;

      if (event.key === "Enter") {
        event.preventDefault();
        const word = selectedIndices.map((index) => room.letters[index] ?? "").join("").toLowerCase();
        if (word.length < 3) {
          setSelectedIndices([]);
          pushToast("Words must be at least 3 letters.", "error");
          return;
        }
        if (myPlayer?.words.some((entry) => entry.text === word)) {
          setSelectedIndices([]);
          pushToast("You already found that word.", "error");
          return;
        }
        void submitCurrentWord(word);
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        setSelectedIndices((prev) => prev.slice(0, -1));
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedIndices([]);
        return;
      }

      const key = event.key.toLowerCase();
      if (!/^[a-z]$/.test(key)) return;
      const nextIndex = room.letters.findIndex((letter, index) => letter === key && !selectedIndices.includes(index));
      if (nextIndex >= 0) {
        event.preventDefault();
        setSelectedIndices((prev) => [...prev, nextIndex]);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [myPlayer, pushToast, room, selectedIndices, submitCurrentWord]);

  const createRoom = async () => {
    const cleanName = nameInput.trim().slice(0, 24);
    if (!cleanName) {
      pushToast("Enter your name first.", "error");
      return;
    }
    window.localStorage.setItem(PLAYER_NAME_KEY, cleanName);
    setConnectionState("connecting");
    const result = await requestApi<RoomStatePayload>("/api/room/create", {
      method: "POST",
      body: JSON.stringify({ name: cleanName, mode: selectedMode })
    });
    if (!result.ok) {
      pushToast(result.message, "error");
      return;
    }
    applyRoomPayload(result.data);
  };

  const joinRoom = async () => {
    const cleanName = nameInput.trim().slice(0, 24);
    const cleanCode = joinCodeInput.replace(/\D/g, "").slice(0, 6);
    if (!cleanName) {
      pushToast("Enter your name first.", "error");
      return;
    }
    if (cleanCode.length !== 6) {
      pushToast("Room code must be 6 digits.", "error");
      return;
    }
    window.localStorage.setItem(PLAYER_NAME_KEY, cleanName);
    setConnectionState("connecting");
    const result = await requestApi<RoomStatePayload>("/api/room/join", {
      method: "POST",
      body: JSON.stringify({
        code: cleanCode,
        name: cleanName
      })
    });
    if (!result.ok) {
      pushToast(result.message, "error");
      return;
    }
    applyRoomPayload(result.data);
  };

  const startRound = useCallback(async () => {
    if (!room || !you) return;
    setConnectionState("connecting");
    const result = await requestApi<RoomStatePayload>("/api/game/start", {
      method: "POST",
      body: JSON.stringify({
        code: room.code,
        playerId: you.id
      })
    });
    if (!result.ok) {
      pushToast(result.message, "error");
      return;
    }
    applyRoomPayload(result.data);
  }, [applyRoomPayload, pushToast, requestApi, room, you]);

  const tapLetter = (index: number) => {
    if (!room || room.status !== "playing") return;
    if (selectedIndices.includes(index)) return;
    setSelectedIndices((prev) => [...prev, index]);
  };

  const undoLast = () => {
    setSelectedIndices((prev) => prev.slice(0, -1));
  };

  const clearSelection = () => {
    setSelectedIndices([]);
  };

  const submitWord = () => {
    if (!room || room.status !== "playing") return;
    const word = currentWord.toLowerCase();
    if (word.length < 3) {
      setSelectedIndices([]);
      pushToast("Words must be at least 3 letters.", "error");
      return;
    }
    if (myPlayer?.words.some((entry) => entry.text === word)) {
      setSelectedIndices([]);
      pushToast("You already found that word.", "error");
      return;
    }
    void submitCurrentWord(word);
  };

  const copyCode = async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      pushToast("Room code copied.", "success");
    } catch {
      pushToast("Could not copy room code.", "error");
    }
  };

  const rematch = () => {
    void startRound();
  };

  const exitRoom = async () => {
    if (room && you) {
      await requestApi<{ ok: true }>("/api/room/leave", {
        method: "POST",
        body: JSON.stringify({
          code: room.code,
          playerId: you.id
        })
      });
    }
    clearSession();
    setRoom(null);
    setYou(null);
    setSelectedIndices([]);
    setRoundAllValidWords([]);
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 md:px-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Anagram</h1>
        <button
          type="button"
          onClick={() => setShowRulesModal(true)}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-900 transition hover:bg-slate-50"
          aria-label="Game rules"
        >
          <QuestionIcon />
        </button>
      </div>

      <AnimatePresence mode="wait">
        {!room && (
          <motion.section
            key="landing"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="panel-glass grid gap-6 rounded-2xl p-5 md:grid-cols-2 md:p-8"
          >
            <div className="space-y-4">
              <p className="inline-flex rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-700">
                Two Player
              </p>
              <h2 className="font-heading whitespace-nowrap text-[clamp(0.95rem,2.8vw,1.75rem)] font-semibold leading-tight text-slate-900">
                60 seconds. 6 letters. One winner.
              </h2>
              <p className="text-sm text-slate-600">
                Create a room, share the 6-digit code, and start when both players are connected.
              </p>
              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Your Name</label>
                <input
                  value={nameInput}
                  maxLength={24}
                  onChange={(event) => setNameInput(event.target.value)}
                  placeholder="Player name"
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm outline-none ring-slate-300 transition focus:ring-2"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <StatusDot state={connectionState} />
                Server: {connectionLabel}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="font-heading text-xl font-semibold text-slate-900">Create Room</h3>
                <p className="mt-1 text-sm text-slate-600">Generate a 6-digit code instantly.</p>
                <div className="mt-3 inline-flex rounded-xl border border-slate-300 bg-slate-50 p-1">
                  {(Object.keys(DIFFICULTY_LABELS) as DifficultyMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSelectedMode(mode)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] transition ${
                        selectedMode === mode ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {DIFFICULTY_LABELS[mode]}
                    </button>
                  ))}
                </div>
                <button
                  onClick={createRoom}
                  className="pill mt-4 w-full pill-primary"
                >
                  Create Room
                </button>
              </div>

              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="font-heading text-xl font-semibold text-slate-900">Join Room</h3>
                <p className="mt-1 text-sm text-slate-600">Enter your friend&apos;s code.</p>
                <input
                  value={joinCodeInput}
                  onChange={(event) => setJoinCodeInput(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6-digit code"
                  className="mt-3 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm tracking-[0.22em] outline-none ring-slate-300 transition focus:ring-2"
                />
                <button
                  onClick={joinRoom}
                  className="pill mt-3 w-full pill-secondary"
                >
                  Join Room
                </button>
              </div>
            </div>
          </motion.section>
        )}

        {room && (room.status === "waiting" || room.status === "ready") && (
          <motion.section
            key="lobby"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="panel-glass rounded-2xl p-5 md:p-8"
          >
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Room Code</p>
                <p className="font-heading text-4xl font-semibold tracking-[0.16em] text-slate-900">{room.code}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.12em] text-slate-500">Mode: {DIFFICULTY_LABELS[room.mode]}</p>
              </div>
              <button onClick={copyCode} className="pill pill-secondary">
                Copy Code
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {[0, 1].map((index) => {
                const player = room.players[index];
                return (
                  <div key={index} className="rounded-xl border border-slate-300 bg-white p-4">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-500">
                      Player {index + 1}
                      {player?.id === room.hostId ? " • Host" : ""}
                    </p>
                    <p className="mt-1 text-lg font-semibold text-slate-800">{player?.name ?? `Waiting...`}</p>
                    <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                      <StatusDot state={player?.connected ? "online" : "offline"} />
                      {player ? (player.connected ? "Connected" : "Disconnected") : "Not joined"}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                onClick={startRound}
                disabled={!canStart}
                className="pill rounded-xl border border-black bg-black px-6 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start Round
              </button>
              <button onClick={exitRoom} className="pill pill-secondary rounded-xl px-6 py-3">
                Exit
              </button>
            </div>
            <p className="mt-4 text-sm text-slate-600">
              {canStart
                ? "Both players are ready. You can start the round."
                : room.players.length < 2 || room.players.some((player) => !player.connected)
                  ? "Waiting for both players to connect. Use this code to join from another device."
                  : "Waiting for the host to start the round."}
            </p>
          </motion.section>
        )}

        {room && room.status === "playing" && (
          <motion.section
            key="playing"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]"
          >
            <div className="panel-glass rounded-2xl p-4 md:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="rounded-xl border border-slate-300 bg-white px-4 py-2">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Room</p>
                  <p className="font-heading text-lg font-semibold tracking-[0.12em] text-slate-900">{room.code}</p>
                  <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{DIFFICULTY_LABELS[room.mode]}</p>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2">
                  <StatusDot state={connectionState} />
                  <span className="text-xs font-semibold text-slate-600">{connectionLabel}</span>
                </div>
              </div>

              {disconnectRemainingSec > 0 && (
                <div className="mb-4 rounded-xl border border-slate-400 bg-slate-100 px-4 py-3 text-sm text-slate-700">
                  Opponent disconnected, waiting {disconnectRemainingSec}s...
                </div>
              )}

              <div className="mb-5 flex items-center gap-4">
                <TimerRing remainingMs={remainingMs} durationSec={room.durationSec} />
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <ScoreCard title="You" score={myPlayer?.score ?? 0} words={myPlayer?.words.length ?? 0} />
                  <ScoreCard title={opponentPlayer?.name ?? "Opponent"} score={opponentPlayer?.score ?? 0} words={opponentPlayer?.words.length ?? 0} />
                </div>
              </div>

              <div className="grid grid-cols-6 gap-2">
                {room.letters.map((letter, index) => {
                  const used = selectedIndices.includes(index);
                  return (
                    <button
                      key={`${letter}-${index}`}
                      onClick={() => tapLetter(index)}
                      disabled={used}
                      className="tile-tap rounded-xl border border-slate-400 bg-slate-100 py-4 text-2xl font-semibold uppercase text-slate-900 disabled:opacity-35"
                    >
                      {letter}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 rounded-xl border border-slate-300 bg-white p-3">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Current Word</p>
                <p className="font-heading text-3xl font-semibold tracking-[0.1em] text-slate-900">{currentWord || "—"}</p>
                <p className="text-xs text-slate-500">
                  {currentWord.length > 0 ? `${currentWord.length} letters • ${pointsForLength(currentWord.length)} pts` : "Tap letters in order"}
                </p>
              </div>

              <div className="relative mt-3 grid grid-cols-3 gap-2">
                <button onClick={undoLast} className="pill pill-secondary rounded-xl py-3 text-sm">
                  Backspace
                </button>
                <button onClick={clearSelection} className="pill pill-secondary rounded-xl py-3 text-sm">
                  Clear
                </button>
                <button
                  onClick={submitWord}
                  disabled={submitDisabled}
                  className="pill rounded-xl border border-black bg-black py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Submit
                </button>

                <div className="pointer-events-none absolute inset-0">
                  {burstIds.map((id) => (
                    <ConfettiBurst key={id} seed={id} />
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="panel-glass rounded-2xl p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-heading text-lg font-semibold text-slate-900">Your Words</h3>
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={soundEnabled}
                        onChange={(event) => setSoundEnabled(event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Sound
                    </label>
                  </div>
                </div>
                <p className="mb-3 text-xs text-slate-600">Opponent words found: {opponentPlayer?.words.length ?? 0}</p>
                <WordList entries={myPlayer?.words ?? []} emptyLabel="No words yet" />
              </div>
            </div>
          </motion.section>
        )}

        {room && room.status === "finished" && (
          <motion.section
            key="finished"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="panel-glass rounded-2xl p-5 md:p-8"
          >
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Round Complete</p>
                <h2 className="font-heading text-3xl font-semibold text-slate-900">
                  {myPlayer && opponentPlayer
                    ? myPlayer.score === opponentPlayer.score
                      ? "It’s a tie!"
                      : myPlayer.score > opponentPlayer.score
                        ? "You win!"
                        : `${opponentPlayer.name} wins`
                    : "Results"}
                </h2>
              </div>
              <div className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-right">
                <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Room</p>
                <p className="font-heading text-lg font-semibold tracking-[0.12em] text-slate-900">{room.code}</p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <ResultCard label="You" score={myPlayer?.score ?? 0} words={myPlayer?.words.length ?? 0} longest={myPlayer?.longestWord ?? ""} />
              <ResultCard
                label={opponentPlayer?.name ?? "Opponent"}
                score={opponentPlayer?.score ?? 0}
                words={opponentPlayer?.words.length ?? 0}
                longest=""
              />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="mb-2 font-heading text-lg font-semibold text-slate-900">Your Words</h3>
                <WordList entries={myPlayer?.words ?? []} emptyLabel="No words found" />
              </div>
              <div className="rounded-xl border border-slate-300 bg-white p-4">
                <h3 className="mb-2 font-heading text-lg font-semibold text-slate-900">Opponent Words</h3>
                <WordList entries={opponentPlayer?.words ?? []} emptyLabel="No words found" />
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-300 bg-white p-4">
              <h3 className="mb-2 font-heading text-lg font-semibold text-slate-900">Possible Words</h3>
              <p className="mb-3 text-sm text-slate-600">Total possible: {roundAllValidWords.length}</p>
              <PossibleWordsList words={roundAllValidWords} />
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={rematch}
                disabled={!isHost}
                className="pill rounded-xl border border-black bg-black px-6 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                Rematch
              </button>
            </div>
            {!isHost && <p className="mt-3 text-sm text-slate-600">Only the host can start a rematch.</p>}
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showRulesModal && (
          <motion.div
            key="rules-modal"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 p-4"
            onClick={() => setShowRulesModal(false)}
          >
            <motion.section
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.16 }}
              className="mx-auto mt-16 w-full max-w-xl rounded-2xl border border-slate-300 bg-white p-5 shadow-soft md:mt-24"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-4">
                <h2 className="font-heading text-2xl font-semibold text-slate-900">How to Play</h2>
              </div>
              <ul className="space-y-2 text-sm text-slate-700">
                <li>1. You get 6 letters and 60 seconds.</li>
                <li>2. Tap letters in order to build a word, then press Submit.</li>
                <li>3. Words must be at least 3 letters long.</li>
                <li>4. Words must be valid to score.</li>
                <li>5. You can&apos;t score the same word twice.</li>
                <li>6. Longer words give more points.</li>
                <li>7. Round ends at 0 seconds or when all valid words are found.</li>
              </ul>
              <button
                type="button"
                onClick={() => setShowRulesModal(false)}
                className="pill pill-primary mt-5 w-full py-3 text-sm"
              >
                Got it
              </button>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            className={`fixed bottom-5 left-1/2 z-40 w-[min(92vw,460px)] -translate-x-1/2 rounded-2xl border px-4 py-3 text-sm shadow-soft ${
              toast.kind === "success"
                ? "border-slate-400 bg-white text-slate-800"
                : toast.kind === "error"
                  ? "border-slate-600 bg-white text-slate-900"
                  : "border-slate-300 bg-white text-slate-700"
            }`}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function TimerRing({ remainingMs, durationSec }: { remainingMs: number; durationSec: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const progress = durationSec <= 0 ? 0 : Math.max(0, Math.min(1, remainingMs / (durationSec * 1000)));
  const offset = circumference * (1 - progress);
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  return (
    <div className="panel-glass flex h-28 w-28 items-center justify-center rounded-3xl p-2">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={radius} strokeWidth="8" stroke="rgba(148,163,184,0.2)" fill="none" />
          <circle
            cx="50"
            cy="50"
            r={radius}
            strokeWidth="8"
            stroke="url(#timerGradient)"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            fill="none"
          />
          <defs>
            <linearGradient id="timerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#111111" />
              <stop offset="100%" stopColor="#4b5563" />
            </linearGradient>
          </defs>
        </svg>
        <div className="ring-value absolute inset-0 grid place-items-center">
          <span className="font-heading text-2xl font-semibold text-slate-900">{Math.max(0, remainingSeconds)}</span>
        </div>
      </div>
    </div>
  );
}

function ScoreCard({ title, score, words }: { title: string; score: number; words: number }) {
  return (
    <div className="rounded-xl border border-slate-300 bg-white px-3 py-2">
      <p className="truncate text-[11px] uppercase tracking-[0.11em] text-slate-500">{title}</p>
      <p className="text-2xl font-semibold text-slate-900">{score}</p>
      <p className="text-xs text-slate-500">{words} words</p>
    </div>
  );
}

function WordList({
  entries,
  emptyLabel
}: {
  entries: Array<{ text: string; points: number }>;
  emptyLabel: string;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  }
  return (
    <ul className="max-h-56 space-y-1 overflow-auto pr-1">
      {entries.map((entry) => (
        <li key={entry.text} className="animate-pop-in flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
          <span className="font-semibold uppercase tracking-[0.08em] text-slate-700">{entry.text}</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-slate-600">+{entry.points}</span>
        </li>
      ))}
    </ul>
  );
}

function PossibleWordsList({ words }: { words: string[] }) {
  if (words.length === 0) {
    return <p className="text-sm text-slate-500">No list available.</p>;
  }
  return (
    <div className="max-h-56 overflow-auto pr-1">
      <div className="flex flex-wrap gap-2">
        {words.map((word) => (
          <span
            key={word}
            className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-slate-700"
          >
            {word}
          </span>
        ))}
      </div>
    </div>
  );
}

function ResultCard({ label, score, words, longest }: { label: string; score: number; words: number; longest: string }) {
  return (
    <div className="rounded-xl border border-slate-300 bg-white p-4">
      <p className="text-xs uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-slate-900">{score}</p>
      <p className="text-sm text-slate-600">{longest ? `${words} words • longest ${longest.toUpperCase()}` : `${words} words`}</p>
    </div>
  );
}

function QuestionIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-.8.8-1.6 1.2-1.6 2.5" />
      <circle cx="12" cy="17.2" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StatusDot({ state }: { state: "online" | "offline" | "connecting" }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        state === "online" ? "bg-slate-900" : state === "connecting" ? "bg-slate-500" : "bg-slate-300"
      }`}
    />
  );
}

function ConfettiBurst({ seed }: { seed: number }) {
  const dots = Array.from({ length: 8 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 8;
    const dx = Math.cos(angle) * 40;
    const dy = Math.sin(angle) * 24;
    const colors = ["#111111", "#374151", "#6b7280", "#9ca3af", "#d1d5db"];
    return {
      dx,
      dy,
      color: colors[(seed + index) % colors.length]
    };
  });

  return (
    <>
      {dots.map((dot, index) => (
        <span
          key={`${seed}-${index}`}
          className="confetti-dot absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
          style={{
            left: `calc(50% + ${dot.dx}px)`,
            top: `calc(50% + ${dot.dy}px)`,
            backgroundColor: dot.color,
            transform: "translate(-50%, -50%)"
          }}
        />
      ))}
    </>
  );
}
