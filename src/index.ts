// Boot order matters: env validation -> logger -> db -> bot -> middleware -> handlers.
import { config } from './config.js'
import { logger } from './logger.js'
import { closeDb } from './db.js'
import { bot } from './bot.js'
import { startArchiveCron, stopArchiveCron } from './archiveCron.js'
import { allowlist } from './middleware/allowlist.js'
import { preOnboarding } from './middleware/preOnboarding.js'
import { startHandler } from './handlers/start.js'
import { confirmHandler } from './handlers/confirm.js'
import { reuploadHandler } from './handlers/reupload.js'
import { reonboardHandler } from './handlers/reonboard.js'
import { saveHandler } from './handlers/save.js'
import { jobsHandler } from './handlers/jobs.js'
import { editHandler } from './handlers/edit.js'
import { documentHandler } from './handlers/document.js'
import { jobMessageHandler } from './handlers/jobMessage.js'
import { doneHandler } from './handlers/done.js'
import { contextHandler } from './handlers/context.js'
import { statusHandler } from './handlers/status.js'
import { resetHandler } from './handlers/reset.js'
import { helpHandler } from './handlers/help.js'
import { callbackRouter } from './handlers/callbacks.js'
import {
  pendingHandler,
  allowHandler,
  denyHandler,
  usersHandler,
  revokeHandler,
  blockHandler,
  unblockHandler,
} from './handlers/admin.js'

bot.use(allowlist)
bot.use(preOnboarding)
bot.command('start', startHandler)
bot.command('help', helpHandler)
bot.command('confirm', confirmHandler)
bot.command('reupload', reuploadHandler)
bot.command('reonboard', reonboardHandler)
bot.command('done', doneHandler)
bot.command('save', saveHandler)
bot.command('jobs', jobsHandler)
bot.command('edit', editHandler)
bot.command('context', contextHandler)
bot.command('status', statusHandler)
bot.command('reset', resetHandler)
// Admin-only — chat_id checks gate them. Not advertised in /help.
bot.command('pending', pendingHandler)
bot.command('allow', allowHandler)
bot.command('deny', denyHandler)
bot.command('users', usersHandler)
bot.command('revoke', revokeHandler)
bot.command('block', blockHandler)
bot.command('unblock', unblockHandler)
bot.on('callback_query:data', callbackRouter)
bot.on('message:document', documentHandler)
bot.on('message:text', jobMessageHandler)

let shuttingDown = false
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ event: 'shutdown', signal }, 'shutting down')
  stopArchiveCron()
  try {
    await bot.stop()
  } catch (err) {
    logger.warn({ err }, 'bot.stop() failed')
  }
  closeDb()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

startArchiveCron()

bot.start({
  onStart: () => {
    logger.info(
      {
        event: 'bot_started',
        allowlist_size: config.ALLOWED_CHAT_IDS.length,
        node_env: config.NODE_ENV,
      },
      'bot started',
    )
  },
})
