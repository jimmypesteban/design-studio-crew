import type { AgentContext, AgentRequest, LLM, LLMResult, ToolRunner } from '../agents/types.ts';

/**
 * The offline stand-in for the model. It answers in exactly the same formats as
 * the live agents, so the pipeline, parsers, Reviewer and approval flow are the
 * real thing in both modes. Only the words and markup come from templates.
 */

export type Archetype = 'dashboard' | 'auth' | 'catalog' | 'landing';

export function detectArchetype(brief: string): Archetype {
  const b = brief.toLowerCase();
  if (/sign ?up|log ?in|sign ?in|register|password|create (an )?account/.test(b)) return 'auth';
  if (/progress|dashboard|streak|weekly|overview|stats|score/.test(b)) return 'dashboard';
  if (/catalog|browse|courses|library|search|list of/.test(b)) return 'catalog';
  return 'landing';
}

export function detectKind(brief: string): 'ui' | 'brand' | 'audit' {
  const b = brief.toLowerCase();
  if (/https?:\/\/|audit|review (the|this|my)|qa |check (the|this|my) (screen|page)/.test(b)) return 'audit';
  if (/logo|banner|social post|poster|campaign|marketing asset|ad creative|variations?/.test(b)) return 'brand';
  return 'ui';
}

const NAMES: Record<Archetype, string> = {
  dashboard: 'Weekly progress',
  auth: 'Create account',
  catalog: 'Course catalog',
  landing: 'Welcome',
};

function lead(ctx: AgentContext): string {
  const hasImage = ctx.attachments?.some((a) => a.kind === 'image' || a.kind === 'html') ?? false;
  const kind = hasImage && !/\b(build|make|create|design)\b/i.test(ctx.brief) ? 'audit' : detectKind(ctx.brief);
  const arch = detectArchetype(ctx.brief);
  const wantsHandoff = /\bcode\b|react|developer|engineer|build-ready|handoff|hand off|spec\b/i.test(ctx.brief);
  const route =
    kind === 'ui'
      ? ['strategist', 'ux', 'ui', 'reviewer', ...(wantsHandoff ? ['handoff'] : [])]
      : kind === 'brand'
        ? ['strategist', 'brand', 'reviewer', ...(wantsHandoff ? ['handoff'] : [])]
        : ['reviewer', 'handoff'];
  const summary =
    kind === 'ui'
      ? `This is a screen from a written brief, so it goes strategy, then UX, then UI, then the Reviewer checks it.`
      : kind === 'brand'
        ? 'This asks for brand assets in variations and sizes, so Brand plans them, you approve the plan before any image is made, and the Reviewer checks every asset.'
        : 'This asks for a review of something that already exists. The Reviewer measures it, then Handoff writes the fix list. Nothing is opened until you approve the audit plan.';
  return '```json\n' + JSON.stringify({ kind, screen_name: kind === 'ui' ? NAMES[arch] : kind === 'brand' ? 'Campaign assets' : 'Audit', route, summary, questions: [] }) + '\n```';
}

interface Copy {
  goal: string;
  users: string[];
  good: string[];
  flow: string[];
  outline: { section: string; components: string[]; purpose: string }[];
  states: string[];
}

