import fs from 'node:fs'
import path from 'node:path'
import pino, { type Logger } from 'pino'
import { config, isProd } from './config.js'

fs.mkdirSync(config.LOG_DIR, { recursive: true })

const todayLogPath = path.join(
  config.LOG_DIR,
  `${new Date().toISOString().slice(0, 10)}.log`,
)

// Pino is configured to ALWAYS write to the daily log file, regardless of
// NODE_ENV. The previous design (file in prod, stdout-via-pino-pretty in
// dev) silently dropped logs into whatever parent process owned stdout —
// in particular, when the sibling job-intake project's web.server spawned
// us, all our logs landed in `~/bot/logs/watchdog-jobintake.log` and the
// expected `LOG_DIR/YYYY-MM-DD.log` was never created. Multi-target
// transport in dev keeps the pretty stdout view AND writes the file.
// (RCA + fix: ADR-031.)
export const logger: Logger = isProd
  ? pino(pino.destination({ dest: todayLogPath, sync: false, mkdir: true }))
  : pino({
      level: 'debug',
      transport: {
        targets: [
          {
            target: 'pino-pretty',
            level: 'debug',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          },
          {
            target: 'pino/file',
            level: 'debug',
            options: { destination: todayLogPath, mkdir: true },
          },
        ],
      },
    })
