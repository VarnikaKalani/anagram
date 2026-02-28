import { randomInt, randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "../lib/supabase-admin";
import type {
  DifficultyMode,
  RoomState,
  RoomStatePayload,
  RoomStatus,
  SubmitErrorCode,
  WordEntry,
  WordSubmitPayload,
  YouState
} from "../shared/types";
import { loadWordLists } from "./dictionary";
import { canBuildFromLetters, generateRound, scoreForWord } from "./game-engine";

const ROUND_DURATION_SECONDS = 60;
const RATE_WINDOW_MS = 2_000;
const RATE_LIMIT_COUNT = 5;

type EndReason = "time_up" | "all_words_found" | "disconnect_timeout";

interface PlayerInternal {
  id: string;
  reconnectToken: string;
  name: string;
  connected: boolean;
  score: number;
  words: WordEntry[];
  usedWords: string[];
  longestWord: string;
  submitTimestamps: number[];
}

interface RoomInternal {
  code: string;
  status: RoomStatus;
  mode: DifficultyMode;
  hostPlayerId: string;
  players: PlayerInternal[];
  letters: string[];
  startTime: number | null;
  durationSec: number;
  allValidWords: string[];
  foundGlobalWords: string[];
  disconnectGraceEndsAt: number | null;
  lastEndReason: EndReason | null;
  createdAt: number;
  updatedAt: number;
}

interface RoomRow {
  code: string;
  status: RoomStatus;
  mode: DifficultyMode;
  host_id: string;
  players: PlayerInternal[] | null;
  letters: string[] | null;
  start_time: number | null;
  duration_sec: number;
  all_valid_words: string[] | null;
  found_global_words: string[] | null;
  disconnect_grace_ends_at: number | null;
  last_end_reason: EndReason | null;
  created_at: number;
  updated_at: number;
}

interface ServiceError {
  errorCode: SubmitErrorCode | "UNKNOWN";
  message: string;
}

interface ServiceResult<T> {
  data?: T;
  error?: ServiceError;
}

const { allWords: dictionary, commonWords: commonDictionary } = loadWordLists();

export async function createRoomSession(rawName: string, mode?: DifficultyMode): Promise<ServiceResult<RoomStatePayload>> {
  const name = sanitizeName(rawName);
  if (!name) {
    return fail("NAME_REQUIRED", "Please enter a player name.");
  }

  const roomMode = normalizeMode(mode);
  const player = createPlayer(name);
  const now = Date.now();

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = generateRoomCode();
    const room: RoomInternal = {
      code,
      status: "waiting",
      mode: roomMode,
      hostPlayerId: player.id,
      players: [player],
      letters: [],
      startTime: null,
      durationSec: ROUND_DURATION_SECONDS,
      allValidWords: [],
      foundGlobalWords: [],
      disconnectGraceEndsAt: null,
      lastEndReason: null,
      createdAt: now,
      updatedAt: now
    };

    const admin = getSupabaseAdmin();
    const { data, error } = await admin.from("rooms").insert(toRow(room)).select("*").single<RoomRow>();
    if (error) {
      // Unique collision on code, retry.
      if (error.code === "23505") {
        continue;
      }
      return fail("UNKNOWN", "Could not create room.");
    }

    const created = fromRow(data);
    return ok(roomPayload(created, player));
  }

  return fail("UNKNOWN", "Could not create room.");
}

export async function joinRoomSession(
  rawCode: string,
  rawName: string,
  reconnectToken?: string
): Promise<ServiceResult<RoomStatePayload>> {
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    return fail("BAD_CODE", "Enter a valid 6-digit room code.");
  }

  const room = await getRoomByCode(code);
  if (!room) {
    return fail("ROOM_NOT_FOUND", "Room not found.");
  }

  const name = sanitizeName(rawName);
  if (!name) {
    return fail("NAME_REQUIRED", "Please enter a player name.");
  }

  const reconnecting = reconnectToken
    ? room.players.find((player) => player.reconnectToken === reconnectToken)
    : undefined;

  let you: PlayerInternal;
  if (reconnecting) {
    reconnecting.connected = true;
    reconnecting.name = name;
    you = reconnecting;
  } else {
    if (room.players.length >= 2) {
      return fail("ROOM_FULL", "Room is full.");
    }
    const player = createPlayer(name);
    room.players.push(player);
    you = player;
  }

  room.updatedAt = Date.now();
  if (room.status !== "playing" && room.status !== "finished") {
    room.status = room.players.length === 2 && room.players.every((player) => player.connected) ? "ready" : "waiting";
  }
  await saveRoom(room);
  return ok(roomPayload(room, you));
}

