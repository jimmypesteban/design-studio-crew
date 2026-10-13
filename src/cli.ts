import fs from 'node:fs';
import path from 'node:path';
import { MockChannel } from './channel/mock.ts';
import { screenshotHtml } from './reviewer/index.ts';
import type { Attachment } from './audit/target.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { makeImages, makeLlm } from './factory.ts';
import { loadMoonTokens } from './moon/tokens.ts';
import { formatLog, runJob } from './pipeline.ts';
import { startStudio } from './studio.ts';

const DEFAULT_BRIEF =
  'A weekly progress screen for a student in a learning app: their streak, lessons done this week, the next lesson, and a kind nudge if they have fallen behind.';

// Answers the mock Telegram gives, in order. It shows a human rejection too:
// approve the route, strategy and UX, send the first passing screen back once, then approve.
const DEMO_SCRIPT = ['approve', 'approve', 'approve', 'reject', 'Please make it simpler, with fewer sections.', 'approve', 'handoff', 'approve'];

const AUDIT_BRIEF = 'Audit this page against the standard: samples/messy-dashboard.html';

// Audit: approve the route, approve the audit plan (before the page is opened), waive two findings with a reason,
// then approve the fix list. Run it twice and the second report shows what was waived and what is unchanged.
const AUDIT_SCRIPT = ['approve', 'approve', 'waive', 'long-line, heading-skip because the long copy and the heading order are deliberate in this demo', 'approve'];
const AUDIT_IMAGE_SCRIPT = ['approve', 'approve', 'approve'];

const BRAND_BRIEF =
  'Autumn term campaign for a learning app. Make 3 variations of a social post in the standard sizes. The headline is "Learn a little every day".';

// Brand: approve the route, strategy and the plan (before any image is made). The Reviewer rejects the first
// layout and the agent fixes it. You send the sheet back once, approve the new images, then approve, then the handoff.
const BRAND_SCRIPT = ['approve', 'approve', 'approve', 'reject', 'Make the second variation calmer and less busy.', 'approve', 'approve', 'handoff', 'approve'];

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  if (cmd === 'demo') {
    const store = new Store(cfg.dbPath);
    const llm = makeLlm(cfg);
    const tokens = await loadMoonTokens(cfg.moonPath);
    const images = makeImages(cfg, tokens);
    const interactive = flag(args, 'interactive');
    const quick = flag(args, 'quick');
    const brand = flag(args, 'brand');
    const audit = flag(args, 'audit');
    const image = flag(args, 'image');
    const attachments: Attachment[] = [];
    let brief = option(args, 'brief') ?? (audit ? AUDIT_BRIEF : brand ? BRAND_BRIEF : DEFAULT_BRIEF);
    if (audit && image) {
      // A screenshot of the sample at phone width, as if it had been sent in Telegram.
      const png = path.join(cfg.outDir, 'inbox', 'demo-phone-screenshot.png');
      await screenshotHtml({ htmlFile: path.join(cfg.root, 'samples', 'messy-dashboard.html'), pngFile: png, chromePath: cfg.chromePath, width: 375, exactWidth: true });
      attachments.push({ kind: 'image', path: png, name: 'demo-phone-screenshot.png' });
      brief = option(args, 'brief') ?? 'Please review this screenshot.';
    }
    const script = audit ? (image ? AUDIT_IMAGE_SCRIPT : AUDIT_SCRIPT) : brand ? BRAND_SCRIPT : DEMO_SCRIPT;
    const channel = new MockChannel({ interactive, script: interactive || quick ? [] : script });
    console.log(`Design Studio Crew demo (${llm.mode} agents, ${images.name} images, mock Telegram)\n`);
    channel.me(brief);
    const result = await runJob({ cfg, store, llm, channel, tokens, images }, brief, { seedFlaw: !flag(args, 'clean'), offerHandoff: !flag(args, 'no-handoff'), attachments });
    channel.close();
    fs.writeFileSync(path.join(result.dir, 'telegram-transcript.md'), '# Mock Telegram transcript\n' + channel.transcript.join('\n') + '\n');
    console.log(`\nStatus: ${result.status}`);
    console.log(`Job folder: ${path.relative(process.cwd(), result.dir)}`);
    if (result.finalHtml) console.log(`Open: ${result.finalHtml}`);
    store.close();
    process.exit(result.status === 'done' ? 0 : 1);
  }

  if (cmd === 'studio') {
    const store = new Store(cfg.dbPath);
    await startStudio(cfg, store, makeLlm(cfg));
    return;
  }

  if (cmd === 'log') {
    const store = new Store(cfg.dbPath);
    const id = args[0];
    if (!id) {
      for (const j of store.listJobs()) console.log(`${j.id}  ${j.status}  ${j.llm_mode}  $${j.cost_usd.toFixed(2)}`);
    } else {
      const job = store.getJob(id);
      if (!job) throw new Error(`No job called ${id}.`);
      console.log(formatLog(job.brief, store.events(id)));
    }
    store.close();
    return;
  }

  console.log(`Design Studio Crew

  npm run demo                 Screen demo: free mock agents, mock Telegram, then the Handoff pack
  npm run demo:audit           Audit demo: a messy sample page, measured in Chrome, waivers and a fix list
  npm run demo -- --audit --image  Audit a phone screenshot (pixel analysis only)
  npm run demo:brand           Brand demo: 3 variations in 5 sizes, plan approved before any image, then the asset spec
  npm run demo -- --interactive  Press the buttons yourself in the terminal
  npm run demo -- --quick      Approve every step without a human rejection
  npm run demo -- --no-handoff Skip the Handoff offer
  npm run demo:clean           Mock agents build it right first time, so the Reviewer passes at once
  npm run demo -- --brief "..."  Use your own brief
  npm run studio               Start the real Telegram bot (needs .env, see README)
  npm run log [job-id]         List jobs, or print one job's log
`);
}

main().catch((e) => {
  console.error(`\nError: ${(e as Error).message}`);
  process.exit(1);
});
