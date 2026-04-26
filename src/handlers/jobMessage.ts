import type { BotContext } from '../bot.js'
import { runJob } from '../runJob.js'
import { runEditFlow } from '../runEdit.js'
import { getActiveJob } from '../db.js'
import {
  getPending,
  setPending,
  clearPending,
  wordCount,
  LONG_MESSAGE_WORDS,
  type PendingState,
} from '../disambiguate.js'
import { handleSaveSelection } from './save.js'

const URL_RE = /^https?:\/\//i

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const buildPrompt = (
  state: PendingState,
  activeSubject: string | undefined,
): { text: string; keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } => {
  const words = wordCount(state.text)
  if (state.jobId) {
    return {
      text:
        `📥 Buffered: <b>${words} words</b>.\n\n` +
        `You have an active job: <b>${escapeHtml(activeSubject ?? state.jobId)}</b>.\n\n` +
        `What's next?`,
      keyboard: {
        inline_keyboard: [
          [{ text: '📄 New job, end current', callback_data: 'pend:new' }],
          [{ text: '✏️ Edit current job', callback_data: 'pend:edit' }],
          [{ text: '⏳ More coming, wait', callback_data: 'pend:more' }],
        ],
      },
    }
  }
  return {
    text: `📥 Buffered: <b>${words} words</b>.\n\nProcess now or wait for more?`,
    keyboard: {
      inline_keyboard: [
        [{ text: '📄 Process as new JD', callback_data: 'pend:new' }],
        [{ text: '⏳ More coming, wait', callback_data: 'pend:more' }],
      ],
    },
  }
}

const showOrUpdatePrompt = async (
  ctx: BotContext,
  state: PendingState,
): Promise<void> => {
  const chatId = ctx.chat?.id
  if (chatId === undefined) return

  const active = state.jobId ? getActiveJob(chatId) : undefined
  const activeSubject =
    active?.role && active?.company
      ? `${active.role} at ${active.company}`
      : active?.job_id

  const { text, keyboard } = buildPrompt(state, activeSubject)

  if (state.promptMessageId !== undefined) {
    try {
      await ctx.api.editMessageText(chatId, state.promptMessageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      return
    } catch (err) {
      ctx.logger.warn(
        { err, mid: state.promptMessageId },
        'edit prompt failed, sending new',
      )
    }
  }

  const sent = await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
  state.promptMessageId = sent.message_id
}

export const jobMessageHandler = async (ctx: BotContext): Promise<void> => {
  const text = ctx.message?.text?.trim()
  const chatId = ctx.chat?.id
  if (!text || chatId === undefined) return
  if (text.startsWith('/')) return

  // /save selection takes precedence over everything else when active.
  if (await handleSaveSelection(ctx, text)) return

  const words = wordCount(text)
  ctx.logger.info(
    {
      event: 'text_message',
      chars: text.length,
      words,
      preview: text.slice(0, 80),
      has_pending: getPending(chatId) !== undefined,
    },
    'incoming text routed',
  )

  // URL always wins, clears pending.
  if (URL_RE.test(text)) {
    clearPending(chatId)
    await runJob(ctx, { url: text })
    return
  }

  // If pending exists, append + refresh prompt.
  const existing = getPending(chatId)
  if (existing) {
    existing.text = `${existing.text}\n\n${text}`
    setPending(chatId, existing)
    ctx.logger.info(
      {
        event: 'text_appended',
        total_words: wordCount(existing.text),
        added_words: words,
      },
      'appended to pending buffer',
    )
    await showOrUpdatePrompt(ctx, existing)
    return
  }

  // Short text: route immediately (preserves the quick-edit fast path).
  if (words < LONG_MESSAGE_WORDS) {
    const active = getActiveJob(chatId)
    if (active && active.session_id && active.workspace_path) {
      ctx.logger.info(
        { event: 'route_edit', words, job_id: active.job_id },
        'short text + active job → edit',
      )
      await runEditFlow(ctx, text)
    } else {
      ctx.logger.info(
        { event: 'route_new_short' },
        'short text + no active → new job',
      )
      await runJob(ctx, { text })
    }
    return
  }

  // Long text: park in pending, show "complete or more coming?" prompt.
  const active = getActiveJob(chatId)
  const state: PendingState = {
    text,
    jobId: active?.session_id && active?.workspace_path ? active.job_id : undefined,
  }
  setPending(chatId, state)
  ctx.logger.info(
    {
      event: 'pending_open',
      words,
      active_job: state.jobId,
    },
    'opened pending buffer',
  )
  await showOrUpdatePrompt(ctx, state)
}
