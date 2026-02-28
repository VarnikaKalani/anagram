import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ClientEvent,
  DifficultyMode,
  PublicPlayer,
  RoomState,
  RoomStatus,
  ServerEvent,
  SubmitErrorCode,
  WordEntry
} from "../shared/types";
import { loadWordLists } from "./dictionary";
import { canBuildFromLetters, generateRound, scoreForWord } from "./game-engine";

const PORT = Number(process.env.WS_PORT ?? process.env.PORT ?? 8080);
const ROUND_DURATION_SECONDS = 60;
const RECONNECT_GRACE_MS = 15_000;
const RATE_WINDOW_MS = 2_000;
const RATE_LIMIT_COUNT = 5;

interface PlayerInternal {
  id: string;
  reconnectToken: string;
  name: string;
  connected: boolean;
  score: number;
  words: WordEntry[];
  usedWords: Set<string>;
  longestWord: string;
  submitTimestamps: number[];
  ws?: WebSocket;
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
  allValidWords: Set<string>;
  foundGlobal: Set<string>;
  disconnectGraceEndsAt: number | null;
  roundTimeout?: NodeJS.Timeout;
  tickInterval?: NodeJS.Timeout;
  disconnectTimeout?: NodeJS.Timeout;
  createdAt: number;
  updatedAt: number;
}

interface SocketContext {
  roomCode: string;
  playerId: string;
}

const rooms = new Map<string, RoomInternal>();
const socketContexts = new Map<WebSocket, SocketContext>();
const { allWords: dictionary, commonWords: commonDictionary } = loadWordLists();

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Anagram WebSocket server is running.\n");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  ws.on("message", (rawData) => {
    let message: ClientEvent;
    try {
      message = JSON.parse(String(rawData)) as ClientEvent;
    } catch {
      sendServerError(ws, "UNKNOWN", "Invalid message format.");
      return;
    }

    switch (message.type) {
      case "room:create":
        handleRoomCreate(ws, message.payload.name, message.payload.mode);
        break;
      case "room:join":
        handleRoomJoin(ws, message.payload.code, message.payload.name, message.payload.reconnectToken);
        break;
      case "game:start":
        handleGameStart(ws, message.payload.code);
        break;
      case "word:submit":
        handleWordSubmit(ws, message.payload.code, message.payload.word);
        break;
      case "room:leave":
        ws.close();
        break;
      default:
        sendServerError(ws, "UNKNOWN", "Unsupported event.");
    }
  });

  ws.on("close", () => {
    handleSocketClose(ws);
  });

  ws.on("error", () => {
    handleSocketClose(ws);
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ws] Listening on ws://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[ws] Loaded dictionary words: ${dictionary.size}`);
  // eslint-disable-next-line no-console
  console.log(`[ws] Loaded common words: ${commonDictionary.size}`);
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.every((player) => !player.connected) && now - room.updatedAt > 5 * 60_000) {
      clearRoomTimers(room);
      rooms.delete(room.code);
    }
  }
}, 60_000);

