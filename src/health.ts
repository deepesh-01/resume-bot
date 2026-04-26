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
import { HEARTBEAT_FILE } from './heartbeat.js'

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
      logger.warn(
        { event: 'remote_restart_requested', remote: req.socket.remoteAddress },
        'remote restart triggered via /restart',
      )
      writeJson(res, 202, { ok: true, restarting: true, exit_in_ms: 500 })
      // Give the response time to flush; then exit. Watchdog respawns.
      setTimeout(() => process.exit(1), 500).unref?.()
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

export const stopHealthServer = (): void => {
  if (server) {
    server.close()
    server = undefined
  }
}
