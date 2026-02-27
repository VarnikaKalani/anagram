# Anagram Arena (2-Player Real-Time)

Minimalist, NYT-inspired real-time anagram duel built with:

- Next.js (App Router) + TypeScript + Tailwind CSS
- WebSocket game server (`ws`) with server-authoritative validation
- Framer Motion for subtle UI transitions

## Features

- Create/join room with 6-digit numeric code
- Host-only round start (room creator is host)
- 2-player synchronized rounds (same letters, same 60s timer start)
- Real-time score and words update
- Server-side anti-cheat validation:
  - min length 3
  - letters/frequency constraints
  - dictionary membership
  - no duplicate word scoring per player
  - light rate limit (max 5 submits / 2 seconds)
- Reconnect grace:
  - if a player disconnects mid-round, wait up to 15s
  - if not back, server ends round
- Early round end when all valid words are found
- Keyboard support on desktop (`letters`, `Enter`, `Backspace`, `Escape`)

## Project Structure

- `app/` Next.js app router pages/layout
- `components/` UI + client game logic
- `server/` standalone WebSocket server and game engine
- `shared/` shared event/model types
- `data/words.txt` seeded dictionary (works out of the box)

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Run frontend + WebSocket server together:

```bash
npm run dev:all
```

3. Open:

- Frontend: `http://localhost:3000`
- WebSocket server: `ws://localhost:8080`

If you run servers separately:

```bash
npm run dev      # Next.js
npm run ws:dev   # WebSocket server
```

## Environment

Optional:

- `NEXT_PUBLIC_WS_URL` (defaults to `ws://<current-host>:8080`)
- `WS_PORT` for WebSocket server (defaults to `8080`)

## Deployment Notes

### Frontend (Vercel)

- Deploy Next.js app to Vercel.
- Set `NEXT_PUBLIC_WS_URL` to your deployed WebSocket server URL (`wss://...`).

### WebSocket Server

- Deploy `server/ws-server.ts` to a Node host that supports long-lived WebSocket connections (Render, Fly.io, Railway, etc).
- Run with:

```bash
npm run ws:start
```

Make sure `data/words.txt` is included in deployment.