function handleRoomCreate(ws: WebSocket, rawName: string, rawMode?: DifficultyMode): void {
  const name = sanitizeName(rawName);
  if (!name) {
    sendServerError(ws, "NAME_REQUIRED", "Please enter a player name.");
    return;
  }
  const mode = normalizeMode(rawMode);

  const code = generateRoomCode();
  const player = createPlayer(name, ws);
  const room: RoomInternal = {
    code,
    status: "waiting",
    mode,
    hostPlayerId: player.id,
    players: [player],
    letters: [],
    startTime: null,
    durationSec: ROUND_DURATION_SECONDS,
    allValidWords: new Set(),
    foundGlobal: new Set(),
    disconnectGraceEndsAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  rooms.set(code, room);
  socketContexts.set(ws, { roomCode: code, playerId: player.id });
  emitRoomState(room);
}

function handleRoomJoin(
  ws: WebSocket,
  rawCode: string,
  rawName: string,
  reconnectToken?: string
): void {
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    sendServerError(ws, "BAD_CODE", "Enter a valid 6-digit room code.");
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    sendServerError(ws, "ROOM_NOT_FOUND", "Room not found.");
    return;
  }

  const name = sanitizeName(rawName);
  if (!name) {
    sendServerError(ws, "NAME_REQUIRED", "Please enter a player name.");
    return;
  }

  const reconnectingPlayer = reconnectToken
    ? room.players.find((player) => player.reconnectToken === reconnectToken)
    : undefined;

  if (reconnectingPlayer) {
    if (reconnectingPlayer.ws && reconnectingPlayer.ws !== ws) {
      socketContexts.delete(reconnectingPlayer.ws);
      reconnectingPlayer.ws.close();
    }
    reconnectingPlayer.ws = ws;
    reconnectingPlayer.connected = true;
    room.updatedAt = Date.now();
    socketContexts.set(ws, { roomCode: room.code, playerId: reconnectingPlayer.id });

    if (room.status === "playing" && room.players.every((player) => player.connected)) {
      room.disconnectGraceEndsAt = null;
      if (room.disconnectTimeout) {
        clearTimeout(room.disconnectTimeout);
        room.disconnectTimeout = undefined;
      }
      emitRoomState(room, `${reconnectingPlayer.name} reconnected.`);
      return;
    }

    if (room.status === "waiting" && room.players.length === 2 && room.players.every((player) => player.connected)) {
      room.status = "ready";
    }

    room.updatedAt = Date.now();
    emitRoomState(room, `${reconnectingPlayer.name} reconnected.`);
    return;
  }

  if (room.players.length >= 2) {
    sendServerError(ws, "ROOM_FULL", "Room is full.");
    return;
  }

  const player = createPlayer(name, ws);
  room.players.push(player);
  room.updatedAt = Date.now();
  if (room.players.length === 2 && room.players.every((entry) => entry.connected)) {
    room.status = "ready";
  }
  socketContexts.set(ws, { roomCode: room.code, playerId: player.id });
  emitRoomState(room, `${player.name} joined.`);
}

function handleGameStart(ws: WebSocket, rawCode: string): void {
  const context = socketContexts.get(ws);
  if (!context) {
    sendServerError(ws, "NOT_IN_ROOM", "Join a room first.");
    return;
  }

  const code = normalizeRoomCode(rawCode);
  if (!code || code !== context.roomCode) {
    sendServerError(ws, "NOT_IN_ROOM", "You are not in that room.");
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    sendServerError(ws, "ROOM_NOT_FOUND", "Room not found.");
    return;
  }

  if (room.players.length < 2 || room.players.some((player) => !player.connected)) {
    sendServerError(ws, "WAITING_FOR_PLAYERS", "Both players must be connected to start.");
    return;
  }

  if (context.playerId !== room.hostPlayerId) {
    sendServerError(ws, "HOST_ONLY", "Only the host can start the round.");
    return;
  }

  startRound(room);
}

function handleWordSubmit(ws: WebSocket, rawCode: string, rawWord: string): void {
  const context = socketContexts.get(ws);
  if (!context) {
    sendServerError(ws, "NOT_IN_ROOM", "Join a room first.");
    return;
  }

  const code = normalizeRoomCode(rawCode);
  if (!code || code !== context.roomCode) {
    sendServerError(ws, "NOT_IN_ROOM", "You are not in that room.");
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    sendServerError(ws, "ROOM_NOT_FOUND", "Room not found.");
    return;
  }

  const player = room.players.find((entry) => entry.id === context.playerId);
  if (!player) {
    sendServerError(ws, "NOT_IN_ROOM", "Player context missing.");
    return;
  }

  if (room.status !== "playing") {
    sendWordResult(ws, {
      ok: false,
      word: rawWord.toLowerCase(),
      errorCode: "ROUND_NOT_ACTIVE",
      message: "The round has not started yet."
    });
    return;
  }

  const now = Date.now();
  player.submitTimestamps = player.submitTimestamps.filter((timestamp) => now - timestamp <= RATE_WINDOW_MS);
  if (player.submitTimestamps.length >= RATE_LIMIT_COUNT) {
    sendWordResult(ws, {
      ok: false,
      word: rawWord.toLowerCase(),
      errorCode: "RATE_LIMIT",
      message: "You're submitting too fast. Try again."
    });
    return;
  }
  player.submitTimestamps.push(now);

  const word = rawWord.trim().toLowerCase();
  if (word.length < 3) {
    sendWordResult(ws, {
      ok: false,
      word,
      errorCode: "TOO_SHORT",
      message: "Words must be at least 3 letters."
    });
    return;
  }

  if (!canBuildFromLetters(word, room.letters)) {
    sendWordResult(ws, {
      ok: false,
      word,
      errorCode: "LETTER_MISMATCH",
      message: "That word can't be made from these letters."
    });
    return;
  }

  if (!room.allValidWords.has(word)) {
    sendWordResult(ws, {
      ok: false,
      word,
      errorCode: "INVALID_WORD",
      message: "That word is not valid."
    });
    return;
  }

  if (player.usedWords.has(word)) {
    sendWordResult(ws, {
      ok: false,
      word,
      errorCode: "ALREADY_USED",
      message: "You already found that word."
    });
    return;
  }

  const points = scoreForWord(word.length);
  const entry: WordEntry = {
    text: word,
    points,
    timestamp: now
  };
  player.words.push(entry);
  player.usedWords.add(word);
  player.score += points;
  if (word.length > player.longestWord.length) {
    player.longestWord = word;
  }
  room.foundGlobal.add(word);
  room.updatedAt = now;

  sendWordResult(ws, {
    ok: true,
    word,
    points,
    message: `+${points} points`
  });

  emitRoomState(room);

  if (room.allValidWords.size > 0 && room.foundGlobal.size >= room.allValidWords.size) {
    endRound(room, "all_words_found");
  }
}

