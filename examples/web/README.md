# Agent Chat (React)

React chat UI for the Agent API ([TypeScript/src/server/app.ts](../../TypeScript/src/server/app.ts)).

## Setup

```bash
cd web
npm install
```

## Development

1. Start the Agent server (from project root):

   ```bash
   cd TypeScript && npx ts-node src/server/app.ts
   ```

2. Start the React dev server (from `web/`):

   ```bash
   npm run dev
   ```

3. Open http://localhost:5173. The app proxies `/api` to the server at http://127.0.0.1:8000.

## Build

```bash
npm run build
```

Output is in `dist/`. To serve it from the same origin as the API, copy `dist/` into `server/static/` and the Express app can serve it at `/`.

## API

- `POST /api/sessions` — create session
- `POST /api/sessions/:id/turn` — send message (body: `{ "message": "..." }`)

Override API base with `VITE_API_URL` (e.g. `VITE_API_URL=http://localhost:8000`).