const COPY: Record<Archetype, Copy> = {
  dashboard: {
    goal: 'Help a learner see how their week is going and take the next step in under ten seconds, without feeling judged if they are behind.',
    users: ['A student opening the app on a phone between other things.', 'A learner who has missed a day and is deciding whether to carry on.'],
    good: ['The next lesson button is visible without scrolling at 375 px.', 'A learner can say how many lessons they finished this week after one look.', 'Being behind reads as a nudge, not a warning.'],
    flow: ['Open the app and land on the weekly view.', 'Read the nudge and the three numbers.', 'Check progress against the weekly goal.', 'Press Continue lesson, or see the upcoming list.'],
    outline: [
      { section: 'Greeting', components: ['Avatar'], purpose: 'Say whose week this is.' },
      { section: 'Nudge', components: ['Alert'], purpose: 'Say how far behind they are, kindly.' },
      { section: 'Numbers', components: ['Card', 'Badge'], purpose: 'Streak, lessons done and minutes learned.' },
      { section: 'Weekly goal', components: ['Card', 'ProgressBar'], purpose: 'Show progress to the goal.' },
      { section: 'Next lesson', components: ['Card', 'Button'], purpose: 'One clear next action.' },
      { section: 'Upcoming', components: ['Card'], purpose: 'The next three lessons.' },
    ],
    states: ['First load: the numbers show a short skeleton, then fill in.', 'Empty: a new learner sees an empty state with a Start your first lesson button.', 'Error: a warning alert says the numbers did not load and offers Try again.', 'Success: all lessons done shows a calm message and a Review button.'],
  },
  auth: {
    goal: 'Let a new learner create an account in one pass, with no surprises, and know what happens next.',
    users: ['A student signing up on a phone, often for the first time.', 'A parent or teacher setting up an account on a laptop.'],
    good: ['Every field has a visible label and a clear error message.', 'The main button sits within thumb reach at 375 px.', 'People who already have an account find the sign in link without searching.'],
    flow: ['Arrive on the sign up screen.', 'Fill in name, email and password.', 'Accept the terms.', 'Press Create account, or follow the link to sign in.'],
    outline: [
      { section: 'Title', components: ['Card'], purpose: 'Say what the screen is for.' },
      { section: 'Fields', components: ['Input'], purpose: 'Name, email and password with helper text.' },
      { section: 'Terms', components: ['Checkbox'], purpose: 'Agree to the terms.' },
      { section: 'Action', components: ['Button'], purpose: 'One primary action.' },
      { section: 'Alternative', components: ['Link'], purpose: 'Sign in for existing accounts.' },
    ],
    states: ['First load: empty form, focus on the first field.', 'Empty: submitting blank fields shows an error under each field.', 'Error: an email already in use shows an alert above the button.', 'Success: the person lands on a welcome screen.'],
  },
  catalog: {
    goal: 'Help a learner find a course they want to start, and see how far along they are in the ones they have begun.',
    users: ['A student looking for something new to learn.', 'A returning learner looking for the course they were halfway through.'],
    good: ['A learner can narrow the list with search in one step.', 'Each course shows its level and progress at a glance.', 'The grid reads cleanly at 375, 768 and 1024 px.'],
    flow: ['Open the catalog.', 'Search or pick a level.', 'Scan the course cards.', 'Open a course or continue one in progress.'],
    outline: [
      { section: 'Title and search', components: ['Input'], purpose: 'Name the screen and let people search.' },
      { section: 'Level filters', components: ['Button'], purpose: 'Filter by level.' },
      { section: 'Course grid', components: ['Card', 'Badge', 'ProgressBar', 'Button'], purpose: 'One card per course.' },
    ],
    states: ['First load: card skeletons.', 'Empty: no results shows an empty state and a Clear filters button.', 'Error: an alert says the catalog did not load, with Try again.', 'Success: the grid of courses.'],
  },
  landing: {
    goal: 'Tell a visitor in one screen what the product does and give them one clear next step.',
    users: ['A first-time visitor on a phone who knows nothing about the product.', 'A teacher comparing tools on a laptop.'],
    good: ['The headline says what the product is for in plain words.', 'There is one main button above the fold at 375 px.', 'Three reasons to care are readable without scrolling sideways.'],
    flow: ['Arrive on the page.', 'Read the headline.', 'Scan three reasons.', 'Press the main button.'],
    outline: [
      { section: 'Hero', components: ['Button'], purpose: 'Headline, one sentence and the main action.' },
      { section: 'Reasons', components: ['Card'], purpose: 'Three short reasons to try it.' },
      { section: 'Closing action', components: ['Button'], purpose: 'Repeat the main action.' },
    ],
    states: ['First load: static content, nothing to wait for.', 'Empty: not applicable.', 'Error: a failed sign up shows an alert above the form.', 'Success: the visitor reaches the next step.'],
  },
};

function brandStrategist(ctx: AgentContext): string {
  const feedback = ctx.feedback ? `\nRevised after feedback: ${ctx.feedback}\n` : '';
  return `## Goal
Give the campaign a small, consistent set of marketing assets that say one clear thing and invite one clear action, in every size the channels need.

## Users
- People scrolling a social feed who give each image about a second.
- Parents and teachers who see the asset as a link preview or a banner.

## Constraints
- Moon colours and type only. Text sits on a solid Moon panel so contrast can be measured.
- Text stays inside the platform safe zones, clear of the edges.
- All text passes WCAG AA contrast.
- Artwork is generated without any text. The studio sets every word.
- A hard limit on how many images one job may generate, so the cost is known before anything is made.
- From the brief: ${ctx.brief.trim().replace(/\s+/g, ' ').slice(0, 200)}

## What good looks like
1. The same message reads clearly in the square, the story and the banner.
2. Each variation looks different enough to be a real choice.
3. Every asset passes the Reviewer at its exact pixel size.

## Open questions
None. Assumption: the copy is a draft until Jimmy confirms the real offer. Platform size rules change, so check them before publishing.
${feedback}`;
}

