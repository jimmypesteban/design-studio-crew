import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot } from 'grammy';
import { TelegramChannel } from '../src/channel/telegram.ts';
import { APPROVE, REJECT } from '../src/channel/types.ts';

const OWNER = 7;
const STRANGER = 99;

/** A bot with no network: every API call is recorded and answered with a fake success. */
function fakeBot() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const bot = new Bot('123456:not-a-real-token', {
    botInfo: { id: 123456, is_bot: true, first_name: 'Studio', username: 'studio_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: method === 'sendMessage' ? { message_id: 1, chat: { id: 42 }, date: 0 } : true } as never;
  });
  return { bot, calls };
}

const msg = (from: number, text: string, id = 1) => ({
  update_id: id,
  message: { message_id: id, date: 0, chat: { id: 42, type: 'private' as const, first_name: 'J' }, from: { id: from, is_bot: false, first_name: 'J' }, text },
});
const press = (from: number, data: string, id = 50) => ({
  update_id: id,
  callback_query: {
    id: String(id), chat_instance: 'x', data, from: { id: from, is_bot: false, first_name: 'J' },
    message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' as const, first_name: 'J' } },
  },
});
const tick = () => new Promise((r) => setTimeout(r, 20));

test('briefs from the owner are accepted, briefs from anyone else are ignored', async () => {
  const { bot } = fakeBot();
  const ch = new TelegramChannel(bot, OWNER);
  const briefs: string[] = [];
  ch.setBriefHandler((t) => briefs.push(t));
  await bot.handleUpdate(msg(STRANGER, 'build me a thing', 1));
  await bot.handleUpdate(msg(OWNER, 'A weekly progress screen', 2));
  assert.deepEqual(briefs, ['A weekly progress screen']);
});

test('inline buttons resolve only for the owner, and only once', async () => {
  const { bot, calls } = fakeBot();
  const ch = new TelegramChannel(bot, OWNER);
  ch.setBriefHandler(() => undefined);
  await bot.handleUpdate(msg(OWNER, 'hello', 1)); // sets the chat

  const pending = ch.ask('UX proposes: a flow', [APPROVE, REJECT]);
  await tick();
  const sent = calls.find((c) => c.method === 'sendMessage' && JSON.stringify(c.payload).includes('inline_keyboard'));
  assert.ok(sent, 'buttons were sent');
  assert.match(JSON.stringify(sent!.payload), /"approve"/);

  let settled = false;
  void pending.then(() => (settled = true));
  await bot.handleUpdate(press(STRANGER, 'approve', 51)); // a stranger presses it
  await tick();
  assert.equal(settled, false, 'a stranger must not be able to approve');

  await bot.handleUpdate(press(OWNER, 'reject', 52));
  assert.equal(await pending, 'reject');

  // A second press of an old button does nothing
  await bot.handleUpdate(press(OWNER, 'approve', 53));
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && JSON.stringify(c.payload).includes('no longer active')));
});

test('askText captures the next reply instead of starting a new job', async () => {
  const { bot } = fakeBot();
  const ch = new TelegramChannel(bot, OWNER);
  const briefs: string[] = [];
  ch.setBriefHandler((t) => briefs.push(t));
  await bot.handleUpdate(msg(OWNER, 'first brief', 1));
  const reply = ch.askText('What should change?');
  await tick();
  await bot.handleUpdate(msg(OWNER, 'Make the button bigger', 2));
  assert.equal(await reply, 'Make the button bigger');
  assert.deepEqual(briefs, ['first brief']);
});

test('messages sent out are cleaned of dashes and secrets', async () => {
  const { bot, calls } = fakeBot();
  const ch = new TelegramChannel(bot, OWNER);
  ch.setBriefHandler(() => undefined);
  await bot.handleUpdate(msg(OWNER, 'hello', 1));
  process.env.TELEGRAM_BOT_TOKEN = 'tg-secret-token-value';
  await ch.say('one \u2014 two tg-secret-token-value');
  delete process.env.TELEGRAM_BOT_TOKEN;
  const out = JSON.stringify(calls.filter((c) => c.method === 'sendMessage').at(-1));
  assert.equal(/\\u2014|\u2014/.test(out), false);
  assert.equal(out.includes('tg-secret-token-value'), false);
});
