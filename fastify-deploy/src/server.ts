/**
 * server.ts
 *
 * Production-ready Fastify server with:
 *   - Cluster mode (one worker per CPU core)
 *   - Graceful shutdown (lets in-flight uploads finish)
 *   - Streaming multipart upload with size enforcement
 *   - Trust proxy headers from Nginx
 */

import cluster from 'node:cluster'
import { availableParallelism } from 'node:os'
import process from 'node:process'

// ── Cluster primary ───────────────────────────────────────────────────────────
//
// The primary process forks one worker per CPU core, then monitors them.
// Nginx talks to port 3000; all workers share that port via SO_REUSEPORT.
// systemd manages *this* process — the primary — so its restart policy
// covers the whole cluster.

if (cluster.isPrimary) {
  const numCPUs = availableParallelism()
  console.log(`[primary] starting ${numCPUs} workers`)

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork()
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[primary] worker ${worker.process.pid} died (${signal ?? code}) — forking replacement`)
    cluster.fork()
  })

  // Graceful shutdown for the primary: forward SIGTERM to all workers.
  // systemd sends SIGTERM first, then (after TimeoutStopSec) SIGKILL.
  process.on('SIGTERM', () => {
    console.log('[primary] SIGTERM received — shutting down workers')
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.process.kill('SIGTERM')
    }
  })

} else {

// ── Worker ────────────────────────────────────────────────────────────────────

  const { default: Fastify }         = await import('fastify')
  const { default: multipart }       = await import('@fastify/multipart')
  const { pipeline }                 = await import('node:stream/promises')
  const { createWriteStream }        = await import('node:fs')
  const { mkdir }                    = await import('node:fs/promises')
  const { join }                     = await import('node:path')
  const { randomUUID }               = await import('node:crypto')
  const { fileTypeFromStream }       = await import('file-type')

  const PORT       = Number(process.env.PORT ?? 3000)
  const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads'
  const MAX_FILE_BYTES = 130 * 1024 * 1024   // 130 MB — slightly above 125 MB expected

  await mkdir(UPLOAD_DIR, { recursive: true })

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // pino pretty-print in dev; structured JSON in production
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    },
    // Trust X-Forwarded-For and X-Forwarded-Proto from Nginx.
    // '1' means trust one proxy hop (our Nginx). Without this,
    // req.ip returns 127.0.0.1 instead of the real client IP.
    trustProxy: 1,
  })

  // ── Multipart plugin ──────────────────────────────────────────────────────
  await app.register(multipart, {
    limits: {
      fileSize:  MAX_FILE_BYTES,  // enforced at parser level, mid-stream
      files:     1,               // reject if client sends more than one file
      fieldSize: 1024,            // 1 KB for non-file fields
    },
  })

  // ── Upload route ──────────────────────────────────────────────────────────
  app.post('/upload', async (req, reply) => {
    let tempPath: string | null = null

    try {
      const data = await req.file()
      if (!data) {
        return reply.status(400).send({ error: 'No file in request' })
      }

      // ── Validate MIME via magic bytes ─────────────────────────────────────
      // fileTypeFromStream peeks at the first ~12 bytes, then the stream
      // continues normally. This runs BEFORE writing anything to disk.
      const fileType = await fileTypeFromStream(data.file)
      const ALLOWED  = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

      if (!fileType || !ALLOWED.has(fileType.mime)) {
        // IMPORTANT: drain the stream before returning, or the client hangs
        data.file.resume()
        return reply.status(415).send({
          error: 'Unsupported file type',
          detected: fileType?.mime ?? 'unknown',
        })
      }

      // ── Stream to temp file ───────────────────────────────────────────────
      const id       = randomUUID()
      tempPath       = join(UPLOAD_DIR, `tmp_${id}`)
      const finalPath = join(UPLOAD_DIR, `${id}.${fileType.ext}`)

      await pipeline(
        data.file,
        createWriteStream(tempPath),
      )

      // ── Atomic rename to final path ───────────────────────────────────────
      // fs.rename is metadata-only when src and dst are on the same filesystem.
      // Verify that UPLOAD_DIR is not on a different mount than /tmp.
      const { rename } = await import('node:fs/promises')
      await rename(tempPath, finalPath)
      tempPath = null  // ownership transferred — don't delete on error

      return reply.status(201).send({
        id,
        filename: `${id}.${fileType.ext}`,
        mime:     fileType.mime,
        originalName: data.filename,
      })

    } catch (err: unknown) {
      // ── Cleanup on any failure ────────────────────────────────────────────
      if (tempPath) {
        const { unlink } = await import('node:fs/promises')
        await unlink(tempPath).catch(() => {})  // best-effort delete
      }

      // Handle the specific error thrown when the multipart size limit is hit
      if ((err as NodeJS.ErrnoException).code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({ error: 'File exceeds 130 MB limit' })
      }

      req.log.error(err)
      return reply.status(500).send({ error: 'Upload failed' })
    }
  })

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', pid: process.pid }))

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // systemd sends SIGTERM. We tell Fastify to stop accepting new connections,
  // wait for in-flight requests to complete, then exit cleanly.
  const shutdown = async () => {
    app.log.info('SIGTERM received — closing server gracefully')
    try {
      await app.close()
      app.log.info('Server closed')
      process.exit(0)
    } catch (err) {
      app.log.error(err)
      process.exit(1)
    }
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT',  shutdown)   // Ctrl+C in dev

  // ── Start ─────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: '127.0.0.1' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

}