function strategist(ctx: AgentContext): string {
  if (detectKind(ctx.brief) === 'brand') return brandStrategist(ctx);
  const c = COPY[detectArchetype(ctx.brief)];
  const feedback = ctx.feedback ? `\nRevised after feedback: ${ctx.feedback}\n` : '';
  return `## Goal
${c.goal}

## Users
${c.users.map((u) => `- ${u}`).join('\n')}

## Constraints
- Built from Moon tokens and ready-made classes only.
- Works at 375, 768 and 1024 px wide with no sideways scrolling.
- All text passes WCAG AA contrast.
- From the brief: ${ctx.brief.trim().replace(/\s+/g, ' ').slice(0, 200)}

## What good looks like
${c.good.map((g, i) => `${i + 1}. ${g}`).join('\n')}

## Open questions
None. Assumption: content on the screen is sample content until real data is connected.
${feedback}`;
}

function ux(ctx: AgentContext): string {
  const c = COPY[detectArchetype(ctx.brief)];
  const feedback = ctx.feedback ? `\nRevised after feedback: ${ctx.feedback}\n` : '';
  return `## Flow
${c.flow.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Screen outline
\`\`\`json
${JSON.stringify(c.outline, null, 2)}
\`\`\`

## States
${c.states.map((s) => `- ${s}`).join('\n')}

## Notes for UI
- At 375 px everything stacks in one column. From 768 px cards sit side by side where they fit.
- Keep one primary action on the screen.
- Use mo-muted for secondary text, never a light grey step.
- All components used already exist in Moon.
${feedback}`;
}

// ---------- UI templates ----------

type Flaw = 'contrast' | 'overflow' | 'palette';

function flawsFor(ctx: AgentContext): Set<Flaw> {
  const set = new Set<Flaw>();
  if (!ctx.seedFlaw) return set;
  const flagged = new Set(ctx.flaggedRules);
  if (!flagged.has('contrast')) set.add('contrast');
  if (!flagged.has('horizontal-overflow')) set.add('overflow');
  if (!flagged.has('off-palette')) set.add('palette');
  return set;
}

const sample = 'Sample content for the demo.';

