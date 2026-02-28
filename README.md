# Anagram Arena (2-Player Real-Time)

Minimalist, NYT-inspired real-time anagram duel built with:

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase (Postgres) for shared room state + persistence
- Next.js API routes for server-authoritative validation
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
- `app/api/` server routes used by the game client
- `components/` UI + client game logic
- `server/` game engine + Supabase room service logic
- `shared/` shared event/model types
- `data/words.txt` seeded dictionary (works out of the box)
- `supabase/schema.sql` required table schema

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env.local
```

Set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

3. Create the Supabase table:

Run SQL from:

```bash
# supabase/schema.sql
```

4. Run the app:

```bash
npm run dev
```

5. Open:

- Frontend: `http://localhost:3000`

## Deployment Notes

Deploy only the Next.js project to Vercel and set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

No separate WebSocket host is required in this setup.