export async function getRoomStateSession(
  rawCode: string,
  playerId: string,
  reconnectToken?: string
): Promise<ServiceResult<RoomStatePayload>> {
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    return fail("BAD_CODE", "Enter a valid 6-digit room code.");
  }
  if (!playerId) {
    return fail("NOT_IN_ROOM", "Join a room first.");
  }

  const room = await getRoomByCode(code);
  if (!room) {
    return fail("ROOM_NOT_FOUND", "Room not found.");
  }

  const you =
    room.players.find((player) => player.id === playerId) ??
    (reconnectToken ? room.players.find((player) => player.reconnectToken === reconnectToken) : undefined);

  if (!you) {
    return fail("NOT_IN_ROOM", "Player not in room.");
  }

  if (room.status === "playing" && hasRoundExpired(room)) {
    endRound(room, "time_up");
    await saveRoom(room);
  }

  const payload = roomPayload(room, you);
  if (room.status === "finished") {
    payload.allValidWords = [...room.allValidWords].sort((a, b) => a.localeCompare(b));
    payload.endReason = room.lastEndReason ?? "time_up";
  }
  return ok(payload);
}

export async function startRoundSession(rawCode: string, playerId: string): Promise<ServiceResult<RoomStatePayload>> {
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    return fail("BAD_CODE", "Enter a valid 6-digit room code.");
  }
  if (!playerId) {
    return fail("NOT_IN_ROOM", "Join a room first.");
  }

  const room = await getRoomByCode(code);
  if (!room) {
    return fail("ROOM_NOT_FOUND", "Room not found.");
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return fail("NOT_IN_ROOM", "Join a room first.");
  }

  if (player.id !== room.hostPlayerId) {
    return fail("HOST_ONLY", "Only the host can start the round.");
  }

  if (room.players.length < 2 || room.players.some((entry) => !entry.connected)) {
    return fail("WAITING_FOR_PLAYERS", "Both players must be connected to start.");
  }

  const { letters, validWords } = generateRound(dictionary, commonDictionary, room.mode);
  room.letters = letters;
  room.allValidWords = [...validWords];
  room.foundGlobalWords = [];
  room.status = "playing";
  room.startTime = Date.now();
  room.durationSec = ROUND_DURATION_SECONDS;
  room.disconnectGraceEndsAt = null;
  room.lastEndReason = null;
  room.updatedAt = Date.now();
  room.players = room.players.map((entry) => ({
    ...entry,
    score: 0,
    words: [],
    usedWords: [],
    longestWord: "",
    submitTimestamps: []
  }));

  await saveRoom(room);
  const refreshedYou = room.players.find((entry) => entry.id === playerId) ?? room.players[0];
  return ok(roomPayload(room, refreshedYou));
}