function dashboard(f: Set<Flaw>, simple: boolean): string {
  const streak = f.has('palette')
    ? `<span class="mo-badge" style="background:#FF6B35;color:#FFFFFF">5 day streak</span>`
    : `<span class="mo-badge mo-badge--warning">5 day streak</span>`;
  const help = f.has('contrast')
    ? `<p class="mo-body-sm" style="color:var(--mo-grey-5)">Numbers update when you finish a lesson.</p>`
    : `<p class="mo-body-sm mo-muted">Numbers update when you finish a lesson.</p>`;
  const stats = `<div class="mo-grid mo-gap-4">
        <div class="mo-card"><div class="mo-card__body mo-stat"><span class="mo-annotation mo-muted">Streak</span><span class="mo-stat__value">5 days</span>${streak}</div></div>
        <div class="mo-card"><div class="mo-card__body mo-stat"><span class="mo-annotation mo-muted">Lessons done</span><span class="mo-stat__value">7 of 10</span><span class="mo-badge mo-badge--info">On track for Friday</span></div></div>
        <div class="mo-card"><div class="mo-card__body mo-stat"><span class="mo-annotation mo-muted">Minutes learned</span><span class="mo-stat__value">84</span><span class="mo-badge mo-badge--success">Up 12 from last week</span></div></div>
      </div>`;
  const statsBlock = f.has('overflow') ? `<div style="min-width:420px">${stats}</div>` : stats;
  const upcoming = simple
    ? ''
    : `<div class="mo-card">
        <div class="mo-card__header"><h2 class="mo-h7">Coming up</h2></div>
        <div class="mo-card__body"><ul class="mo-list">
          <li class="mo-list__item"><span class="mo-avatar" aria-hidden="true">1</span><span class="mo-grow">Fractions in the kitchen</span><span class="mo-badge mo-badge--neutral">8 min</span></li>
          <li class="mo-list__item"><span class="mo-avatar" aria-hidden="true">2</span><span class="mo-grow">Reading a bar chart</span><span class="mo-badge mo-badge--neutral">6 min</span></li>
          <li class="mo-list__item"><span class="mo-avatar" aria-hidden="true">3</span><span class="mo-grow">Number patterns</span><span class="mo-badge mo-badge--neutral">10 min</span></li>
        </ul></div>
      </div>`;
  return `<div class="mo-container mo-section">
  <div class="mo-stack mo-gap-8">
    <div class="mo-row mo-gap-4">
      <span class="mo-avatar" aria-hidden="true">AR</span>
      <div class="mo-stack mo-gap-1">
        <h1 class="mo-h4">Your week, Alex</h1>
        <p class="mo-body mo-muted">${sample}</p>
      </div>
    </div>
    <div class="mo-alert mo-alert--warning" role="status"><span><strong>Two lessons behind.</strong> One short lesson today puts your streak back on track.</span></div>
    ${statsBlock}
    ${help}
    <div class="mo-grid mo-grid--2 mo-gap-6">
      <div class="mo-card">
        <div class="mo-card__header"><h2 class="mo-h7">Weekly goal</h2></div>
        <div class="mo-card__body mo-stack mo-gap-3">
          <div class="mo-progress" role="progressbar" aria-label="Weekly goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="70"><div class="mo-progress__bar" style="width:70%"></div></div>
          <p class="mo-body-sm mo-muted">7 of 10 lessons finished. Three to go by Sunday.</p>
        </div>
      </div>
      <div class="mo-card">
        <div class="mo-card__header"><h2 class="mo-h7">Next lesson</h2></div>
        <div class="mo-card__body mo-stack mo-gap-3">
          <p class="mo-body">Fractions in the kitchen, about 8 minutes.</p>
          <div class="mo-row mo-gap-3">
            <a class="mo-btn mo-btn--primary mo-btn--lg" href="#lesson">Continue lesson</a>
            <a class="mo-btn mo-btn--outline mo-btn--lg" href="#all">See all lessons</a>
          </div>
        </div>
      </div>
    </div>
    ${upcoming}
  </div>
</div>`;
}

function auth(brief: string): string {
  const signIn = /log ?in|sign ?in/.test(brief.toLowerCase()) && !/sign ?up|register|create/.test(brief.toLowerCase());
  const title = signIn ? 'Welcome back' : 'Create your account';
  const action = signIn ? 'Sign in' : 'Create account';
  const nameField = signIn
    ? ''
    : `<div class="mo-field"><label class="mo-label" for="name">Full name</label><input class="mo-input" id="name" name="name" type="text" autocomplete="name" placeholder="Alex Rivera"></div>`;
  const terms = signIn
    ? ''
    : `<label class="mo-check"><input type="checkbox" name="terms"><span class="mo-body-sm">I agree to the terms and the privacy notice</span></label>`;
  return `<div class="mo-container mo-section">
  <div class="mo-narrow mo-stack mo-gap-6">
    <div class="mo-stack mo-gap-2">
      <h1 class="mo-h4">${title}</h1>
      <p class="mo-body mo-muted">It takes about a minute. ${sample}</p>
    </div>
    <form class="mo-card" action="#" method="post">
      <div class="mo-card__body mo-stack mo-gap-4">
        ${nameField}
        <div class="mo-field"><label class="mo-label" for="email">Email</label><input class="mo-input" id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com"></div>
        <div class="mo-field"><label class="mo-label" for="password">Password</label><input class="mo-input" id="password" name="password" type="password" autocomplete="${signIn ? 'current-password' : 'new-password'}"><span class="mo-help">At least 8 characters.</span></div>
        ${terms}
        <button class="mo-btn mo-btn--primary mo-btn--lg mo-btn--block" type="submit">${action}</button>
      </div>
    </form>
    <p class="mo-body-sm mo-center">${signIn ? 'New here?' : 'Already have an account?'} <a class="mo-link" href="#other">${signIn ? 'Create an account' : 'Sign in'}</a></p>
  </div>
</div>`;
}

