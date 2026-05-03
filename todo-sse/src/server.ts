import Fastify from 'fastify'
import fastifySSE from '@fastify/sse'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Types ────────────────────────────────────────────────────────────────────

interface Todo {
  id: string
  title: string
  completed: boolean
  createdAt: string
}

interface CreateTodoBody {
  title: string
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const todos: Todo[] = []

/**
 * Connected SSE clients.
 * Each entry is a function that pushes an SSE message to one browser tab.
 */
type Broadcaster = (todo: Todo) => Promise<void>
const clients = new Set<Broadcaster>()

// ─── Server ───────────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: 'info' } })

// Register @fastify/sse – adds reply.sse on routes that opt in
await app.register(fastifySSE, {
  heartbeatInterval: 20_000, // keep-alive ping every 20 s
})

// Serve the frontend from /public
await app.register(fastifyStatic, {
  root: join(__dirname, '../public'),
  prefix: '/',
})

// ─── REST: list todos ─────────────────────────────────────────────────────────

app.get('/todos', async (_req, reply) => {
  return reply.send(todos)
})

// ─── REST: create todo ────────────────────────────────────────────────────────

app.post<{ Body: CreateTodoBody }>('/todos', async (req, reply) => {
  const { title } = req.body

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return reply.status(400).send({ error: 'title is required' })
  }

  const todo: Todo = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
    createdAt: new Date().toISOString(),
  }

  todos.push(todo)

  // Broadcast to every connected SSE client
  const broadcast = Array.from(clients).map((send) => send(todo))
  await Promise.allSettled(broadcast)

  return reply.status(201).send(todo)
})

// ─── SSE: subscribe to todo events ───────────────────────────────────────────
//
// The { sse: true } route option is all @fastify/sse needs.
// reply.sse.keepAlive() tells the plugin NOT to close the response after the
// handler returns – the connection stays open until the client disconnects.

app.get('/events', { sse: true }, async (req, reply) => {
  // Acknowledge the connection
  await reply.sse.send({
    event: 'connected',
    data: { message: 'SSE connection established', totalTodos: todos.length },
  })

  // Keep the HTTP response stream open
  reply.sse.keepAlive()

  // Register this client's send function
  const broadcaster: Broadcaster = (todo) =>
    reply.sse.send({
      event: 'todo:created',
      data: todo,
    })

  clients.add(broadcaster)
  app.log.info(`Client connected – total clients: ${clients.size}`)

  // Clean up when the browser closes the tab / navigates away
  reply.sse.onClose(() => {
    clients.delete(broadcaster)
    app.log.info(`Client disconnected – total clients: ${clients.size}`)
  })
})

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: 3000, host: '0.0.0.0' })
  console.log('🚀  Server listening on http://localhost:3000')
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
