// /commands — terse, tappable command list. Unlike /help (which has
// descriptions and tips), this is just the names so users can scan and
// click. Admins also see admin-only commands.

import type { BotContext } from '../bot.js'
import { isAdmin } from '../access.js'
import { PUBLIC_COMMAND_MENU, ADMIN_COMMAND_MENU } from '../menus.js'

export const commandsHandler = async (ctx: BotContext): Promise<void> => {
  const lines = PUBLIC_COMMAND_MENU.map((c) => `/${c.command}`)
  if (isAdmin(ctx.from?.id ?? -1)) {
    lines.push('', '— admin —', ...ADMIN_COMMAND_MENU.map((c) => `/${c.command}`))
  }
  await ctx.reply(lines.join('\n'), {
    link_preview_options: { is_disabled: true },
  })
}