function catalog(simple: boolean): string {
  const courses = [
    ['Fractions in the kitchen', 'Beginner', 'success', 40],
    ['Reading a bar chart', 'Beginner', 'success', 100],
    ['Number patterns', 'Level 2', 'info', 0],
    ['Writing a clear paragraph', 'Level 2', 'info', 65],
    ['The water cycle', 'Beginner', 'success', 10],
    ['Persuasive writing', 'Level 3', 'warning', 0],
  ] as const;
  const shown = simple ? courses.slice(0, 3) : courses;
  const cards = shown
    .map(
      ([name, level, tone, pct]) => `<div class="mo-card">
        <div class="mo-card__body mo-stack mo-gap-3">
          <span class="mo-badge mo-badge--${tone}">${level}</span>
          <h2 class="mo-h7">${name}</h2>
          <div class="mo-progress" role="progressbar" aria-label="${name} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="mo-progress__bar" style="width:${pct}%"></div></div>
          <p class="mo-body-sm mo-muted">${pct === 0 ? 'Not started' : pct === 100 ? 'Finished' : `${pct}% done`}</p>
        </div>
        <div class="mo-card__footer"><a class="mo-btn mo-btn--${pct === 0 ? 'primary' : 'outline'} mo-btn--sm" href="#course">${pct === 0 ? 'Start' : pct === 100 ? 'Review' : 'Continue'}</a></div>
      </div>`,
    )
    .join('\n      ');
  return `<div class="mo-container mo-section">
  <div class="mo-stack mo-gap-6">
    <div class="mo-stack mo-gap-2">
      <h1 class="mo-h4">Course catalog</h1>
      <p class="mo-body mo-muted">${sample}</p>
    </div>
    <div class="mo-field"><label class="mo-label" for="q">Search courses</label><input class="mo-input" id="q" type="search" placeholder="Try fractions"></div>
    <div class="mo-row mo-gap-2">
      <button class="mo-btn mo-btn--primary mo-btn--sm" type="button">All</button>
      <button class="mo-btn mo-btn--outline mo-btn--sm" type="button">Beginner</button>
      <button class="mo-btn mo-btn--outline mo-btn--sm" type="button">Level 2</button>
      <button class="mo-btn mo-btn--outline mo-btn--sm" type="button">Level 3</button>
    </div>
    <div class="mo-grid mo-gap-4">
      ${cards}
    </div>
  </div>
</div>`;
}

function landing(simple: boolean): string {
  const cards = [
    ['Short lessons', 'Ten minutes is enough. Pick it up and put it down.'],
    ['Clear progress', 'See what you finished and what is next, every day.'],
    ['Made for classrooms', 'Teachers can see who needs a hand without extra work.'],
  ]
    .slice(0, simple ? 2 : 3)
    .map(
      ([t, d]) => `<div class="mo-card"><div class="mo-card__body mo-stack mo-gap-2"><h2 class="mo-h7">${t}</h2><p class="mo-body mo-muted">${d}</p></div></div>`,
    )
    .join('\n      ');
  return `<section class="mo-surface-dark mo-section">
  <div class="mo-container mo-stack mo-gap-6">
    <h1 class="mo-h3">Learn a little every day</h1>
    <p class="mo-body-lg">Short lessons that fit into a busy week. ${sample}</p>
    <div class="mo-row mo-gap-3">
      <a class="mo-btn mo-btn--highlight mo-btn--xl" href="#start">Start learning</a>
      <a class="mo-btn mo-btn--info mo-btn--xl" href="#how">See how it works</a>
    </div>
  </div>
</section>
<section class="mo-container mo-section">
  <div class="mo-stack mo-gap-6">
    <h2 class="mo-h5">Why people stay</h2>
    <div class="mo-grid mo-gap-4">
      ${cards}
    </div>
    <div><a class="mo-btn mo-btn--primary mo-btn--lg" href="#start">Start learning</a></div>
  </div>
</section>`;
}