function handleSocketClose(ws: WebSocket): void {
  const context = socketContexts.get(ws);
  if (!context) {
    return;
  }
  socketContexts.delete(ws);

  const room = rooms.get(context.roomCode);
  if (!room) {
    return;
  }

  const player = room.players.find((entry) => entry.id === context.playerId);
  if (!player) {
    return;
  }

  if (player.ws && player.ws !== ws) {
    return;
  }

  if (player.ws === ws) {
    player.ws = undefined;
  }
  player.connected = false;
  room.updatedAt = Date.now();

  if (room.status === "playing") {
    room.disconnectGraceEndsAt = Date.now() + RECONNECT_GRACE_MS;
    if (room.disconnectTimeout) {
      clearTimeout(room.disconnectTimeout);
    }
    room.disconnectTimeout = setTimeout(() => {
      const unresolvedDisconnect = room.players.some((entry) => !entry.connected);
      if (unresolvedDisconnect && room.status === "playing") {
        endRound(room, "disconnect_timeout");
      }
    }, RECONNECT_GRACE_MS);
    emitRoomState(room, "Opponent disconnected, waiting 15s...");
    return;
  }

  if (room.hostPlayerId === player.id) {
    const nextHost = room.players.find((entry) => entry.connected && entry.id !== player.id);
    if (nextHost) {
      room.hostPlayerId = nextHost.id;
    }
  }

  if (room.status !== "finished") {
    room.status = room.players.length === 2 && room.players.every((entry) => entry.connected) ? "ready" : "waiting";
    emitRoomState(room, `${player.name} disconnected.`);
  }

  if (room.players.every((entry) => !entry.connected)) {
    clearRoomTimers(room);
    rooms.delete(room.code);
  }
}

function startRound(room: RoomInternal): void {
  clearRoomTimers(room);

  const { letters, validWords } = generateRound(dictionary, commonDictionary, room.mode);
  room.letters = letters;
  room.allValidWords = validWords;
  room.foundGlobal = new Set();
  room.status = "playing";
  room.startTime = Date.now();
  room.durationSec = ROUND_DURATION_SECONDS;
  room.disconnectGraceEndsAt = null;
  room.updatedAt = Date.now();

  for (const player of room.players) {
    player.score = 0;
    player.words = [];
    player.usedWords = new Set();
    player.longestWord = "";
    player.submitTimestamps = [];
  }

  emitRoomState(room, `Round started (${room.mode}).`);

  room.roundTimeout = setTimeout(() => {
    if (room.status === "playing") {
      endRound(room, "time_up");
    }
  }, room.durationSec * 1000);

  room.tickInterval = setInterval(() => {
    if (room.status !== "playing" || room.startTime === null) {
      return;
    }
    const endAt = room.startTime + room.durationSec * 1000;
    const remaining = Math.max(0, endAt - Date.now());
    const event: ServerEvent = {
      type: "game:tick",
      payload: {
        code: room.code,
        serverNow: Date.now(),
        msRemaining: remaining
      }
    };
    for (const player of room.players) {
      if (player.connected && player.ws) {
        sendEvent(player.ws, event);
      }
    }
  }, 1000);
}

