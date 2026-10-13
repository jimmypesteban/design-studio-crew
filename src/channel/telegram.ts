import fs from 'node:fs';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Attachment } from '../audit/target.ts';
import { clean } from '../plain.ts';
import type { Button, Channel } from './types.ts';

/**
 * The real Telegram channel, built on grammY with long polling.
 *
 * Security: the bot answers one person only, the owner id from TELEGRAM_OWNER_ID.
 * Everyone else is ignored. The token is read from the environment by the caller
 * and never logged.
 *
 * Status: written against the same interface as the mock and type checked. It has
 * not been run against Telegram yet because that needs your bot token.
 */
export class TelegramChannel implements Channel {
  private pendingButtons?: { resolve: (id: string) => void; ids: Set<string>; messageId?: number };
  private pendingText?: (t: string) => void;
  private onBrief?: (text: string, chatId: number, attachments: Attachment[]) => void;
  private chatId?: number;

  /**
   * `download` fetches a Telegram file by id. It is passed in so the token never lives in this
   * class and so tests can supply a fake. Saved files land in `inboxDir` and nowhere else.
   */
  constructor(
    private bot: Bot,
    private ownerId: number,
    private opts: { download?: (fileId: string) => Promise<{ data: Buffer; ext: string }>; inboxDir?: string } = {},
  ) {
    bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.ownerId) {
        // /start from a stranger gets one neutral line so the owner can read their own id.
        if (ctx.message?.text?.startsWith('/whoami')) await ctx.reply(`Your Telegram user id is ${ctx.from?.id}.`);
        return;
      }
      return next();
    });

    bot.command('start', (ctx) =>
      ctx.reply('Studio is ready. Send me a brief in plain words and I will propose a plan for you to approve.'),
    );
    bot.command('whoami', (ctx) => ctx.reply(`Your Telegram user id is ${ctx.from?.id}.`));

    bot.on('callback_query:data', async (ctx) => {
      const id = ctx.callbackQuery.data;
      if (this.pendingButtons?.ids.has(id)) {
        const p = this.pendingButtons;
        this.pendingButtons = undefined;
        await ctx.answerCallbackQuery();
        // Remove the buttons so an old message cannot be pressed twice.
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        p.resolve(id);
      } else {
        await ctx.answerCallbackQuery({ text: 'That button is no longer active.' });
      }
    });

    const MAX_BYTES = 10 * 1024 * 1024;
    const save = async (fileId: string, size: number | undefined, kind: Attachment['kind'], ctx: Context): Promise<Attachment | null> => {
      if (!this.opts.download || !this.opts.inboxDir) {
        await ctx.reply('Files are not switched on for this bot yet.');
        return null;
      }
      if (size && size > MAX_BYTES) {
        await ctx.reply('That file is over 10 MB. Send a smaller one.');
        return null;
      }
      try {
        const { data, ext } = await this.opts.download(fileId);
        if (data.length > MAX_BYTES) {
          await ctx.reply('That file is over 10 MB. Send a smaller one.');
          return null;
        }
        const safeExt = /^\.(png|jpe?g|webp|html?)$/i.test(ext) ? ext.toLowerCase() : kind === 'html' ? '.html' : '.jpg';
        fs.mkdirSync(this.opts.inboxDir, { recursive: true });
        const file = path.join(this.opts.inboxDir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}${safeExt}`);
        fs.writeFileSync(file, data);
        return { kind, path: file, name: path.basename(file) };
      } catch {
        await ctx.reply('I could not download that file from Telegram. Try sending it again.');
        return null;
      }
    };
    const handleFile = async (ctx: Context, fileId: string, size: number | undefined, kind: Attachment['kind']) => {
      this.chatId = ctx.chat?.id;
      if (this.pendingText || this.pendingButtons) {
        await ctx.reply('I am waiting for your answer to the last question. Reply to that first, then send the file.');
        return;
      }
      const a = await save(fileId, size, kind, ctx);
      if (a && this.onBrief) this.onBrief(ctx.message?.caption?.trim() || (kind === 'html' ? 'Please audit this page.' : 'Please review this screenshot.'), ctx.chat!.id, [a]);
    };
    bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1]!;
      await handleFile(ctx, best.file_id, best.file_size, 'image');
    });
    bot.on('message:document', async (ctx) => {
      const d = ctx.message.document;
      const name = d.file_name ?? '';
      const mime = d.mime_type ?? '';
      if (/^image\/(png|jpeg|webp)$/.test(mime)) await handleFile(ctx, d.file_id, d.file_size, 'image');
      else if (/\.html?$/i.test(name) || mime === 'text/html') await handleFile(ctx, d.file_id, d.file_size, 'html');
      else await ctx.reply('I can read PNG, JPEG or WebP images and HTML files. Send one of those, or a web address.');
    });

    bot.on('message:text', (ctx: Context) => {
      this.chatId = ctx.chat?.id;
      const text = ctx.message?.text ?? '';
      if (text.startsWith('/')) return;
      if (this.pendingText) {
        const r = this.pendingText;
        this.pendingText = undefined;
        r(text);
      } else if (this.onBrief) {
        this.onBrief(text, ctx.chat!.id, []);
      }
    });
  }

  /** Register what happens when a brief arrives while no question is open. */
  setBriefHandler(fn: (text: string, chatId: number, attachments: Attachment[]) => void): void {
    this.onBrief = fn;
  }

  private target(): number {
    if (!this.chatId) throw new Error('No chat yet. Send the bot a message first.');
    return this.chatId;
  }

  async say(text: string): Promise<void> {
    await this.bot.api.sendMessage(this.target(), clean(text));
  }

  async sendFile(filePath: string, caption?: string): Promise<void> {
    const file = new InputFile(filePath);
    const cap = caption ? clean(caption).slice(0, 1000) : undefined;
    if (/\.(png|jpe?g)$/i.test(filePath)) await this.bot.api.sendPhoto(this.target(), file, { caption: cap });
    else await this.bot.api.sendDocument(this.target(), file, { caption: cap });
  }

  ask(text: string, buttons: Button[]): Promise<string> {
    const kb = new InlineKeyboard();
    buttons.forEach((b, i) => {
      kb.text(b.label, b.id);
      if (i % 2 === 1) kb.row();
    });
    return new Promise((resolve, reject) => {
      this.bot.api
        .sendMessage(this.target(), clean(text).slice(0, 4000), { reply_markup: kb })
        .then(() => {
          this.pendingButtons = { resolve, ids: new Set(buttons.map((b) => b.id)) };
        })
        .catch(reject);
    });
  }

  askText(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.bot.api
        .sendMessage(this.target(), clean(prompt))
        .then(() => {
          this.pendingText = resolve;
        })
        .catch(reject);
    });
  }
}