function ui(ctx: AgentContext): string {
  const arch = detectArchetype(ctx.brief);
  const flaws = flawsFor(ctx);
  const fb = (ctx.feedback ?? '').toLowerCase();
  const simple = /simpl|shorter|less|fewer|trim/.test(fb);
  const html = arch === 'dashboard' ? dashboard(flaws, simple) : arch === 'auth' ? auth(ctx.brief) : arch === 'catalog' ? catalog(simple) : landing(simple);

  const changed: string[] = [];
  if (ctx.issues?.length) {
    const rules = new Set(ctx.issues.map((i) => i.rule));
    if (rules.has('contrast')) changed.push('Swapped low contrast text to the mo-muted class, which passes.');
    if (rules.has('horizontal-overflow')) changed.push('Removed the fixed minimum width so the cards stack on a phone.');
    if (rules.has('off-palette')) changed.push('Replaced the raw hex colour with the Moon warning badge.');
    for (const r of rules) {
      if (!['contrast', 'horizontal-overflow', 'off-palette'].includes(r)) changed.push(`Addressed ${r}.`);
    }
  }
  if (ctx.feedback) changed.push(`Applied your note: "${ctx.feedback.slice(0, 120).replace(/[.!\s]+$/, '')}".`);

  const note = `## What I built
${changed.length ? changed.map((c) => `- ${c}`).join('\n') : `A ${arch === 'auth' ? 'sign up form' : arch === 'dashboard' ? 'weekly progress view' : arch === 'catalog' ? 'course catalog' : 'welcome page'} from the UX outline, one column on a phone, wider layouts from 768 px.`}

## Moon choices
- Layout with mo-container, mo-stack and mo-grid, spaced with mo-gap steps.
- Colour only through Moon classes. Secondary text uses mo-muted.
- The one main action uses the primary button.

## Risks
- Copy and numbers are sample content.
- Fonts load from Google Fonts. If they do not load, widths are measured on fallbacks.`;
  return note + '\n\n```html\n' + html + '\n```';
}


// ---------- Brand ----------

const THEMES = [
  { id: 'v1', name: 'Sunrise', theme: 'sunrise', concept: 'A warm sunrise over rolling hills in soft yellow and orange.', palette: ['mo-yellow-2', 'mo-orange-4', 'mo-red-6'], panel: 'mo-grey-1', text: 'mo-black', cta: 'primary', mood: 'Warm sunrise over gentle rolling hills, soft golden light, calm and hopeful.' },
  { id: 'v2', name: 'Forest', theme: 'forest', concept: 'Layered green hills and a pale blue sky, fresh and calm.', palette: ['mo-green-2', 'mo-green-6', 'mo-forest-6'], panel: 'mo-forest', text: 'mo-white', cta: 'highlight', mood: 'Layered green hills under a pale blue sky, fresh morning air, calm and open.' },
  { id: 'v3', name: 'Night', theme: 'night', concept: 'A deep blue evening with a glowing moon and soft purple clouds.', palette: ['mo-ocean-5', 'mo-purple-6', 'mo-blue-6'], panel: 'mo-ocean', text: 'mo-white', cta: 'highlight', mood: 'A quiet evening sky with a glowing moon and soft purple clouds, peaceful and focused.' },
  { id: 'v4', name: 'Paper', theme: 'default', concept: 'Simple paper cut shapes in blue and purple.', palette: ['mo-grey-3', 'mo-blue-3', 'mo-purple-4'], panel: 'mo-purple', text: 'mo-white', cta: 'highlight', mood: 'Layered paper cut shapes in blue and purple, simple and playful.' },
];

function quoted(brief: string): string | undefined {
  const m = /["“]([^"”]{3,40})["”]/.exec(brief);
  return m?.[1];
}

function campaignName(brief: string): string {
  const first = brief.replace(/\s+/g, ' ').trim().split(/[.!?]\s/)[0] ?? 'Campaign';
  if (first.length <= 48) return first;
  const cut = first.slice(0, 48);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 20));
}