function endRound(room: RoomInternal, reason: "time_up" | "all_words_found" | "disconnect_timeout"): void {
  if (room.status !== "playing") {
    return;
  }
  room.status = "finished";
  room.updatedAt = Date.now();
  room.disconnectGraceEndsAt = null;
  clearRoomTimers(room);

  emitRoomState(room, reason === "disconnect_timeout" ? "Round ended: opponent did not reconnect." : "Round complete.");
  const publicRoom = toPublicRoom(room);
  const event: ServerEvent = {
    type: "game:end",
    payload: {
      room: publicRoom,
      allValidWords: [...room.allValidWords].sort((a, b) => a.localeCompare(b)),
      reason,
      serverNow: Date.now()
    }
  };
  for (const player of room.players) {
    if (player.connected && player.ws) {
      sendEvent(player.ws, event);
    }
  }
}

function emitRoomState(room: RoomInternal, notice?: string): void {
  const roomState = toPublicRoom(room);
  for (const player of room.players) {
    if (!player.connected || !player.ws) {
      continue;
    }
    const event: ServerEvent = {
      type: "room:state",
      payload: {
        room: roomState,
        you: {
          id: player.id,
          name: player.name,
          reconnectToken: player.reconnectToken
        },
        serverNow: Date.now(),
        notice
      }
    };
    sendEvent(player.ws, event);
  }
}

function createPlayer(name: string, ws: WebSocket): PlayerInternal {
  return {
    id: randomUUID(),
    reconnectToken: randomUUID(),
    name,
    connected: true,
    score: 0,
    words: [],
    usedWords: new Set(),
    longestWord: "",
    submitTimestamps: [],
    ws
  };
}

function toPublicRoom(room: RoomInternal): RoomState {
  const players: PublicPlayer[] = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    connected: player.connected,
    score: player.score,
    words: [...player.words].sort((a, b) => b.points - a.points || a.text.localeCompare(b.text)),
    longestWord: player.longestWord
  }));

  return {
    code: room.code,
    status: room.status,
    mode: room.mode,
    hostId: room.hostPlayerId,
    players,
    letters: room.letters,
    startTime: room.startTime,
    durationSec: room.durationSec,
    allValidCount: room.allValidWords.size,
    foundGlobalCount: room.foundGlobal.size,
    disconnectGraceEndsAt: room.disconnectGraceEndsAt
  };
}

function sendWordResult(
  ws: WebSocket,
  payload: {
    ok: boolean;
    word: string;
    points?: number;
    errorCode?: SubmitErrorCode;
    message: string;
  }
): void {
  const event: ServerEvent = {
    type: "word:result",
    payload
  };
  sendEvent(ws, event);
}

function sendServerError(ws: WebSocket, errorCode: SubmitErrorCode | "UNKNOWN", message: string): void {
  const event: ServerEvent = {
    type: "server:error",
    payload: {
      errorCode,
      message
    }
  };
  sendEvent(ws, event);
}

function sendEvent(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(event));
}

function clearRoomTimers(room: RoomInternal): void {
  if (room.roundTimeout) {
    clearTimeout(room.roundTimeout);
    room.roundTimeout = undefined;
  }
  if (room.tickInterval) {
    clearInterval(room.tickInterval);
    room.tickInterval = undefined;
  }
  if (room.disconnectTimeout) {
    clearTimeout(room.disconnectTimeout);
    room.disconnectTimeout = undefined;
  }
}

function normalizeRoomCode(input: string): string | null {
  const code = input.trim();
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  return code;
}

function sanitizeName(input: string): string {
  const name = input.trim().slice(0, 24);
  return name;
}

function normalizeMode(input?: DifficultyMode): DifficultyMode {
  if (input === "easy" || input === "medium" || input === "hard") {
    return input;
  }
  return "medium";
}

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error("Failed to generate room code.");
}