export async function submitWordSession(
  rawCode: string,
  playerId: string,
  rawWord: string
): Promise<ServiceResult<WordSubmitPayload>> {
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    return fail("BAD_CODE", "Enter a valid 6-digit room code.");
  }
  if (!playerId) {
    return fail("NOT_IN_ROOM", "Join a room first.");
  }

  const room = await getRoomByCode(code);
  if (!room) {
    return fail("ROOM_NOT_FOUND", "Room not found.");
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return fail("NOT_IN_ROOM", "Join a room first.");
  }

  if (room.status !== "playing") {
    return ok(wordPayload(room, player, {
      ok: false,
      word: rawWord.toLowerCase(),
      errorCode: "ROUND_NOT_ACTIVE",
      message: "The round has not started yet."
    }));
  }

  if (hasRoundExpired(room)) {
    endRound(room, "time_up");
    await saveRoom(room);
    const payload = wordPayload(room, player, {
      ok: false,
      word: rawWord.toLowerCase(),
      errorCode: "ROUND_NOT_ACTIVE",
      message: "Time is up."
    });
    payload.allValidWords = [...room.allValidWords].sort((a, b) => a.localeCompare(b));
    payload.endReason = room.lastEndReason ?? "time_up";
    return ok(payload);
  }

  const now = Date.now();
  player.submitTimestamps = player.submitTimestamps.filter((timestamp) => now - timestamp <= RATE_WINDOW_MS);
  if (player.submitTimestamps.length >= RATE_LIMIT_COUNT) {
    return ok(
      wordPayload(room, player, {
        ok: false,
        word: rawWord.toLowerCase(),
        errorCode: "RATE_LIMIT",
        message: "You're submitting too fast. Try again."
      })
    );
  }
  player.submitTimestamps.push(now);

  const word = rawWord.trim().toLowerCase();
  if (word.length < 3) {
    return ok(
      wordPayload(room, player, {
        ok: false,
        word,
        errorCode: "TOO_SHORT",
        message: "Words must be at least 3 letters."
      })
    );
  }

  if (!canBuildFromLetters(word, room.letters)) {
    return ok(
      wordPayload(room, player, {
        ok: false,
        word,
        errorCode: "LETTER_MISMATCH",
        message: "That word can't be made from these letters."
      })
    );
  }

  if (!room.allValidWords.includes(word)) {
    return ok(
      wordPayload(room, player, {
        ok: false,
        word,
        errorCode: "INVALID_WORD",
        message: "That word is not valid."
      })
    );
  }

  if (player.usedWords.includes(word)) {
    return ok(
      wordPayload(room, player, {
        ok: false,
        word,
        errorCode: "ALREADY_USED",
        message: "You already found that word."
      })
    );
  }

  const points = scoreForWord(word.length);
  const entry: WordEntry = {
    text: word,
    points,
    timestamp: now
  };
  player.words.push(entry);
  player.usedWords.push(word);
  player.score += points;
  if (word.length > player.longestWord.length) {
    player.longestWord = word;
  }
  if (!room.foundGlobalWords.includes(word)) {
    room.foundGlobalWords.push(word);
  }
  room.updatedAt = now;

  if (room.allValidWords.length > 0 && room.foundGlobalWords.length >= room.allValidWords.length) {
    endRound(room, "all_words_found");
  }

  await saveRoom(room);

  const payload = wordPayload(room, player, {
    ok: true,
    word,
    points,
    message: `+${points} points`
  });
  if (room.lastEndReason) {
    payload.allValidWords = [...room.allValidWords].sort((a, b) => a.localeCompare(b));
    payload.endReason = room.lastEndReason;
  }
  return ok(payload);
}

export async function leaveRoomSession(rawCode: string, playerId: string): Promise<ServiceResult<{ ok: true }>> {
  const code = normalizeRoomCode(rawCode);
  if (!code || !playerId) {
    return ok({ ok: true });
  }

  const room = await getRoomByCode(code);
  if (!room) {
    return ok({ ok: true });
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return ok({ ok: true });
  }
  player.connected = false;
  room.updatedAt = Date.now();

  if (room.hostPlayerId === player.id) {
    const nextHost = room.players.find((entry) => entry.connected && entry.id !== player.id);
    if (nextHost) {
      room.hostPlayerId = nextHost.id;
    }
  }

  if (room.status !== "finished" && room.status !== "playing") {
    room.status = room.players.length === 2 && room.players.every((entry) => entry.connected) ? "ready" : "waiting";
  }

  if (room.players.every((entry) => !entry.connected)) {
    const admin = getSupabaseAdmin();
    await admin.from("rooms").delete().eq("code", room.code);
    return ok({ ok: true });
  }

  await saveRoom(room);
  return ok({ ok: true });
}

function roomPayload(room: RoomInternal, youPlayer: PlayerInternal): RoomStatePayload {
  return {
    room: toPublicRoom(room),
    you: toYouState(youPlayer),
    serverNow: Date.now()
  };
}