function brandPlan(ctx: AgentContext): string {
  const b = ctx.brief;
  const asked = /\b([2-4])\s+(variations?|versions?|options?|looks?)\b/i.exec(b);
  const n = asked ? Number(asked[1]) : 3;
  const sizes = ['ig-square', 'ig-story', 'link-landscape', 'banner-wide', ...(/display|ad\b|ads\b|banner ad|300/i.test(b) || !/only|just/i.test(b) ? ['display-medium'] : [])];
  const headline = quoted(b) ?? 'Learn a little every day';
  const flagged = new Set(ctx.flaggedRules);
  const seed = ctx.seedFlaw;

  const fb = (ctx.feedback ?? '').toLowerCase();
  const calmer = /calm|quiet|less busy|simpler|fewer shapes|plain/.test(fb);
  const targets = new Set<number>();
  if (calmer) {
    if (/\b(first|v1|sunrise)\b/.test(fb)) targets.add(0);
    if (/\b(second|v2|forest)\b/.test(fb)) targets.add(1);
    if (/\b(third|v3|night)\b/.test(fb)) targets.add(2);
    if (!targets.size) THEMES.slice(0, n).forEach((_, i) => targets.add(i));
  }

  const variations = THEMES.slice(0, n).map((t, i) => ({
    id: t.id,
    name: t.name,
    theme: t.theme,
    concept: t.concept,
    image_prompt: `${t.mood}${targets.has(i) ? ' Calmer and quieter, with very few shapes and lots of open space.' : ''} Wide soft shapes, no people, no objects in the lower left.`,
    palette: t.palette,
    panel: t.panel,
    text: seed && i === 0 && !flagged.has('contrast') ? 'mo-grey-5' : t.text,
    cta_variant: t.cta,
  }));
  const overrides: Record<string, string> = seed && !flagged.has('content-cut-off') && !flagged.has('outside-safe-zone') ? { 'display-medium': 'mo-h2' } : {};

  const plan = {
    campaign: campaignName(b),
    message: { headline, subline: 'Short lessons that fit a busy week.', cta: 'Start learning' },
    variations,
    sizes,
    type_overrides: overrides,
    notes: 'Placeholder copy. Replace with the real offer before publishing.',
  };

  const changed: string[] = [];
  if (ctx.issues?.length) {
    const rules = new Set(ctx.issues.map((i) => i.rule));
    if (rules.has('contrast')) changed.push('Switched the low contrast text on the first panel to mo-black.');
    if (rules.has('content-cut-off') || rules.has('outside-safe-zone')) changed.push('Removed the oversized headline on the small display size so it fits.');
    for (const r of rules) if (!['contrast', 'content-cut-off', 'outside-safe-zone'].includes(r)) changed.push(`Addressed ${r}.`);
  }
  if (ctx.feedback) changed.push(`Applied your note: "${ctx.feedback.slice(0, 120).replace(/[.!\s]+$/, '')}". The changed artwork prompts need new images.`);

  const note = `## What I plan
${changed.length ? changed.map((c) => `- ${c}`).join('\n') : `${n} variations, each a different mood, in ${sizes.length} sizes. One image per variation per aspect ratio, cropped to each size, with all words set in Moon type on a solid panel.`}

## Notes
- Copy is placeholder until the real offer is confirmed.
- Artwork has no text in it, so the words stay sharp and checkable.`;
  return note + '\n\n```json\n' + JSON.stringify(plan, null, 2) + '\n```';
}

// ---------- Handoff ----------


interface AuditFactsLite {
  kind: 'audit';
  mode: 'page' | 'image';
  pass: boolean;
  verdict: 'pass' | 'rejected' | 'limited';
  fails: number;
  warns: number;
  waived: number;
  p1: number;
  p2: number;
  p3: number;
  conformance: { overall: number } | null;
  topRules: { rule: string; count: number; priority: number }[];
  delta: { fixed: number; new: number; unchanged: number } | null;
}

const PLAIN: Record<string, string> = {
  contrast: 'text that is too faint to read comfortably',
  'horizontal-overflow': 'content that runs off the side of a phone screen',
  'content-clipped': 'content that is cut off',
  'text-collision': 'text landing on other text',
  'missing-label': 'form fields with no label',
  'empty-control': 'buttons or links with no name',
  'zoom-blocked': 'a page that stops people zooming',
  'missing-viewport': 'a page that will not scale on phones',
  'missing-alt': 'images with no alt text',
  'hit-target': 'tap targets that are too small',
  'broken-image': 'images that do not load',
  'missing-lang': 'a page with no language set',
  'missing-title': 'a page with no title',
  'text-too-small': 'text under 12 pixels',
  'off-palette': 'colours that are not Moon colours',
  'off-grid': 'spacing that is off the 4 pixel grid',
  'off-scale-type': 'font sizes that are not on the Moon scale',
  'off-brand-font': 'fonts that are not the Moon fonts',
  'off-scale-radius': 'corner radii that are not on the Moon scale',
};

