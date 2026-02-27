export type RoomStatus = "waiting" | "ready" | "playing" | "finished";

export interface WordEntry {
  text: string;
  points: number;
  timestamp: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  words: WordEntry[];
  longestWord: string;
}

export interface RoomState {
  code: string;
  status: RoomStatus;
  hostId: string;
  players: PublicPlayer[];
  letters: string[];
  startTime: number | null;
  durationSec: number;
  allValidCount: number;
  foundGlobalCount: number;
  disconnectGraceEndsAt: number | null;
}

export interface YouState {
  id: string;
  name: string;
  reconnectToken: string;
}

export type SubmitErrorCode =
  | "TOO_SHORT"
  | "INVALID_WORD"
  | "LETTER_MISMATCH"
  | "ALREADY_USED"
  | "ROUND_NOT_ACTIVE"
  | "RATE_LIMIT"
  | "NOT_IN_ROOM"
  | "ROOM_FULL"
  | "ROOM_NOT_FOUND"
  | "BAD_CODE"
  | "NAME_REQUIRED"
  | "WAITING_FOR_PLAYERS"
  | "HOST_ONLY";

export interface RoomStatePayload {
  room: RoomState;
  you: YouState;
  serverNow: number;
  notice?: string;
}

export type ClientEvent =
  | {
      type: "room:create";
      payload: {
        name: string;
      };
    }
  | {
      type: "room:join";
      payload: {
        code: string;
        name: string;
        reconnectToken?: string;
      };
    }
  | {
      type: "game:start";
      payload: {
        code: string;
      };
    }
  | {
      type: "word:submit";
      payload: {
        code: string;
        word: string;
      };
    }
  | {
      type: "room:leave";
      payload: {
        code: string;
      };
    };

export type ServerEvent =
  | {
      type: "room:state";
      payload: RoomStatePayload;
    }
  | {
      type: "word:result";
      payload: {
        ok: boolean;
        word: string;
        points?: number;
        errorCode?: SubmitErrorCode;
        message: string;
      };
    }
  | {
      type: "game:tick";
      payload: {
        code: string;
        serverNow: number;
        msRemaining: number;
      };
    }
  | {
      type: "game:end";
      payload: {
        room: RoomState;
        allValidWords: string[];
        reason: "time_up" | "all_words_found" | "disconnect_timeout";
        serverNow: number;
      };
    }
  | {
      type: "server:error";
      payload: {
        errorCode: SubmitErrorCode | "UNKNOWN";
        message: string;
      };
    };