function wordPayload(
  room: RoomInternal,
  youPlayer: PlayerInternal,
  wordResult: WordSubmitPayload["wordResult"]
): WordSubmitPayload {
  return {
    room: toPublicRoom(room),
    you: toYouState(youPlayer),
    serverNow: Date.now(),
    wordResult
  };
}

function toPublicRoom(room: RoomInternal): RoomState {
  return {
    code: room.code,
    status: room.status,
    mode: room.mode,
    hostId: room.hostPlayerId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      score: player.score,
      words: [...player.words].sort((a, b) => b.points - a.points || a.text.localeCompare(b.text)),
      longestWord: player.longestWord
    })),
    letters: room.letters,
    startTime: room.startTime,
    durationSec: room.durationSec,
    allValidCount: room.allValidWords.length,
    foundGlobalCount: room.foundGlobalWords.length,
    disconnectGraceEndsAt: room.disconnectGraceEndsAt
  };
}

function toYouState(player: PlayerInternal): YouState {
  return {
    id: player.id,
    name: player.name,
    reconnectToken: player.reconnectToken
  };
}

function createPlayer(name: string): PlayerInternal {
  return {
    id: randomUUID(),
    reconnectToken: randomUUID(),
    name,
    connected: true,
    score: 0,
    words: [],
    usedWords: [],
    longestWord: "",
    submitTimestamps: []
  };
}

async function getRoomByCode(code: string): Promise<RoomInternal | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.from("rooms").select("*").eq("code", code).maybeSingle<RoomRow>();
  if (error || !data) {
    return null;
  }
  return fromRow(data);
}

async function saveRoom(room: RoomInternal): Promise<void> {
  const admin = getSupabaseAdmin();
  room.updatedAt = Date.now();
  await admin.from("rooms").update(toRow(room)).eq("code", room.code);
}

function fromRow(row: RoomRow): RoomInternal {
  return {
    code: row.code,
    status: row.status,
    mode: normalizeMode(row.mode),
    hostPlayerId: row.host_id,
    players: (row.players ?? []).map((player) => ({
      ...player,
      usedWords: [...(player.usedWords ?? [])],
      words: [...(player.words ?? [])],
      submitTimestamps: [...(player.submitTimestamps ?? [])]
    })),
    letters: row.letters ?? [],
    startTime: row.start_time,
    durationSec: row.duration_sec,
    allValidWords: row.all_valid_words ?? [],
    foundGlobalWords: row.found_global_words ?? [],
    disconnectGraceEndsAt: row.disconnect_grace_ends_at,
    lastEndReason: row.last_end_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRow(room: RoomInternal): Omit<RoomRow, never> {
  return {
    code: room.code,
    status: room.status,
    mode: room.mode,
    host_id: room.hostPlayerId,
    players: room.players,
    letters: room.letters,
    start_time: room.startTime,
    duration_sec: room.durationSec,
    all_valid_words: room.allValidWords,
    found_global_words: room.foundGlobalWords,
    disconnect_grace_ends_at: room.disconnectGraceEndsAt,
    last_end_reason: room.lastEndReason,
    created_at: room.createdAt,
    updated_at: room.updatedAt
  };
}

function endRound(room: RoomInternal, reason: EndReason): void {
  room.status = "finished";
  room.lastEndReason = reason;
  room.disconnectGraceEndsAt = null;
  room.updatedAt = Date.now();
}

function hasRoundExpired(room: RoomInternal): boolean {
  if (room.status !== "playing" || room.startTime === null) {
    return false;
  }
  return Date.now() >= room.startTime + room.durationSec * 1000;
}

function sanitizeName(input: string): string {
  return input.trim().slice(0, 24);
}

function normalizeRoomCode(input: string): string | null {
  const code = input.trim();
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  return code;
}

function normalizeMode(mode?: DifficultyMode): DifficultyMode {
  if (mode === "easy" || mode === "medium" || mode === "hard") {
    return mode;
  }
  return "medium";
}

function generateRoomCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function ok<T>(data: T): ServiceResult<T> {
  return { data };
}

function fail<T>(errorCode: SubmitErrorCode | "UNKNOWN", message: string): ServiceResult<T> {
  return { error: { errorCode, message } };
}