function auditHandoff(ctx: AgentContext): string {
  const f = ctx.factsData as AuditFactsLite;
  const first = f.topRules.slice(0, 3).map((t, i) => `${i + 1}. ${PLAIN[t.rule] ?? t.rule} (${t.count})`);
  const feedback = ctx.feedback ? `\n- Changed after your note: ${ctx.feedback.slice(0, 160).replace(/[.!\s]+$/, '')}.` : '';
  return `## Summary
${f.verdict === 'limited' ? 'This was only a limited check from a screenshot, so it is not a pass.' : f.pass ? 'This passed the quality checks.' : `This was rejected: ${f.fails} things must be fixed and ${f.warns} should be.`} ${f.p1} are priority one, which means they stop some people using the ${f.mode === 'page' ? 'page' : 'screen'} at all.${f.conformance ? ` Moon conformance is ${f.conformance.overall} percent.` : ''}${f.delta ? ` Since the last audit ${f.delta.fixed} were fixed and ${f.delta.new} are new.` : ''}

## What to do first
${first.length ? first.join('\n') : '- Nothing needs fixing.'}
- Work down the checklist in order. Priority one items block people, so they come before any tidying.${feedback}

## Open questions
- ${f.mode === 'image' ? 'Can you send the web address or the HTML, so contrast, overflow and tap targets can be measured instead of guessed?' : 'Are any of the findings deliberate? If so, waive them with a reason so the next audit does not repeat them.'}`;
}

interface UiFactsLite { screenName: string; components: Record<string, number>; states: string[]; unmapped: string[]; mooNotes: number }
interface BrandFactsLite { campaign: string; sizes: { id: string; label: string; channel: string; width: number; height: number }[] }

function handoff(ctx: AgentContext): string {
  if (ctx.handoffKind === 'audit') return auditHandoff(ctx);
  if (ctx.handoffKind === 'brand') {
    const f = ctx.factsData as BrandFactsLite;
    return `## Usage
${f.sizes.map((s) => `- ${s.id} (${s.width} by ${s.height}): ${s.channel}. Use as exported and do not rescale the text.`).join('\n')}

## Production notes
- Files are PNG at the exact pixel size. Name and version them as in the manifest.
- Give each image alt text from its concept line before publishing.
- The words are part of the image. For web use, repeat them as live text beside it for accessibility.
- Check each channel's current size and safe zone rules before a paid campaign.
- Artwork in this pack is ${ctx.factsData && (ctx.factsData as { provider?: string }).provider === 'mock' ? 'placeholder art from the studio, not final artwork' : 'generated, so confirm usage rights and the model terms before publishing'}.

## Open questions
- Which channels will actually run these, so unused sizes can be dropped?`;
  }
  const f = ctx.factsData as UiFactsLite;
  const comps = Object.entries(f.components).map(([k, v]) => `${k} (${v})`).join(', ');
  return `## Purpose
${f.screenName} is a single screen that gives a learner what they need at a glance and one clear next action. It is built entirely from Moon tokens and components.

## Build notes
- Moon components used: ${comps}.
- Layout is one column at 375 px and widens with the grid at 768 and 1024 px, as measured in the behaviour section of this spec.
- Buttons and links are static in this pack. Wire each one to its route or handler.
- The sample content is placeholder. Replace it with real data and handle the loading, empty and error states from the UX note.
- Keep the page inside Moon's Container so margins follow the breakpoints.
${f.mooNotes ? `- ${f.mooNotes} contrast or palette notes come from Moon's own components. They are listed in the verification report for the design system owner.` : '- No Moon component notes were raised.'}

## Open questions
${f.unmapped.length ? `- These classes had no Moon component equivalent and were written as utility classes: ${f.unmapped.join(', ')}.` : 'None.'}`;
}

export class MockLLM implements LLM {
  mode = 'mock' as const;

  async run(req: AgentRequest, _tools: ToolRunner, _budget: number): Promise<LLMResult> {
    const ctx = req.ctx;
    let text: string;
    switch (req.role) {
      case 'lead':
        text = lead(ctx);
        break;
      case 'strategist':
        text = strategist(ctx);
        break;
      case 'ux':
        text = ux(ctx);
        break;
      case 'ui':
        text = ui(ctx);
        break;
      case 'brand':
        text = brandPlan(ctx);
        break;
      case 'handoff':
        text = handoff(ctx);
        break;
      default:
        throw new Error(`The ${req.role} agent is not built yet (milestone 2).`);
    }
    return { text, usd: 0, inputTokens: 0, outputTokens: 0 };
  }
}
