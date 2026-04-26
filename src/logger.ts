import fs from 'node:fs'
import path from 'node:path'
import pino, { type Logger } from 'pino'
import { config, isProd } from './config.js'

fs.mkdirSync(config.LOG_DIR, { recursive: true })

const todayLogPath = path.join(
  config.LOG_DIR,
  `${new Date().toISOString().slice(0, 10)}.log`,
)

export const logger: Logger = isProd
  ? pino(pino.destination({ dest: todayLogPath, sync: false, mkdir: true }))
  : pino({
      level: 'debug',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    })
