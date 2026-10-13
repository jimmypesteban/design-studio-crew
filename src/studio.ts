import path from 'node:path';
import { Bot } from 'grammy';
import type { Attachment } from './audit/target.ts';
import { TelegramChannel } from './channel/telegram.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { LLM } from './agents/types.ts';
import { runJob } from './pipeline.ts';
import { loadMoonTokens } from './moon/tokens.ts';
import { makeImages } from './factory.ts';

/** Run the real Telegram bot. One job at a time, extra briefs wait in a queue. */
export async function startStudio(cfg: Config, store: Store, llm: LLM): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Create a bot with BotFather and put the token in .env. See the README.');
  }
  if (!cfg.telegramOwnerId) {
    // Setup mode: the only thing the bot does is tell you your own id, so you can lock it to you.
    const setup = new Bot(token);
    setup.on('message', (ctx) =>
      ctx.reply(
        `Your Telegram user id is ${ctx.from?.id}. Put it in .env as TELEGRAM_OWNER_ID, stop this program, and start it again. Until then I will not take any briefs.`,
      ),
    );
    console.log('TELEGRAM_OWNER_ID is not set, so the studio is in setup mode.');
    console.log('Open your bot in Telegram and send it any message. It will reply with your user id.');
    console.log('Put that number in .env as TELEGRAM_OWNER_ID, then press Ctrl+C and run this again.');
    await setup.start();
    return;
  }
  const tokens = await loadMoonTokens(cfg.moonPath);
  const images = makeImages(cfg, tokens);
  const bot = new Bot(token);
  // The token appears only in this download address. Errors are replaced so it can never reach a log or a message.
  const download = async (fileId: string) => {
    const f = await bot.api.getFile(fileId);
    if (!f.file_path) throw new Error('Telegram gave no file path.');
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`).catch(() => {
      throw new Error('Telegram download failed.');
    });
    if (!res.ok) throw new Error('Telegram download failed.');
    return { data: Buffer.from(await res.arrayBuffer()), ext: path.extname(f.file_path) };
  };
  const channel = new TelegramChannel(bot, cfg.telegramOwnerId, { download, inboxDir: path.join(cfg.outDir, 'inbox') });
  const queue: { brief: string; attachments: Attachment[] }[] = [];
  let busy = false;

  const next = async () => {
    if (busy) return;
    const next1 = queue.shift();
    if (!next1) return;
    const { brief, attachments } = next1;
    busy = true;
    try {
      await runJob({ cfg, store, llm, channel, tokens, images }, brief, { seedFlaw: false, attachments });
    } catch (e) {
      console.error('Job crashed:', (e as Error).message);
    } finally {
      busy = false;
      void next();
    }
  };

  channel.setBriefHandler((text, _chat, attachments) => {
    queue.push({ brief: text, attachments });
    if (busy) void channel.say(`Queued. ${queue.length} brief(s) waiting.`);
    void next();
  });
  bot.catch((err) => console.error('Bot error:', err.message));

  console.log(`Studio is listening on Telegram (${llm.mode} mode). Press Ctrl+C to stop.`);
  await bot.start();
}
