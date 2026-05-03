# SSE Todo Demo

A minimal **Server-Sent Events** demo with Fastify 5 + TypeScript.

## What it demonstrates

- `@fastify/sse` v0.4 with `{ sse: true }` route option
- Broadcasting a `todo:created` event to every connected browser tab
- Browser-native `EventSource` reconnection
- Live event log panel in the UI

## Setup

```bash
npm install
npm run dev        # http://localhost:3000
```

> **Tip**: Open the same URL in two browser tabs.  
> Create a task in one tab and watch the other tab receive the SSE notification instantly.

## Project layout

```
src/
  server.ts          ← Fastify server with SSE + REST routes
public/
  index.html         ← Single-file frontend (no bundler needed)
tsconfig.json
package.json
```

## API

| Method | Path      | Description                          |
|--------|-----------|--------------------------------------|
| GET    | /todos    | List all todos (JSON)                |
| POST   | /todos    | Create a todo, broadcasts SSE event  |
| GET    | /events   | SSE stream (text/event-stream)       |

## SSE events

| Event name    | Payload                        |
|---------------|--------------------------------|
| `connected`   | `{ message, totalTodos }`      |
| `todo:created`| `{ id, title, completed, createdAt }` |
