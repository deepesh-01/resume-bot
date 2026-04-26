// HTTP health + remote-restart endpoints. Bound to 127.0.0.1 so only this
// laptop can reach them; expose externally via Cloudflare Tunnel / ngrok /
// SSH tunnel as needed (see docs/how-to-journey.md).
//
// GET  /healthz  → 200 {ok, heartbeat_age_ms, ts} when heartbeat < 180s
//                  503 with {ok:false, ...} otherwise.
// POST /restart  → 202 {ok, restarting:true} if X-Watchdog-Token header
//                  matches WATCHDOG_RESTART_TOKEN; bot then exit(1) so
//                  the launchd watchdog respawns it within 2 min.
//                  401 if token missing/wrong, 501 if no token configured.

import http from 'node:http'
import fs from 'node:fs/promises'
import { config } from './config.js'
import { logger } from './logger.js'
import { HEARTBEAT_FILE, RESTART_REASON_FILE } from './heartbeat.js'

const HEALTH_HOST = '127.0.0.1'
const HEARTBEAT_STALE_MS = 180_000

let server: http.Server | undefined

const readHeartbeatAge = async (): Promise<number | null> => {
  try {
    const raw = await fs.readFile(HEARTBEAT_FILE, 'utf8')
    const ts = Number(raw.trim())
    if (!Number.isFinite(ts)) return null
    return Date.now() - ts
  } catch {
    return null
  }
}

const writeJson = (
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export const startHealthServer = (): void => {
  const port = config.HEALTH_PORT
  if (port <= 0) {
    logger.info(
      { event: 'healthz_disabled' },
      'health server disabled (HEALTH_PORT=0)',
    )
    return
  }

  server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'

    if (method === 'GET' && url === '/healthz') {
      const age = await readHeartbeatAge()
      if (age === null) {
        writeJson(res, 503, { ok: false, error: 'heartbeat file missing' })
        return
      }
      const stale = age > HEARTBEAT_STALE_MS
      writeJson(res, stale ? 503 : 200, {
        ok: !stale,
        heartbeat_age_ms: age,
        threshold_ms: HEARTBEAT_STALE_MS,
      })
      return
    }

    if (method === 'POST' && url === '/restart') {
      const expected = config.WATCHDOG_RESTART_TOKEN
      if (!expected) {
        writeJson(res, 501, {
          ok: false,
          error: 'WATCHDOG_RESTART_TOKEN not configured',
        })
        return
      }
      const got = req.headers['x-watchdog-token']
      if (got !== expected) {
        writeJson(res, 401, { ok: false, error: 'invalid or missing token' })
        return
      }
      // Caller identifies itself via X-Watchdog-Source so the watchdog
      // can attribute the DM after respawn. Sanitize to a single line.
      const rawSource = req.headers['x-watchdog-source']
      const source = (
        typeof rawSource === 'string' ? rawSource : (rawSource?.[0] ?? '')
      )
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 80)
      const sourceLabel = source || 'unknown external service'
      try {
        await fs.writeFile(
          RESTART_REASON_FILE,
          `HTTP /restart from ${sourceLabel}`,
        )
      } catch (err) {
        logger.warn(
          { err: String(err), file: RESTART_REASON_FILE },
          'failed to write restart-reason file',
        )
      }
      logger.warn(
        {
          event: 'remote_restart_requested',
          remote: req.socket.remoteAddress,
          source: sourceLabel,
        },
        'remote restart triggered via /restart',
      )
      writeJson(res, 202, { ok: true, restarting: true, exit_in_ms: 500 })
      // Give the response time to flush, then trigger the SIGINT shutdown
      // path so stopHealthServer() runs and port 8787 is released cleanly.
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 500).unref?.()
      return
    }

    writeJson(res, 404, { ok: false, error: 'not found' })
  })

  server.listen(port, HEALTH_HOST, () => {
    logger.info(
      { event: 'healthz_listening', host: HEALTH_HOST, port },
      'health endpoint up',
    )
  })
}

export const stopHealthServer = async (): Promise<void> => {
  if (!server) return
  const s = server
  server = undefined
  // closeAllConnections (Node 18+) drops keep-alive sockets immediately so
  // server.close() can resolve. Without it, the close callback waits on
  // idle keep-alive connections and our subsequent process.exit() leaves
  // the port in a held state — the next bot then crashes with EADDRINUSE.
  if (typeof s.closeAllConnections === 'function') {
    s.closeAllConnections()
  }
  await new Promise<void>((resolve) => {
    s.close(() => resolve())
  })
}
