# Design Studio Crew

A Telegram-controlled studio of AI design agents. You send a brief. A Studio Lead routes it, specialist agents propose each step, a Reviewer checks the work against the Moon design system in a real Chrome, and nothing moves forward until you press Approve.

It is a portfolio piece about how one UX engineer can scale design work with agents while keeping the standard: agents propose, a keeper rejects with reasons, a human approves, and every rejection and fix is logged.

## Setup

You need Node 24 or newer, an installed Google Chrome, and the Moon design system next to this folder. Moon is public and is the standard every check runs against.

```bash
git clone https://github.com/jimmypesteban/moon-design-system
(cd moon-design-system && npm install)      # Handoff uses Moon's own TypeScript, esbuild, React and Tailwind
git clone https://github.com/jimmypesteban/design-studio-crew
cd design-studio-crew && npm install        # puppeteer-core downloads no browser
npm run demo                                # no keys needed
```

If Moon or Chrome live somewhere else, set `MOON_PATH` and `CHROME_PATH` in `.env` (see below). The tests need both.

## Where it is today: milestone 3 (all three routes)

| Part | State |
|---|---|
| Studio Lead, Strategist, UX, UI agents | Built (milestone 1). |
| **Brand agent**: variations and sizes, plan approved before any image is made | **Built (milestone 2)** and tested. |
| **Handoff agent**: spec plus React code on the real Moon components | **Built (milestone 2)** and tested. |
| Reviewer: screens, brand assets and React renders | Built and tested. |
| Approval gates, rejection and fix logging, job folders, SQLite | Built and tested. |
| Cost cap per job (agents and images) and an image count cap | Built and tested. |
| Mock Telegram (terminal) | Built. This is what the demos use. |
| Real Telegram bot (grammY) | Built, tested against a fake Telegram API. **Not yet run against real Telegram.** Needs your bot token. |
| Live Anthropic agents | Built, tested against a stubbed client. **Not yet run against the real API.** Needs your key. |
| Real Gemini images | Built, tested against a stubbed fetch. **Not yet run against the real API.** Needs your key and your own price check. |
| **Audit route**: web addresses, HTML files, screenshots | **Built (milestone 3)** and tested. Measured findings with fixes, annotated screenshots, waivers, and change since the last audit. |
| Telegram photos and HTML files as audit targets | Built, tested against a fake Telegram API. Not yet run against real Telegram. |

Honest limits to know before you show this to anyone:

- In mock mode the agents are templates, not a model. They answer in the same formats as the live agents, so the pipeline, parsers, Reviewer, gates and verification are the real thing, but the words and markup come from templates (four screen types, one campaign shape). The mock artwork is placeholder art drawn in Moon colours. It is not final artwork and the manifest says so.
- The first attempt in each demo is **seeded with known flaws** so the review loop is visible. Screens: faint text, a fixed width, a raw hex colour. Brand: faint text on one panel and an oversized headline on the small ad. `npm run demo:clean` turns the seeding off for screens. The flaws are described in `src/llm/mock.ts`.
- Screens are static HTML and CSS built from Moon's real tokens (read from `moon-design-system/tokens.mjs` at run time, never copied). The class recipes in `src/moon/recipes.ts` follow the Moon component variants but are not Moon's React components. The React code comes from Handoff.
- The Reviewer reimplements the idea of Moon's sweeps (same check names) with puppeteer-core. It does not run Moon's own Playwright and Storybook scripts.
- Handoff checks that React code type checks, renders, keeps every word and holds layout at three widths. It does not prove the React version looks identical to the approved screen. The spec lists the known differences between Moon's components and the approved recipes (for example Moon's `ProgressBar` fills with `mo-blue`).
- The Gemini price is not known to me. `GEMINI_COST_PER_IMAGE_USD` defaults to `0.05` as a placeholder estimate. Check your own pricing and set it, because the plan, the cap and the cost log all use it.
- The two brand fonts (Source Sans 3 and Source Serif 4, SIL Open Font License) are bundled in `assets/fonts`, Latin subset, variable weight. Everything renders with them with no network. Text outside the Latin range falls back along Moon's font stack. If the fonts ever fail to load, a brand asset is **rejected**, not just noted.
- **Audits of screenshots are limited and say so.** Pixels can show colours, not contrast ratios, overflow, tap sizes, labels or spacing. A screenshot audit is therefore never a pass: it is either rejected (on colours, in the Moon profile) or a "limited check, not a pass". In live mode an agent also gives a visual review, labelled approximate, never a failure and never a measured number. Send a web address or the HTML for a real check.
- Audits of pages not built on Moon are held to the **quality** rules (contrast, overflow, labels, tap targets, structure, page health). Their Moon conformance is reported as a score with the nearest Moon value for each difference, and does not block. Our own screens, and anything you send back with "treat it as a Moon screen", are held to Moon strictly.
- The audit browser blocks private networks by checking the address and every request, including redirects, but it resolves names itself, so a DNS rebinding attack in the gap between the check and the load is not covered. Audit only addresses you trust the owner of, and keep `AUDIT_ALLOW_LOCALHOST` off unless you need it.
- `node:sqlite` is still marked experimental in Node 24. It needs no native build, which is why it was chosen. The one warning is silenced in `src/db.ts`.

## Try it now (no keys needed)

```bash
cd ~/2026/design-studio-crew
npm install          # already done; puppeteer-core downloads no browser
npm run demo         # a screen, then the Handoff pack
npm run demo:brand   # campaign assets, then the asset spec
npm run demo:audit   # a messy sample page: measured, annotated, waivers, fix list
npm run demo -- --audit --image   # a phone screenshot of it: pixels only
```

**Screen demo** (about 10 seconds):

1. You send a brief. The Lead proposes a route. You approve.
2. Strategist and UX each propose a note. You approve both.
3. UI builds attempt 1. The Reviewer rejects it with measured problems. UI fixes them.
4. You send the passing screen back ("make it simpler"). UI builds attempt 3. You approve.
5. The studio offers the Handoff pack. You say yes. It converts the screen to Moon React code, type checks it, renders it with Moon's own Tailwind build, compares the words, runs the Reviewer on the render, and shows you the spec. You approve.

**Brand demo** (about 15 seconds):

1. Lead and Strategist as above. You approve.
2. Brand proposes a plan: 3 variations, 5 sizes, 12 images, estimated cost. **Nothing is generated yet.** You approve the plan.
3. 12 images are made. All 15 assets are composed and the Reviewer rejects 7 of them (faint text, a headline running 108px off the top of the small ad). Brand fixes the layout. No new images are made, because layout does not change the artwork.
4. You send the sheet back: "Make the second variation calmer and less busy." Brand changes that one prompt. Only the 4 changed images are new, so the plan gate asks you again for exactly those. You approve.
5. All 15 pass. You approve. The studio offers the asset spec. You approve it.

**Audit demo** (about 3 seconds):

1. You send "Audit this page against the standard: samples/messy-dashboard.html". The Lead routes it: Reviewer, then Handoff.
2. The Reviewer proposes the audit **plan before anything is opened**: the target, which standard applies, and what it will and will not do (read only, no clicking, typing, signing in or downloading). You approve.
3. Chrome opens the page at 375, 768 and 1024 px and measures it. The Reviewer rejects it: 13 to fix, 25 to note. Contrast with the nearest Moon colour that passes, content running off a phone, a field with no label, blocked zoom, a broken image, and more.
4. Handoff writes the fix list in priority order. You are shown the page with the problems boxed and numbered, the report and the checklist.
5. You waive two findings with a reason. Both are logged as overrides and remembered for this target. You approve.
6. Run it again and the report says what is waived and what is unchanged. Fix the page and run it again and it says what was fixed.

Other ways to run it:

```bash
npm run demo -- --interactive    # press the buttons yourself, by number
npm run demo -- --quick          # approve everything, no human rejection
npm run demo -- --no-handoff     # skip the Handoff offer
npm run demo:clean               # screens built right first time
npm run demo -- --brief "A log in screen for returning learners"
npm run log                      # list jobs
npm run log <job-id>             # every approval, rejection and fix for one job
npm test                         # 93 tests, about 3 minutes
npm run typecheck
```

## The project page

`docs/index.html` is a static project page designed like a creative studio's site. It has a poster hero where each of the three lines has its own living shape; a pinned scroll story that follows one real job from the brief to the approval, with a typed brief, the Reviewer scanning a real screenshot, a REJECTED stamp, the fix and a PASSED stamp; tilting work cards with real outputs; a contrast toy you slide that uses the Reviewer's own maths; the Reviewer scanning a real audited page with clickable pins; an editorial roster for the crew; and bundled brand fonts. Every image is a real output of the studio. Motion respects `prefers-reduced-motion`, and without JavaScript the story and the roster fall back to plain readable sections.

It is built from `docs/src/page.template` plus the live Moon tokens and the bundled fonts (copied to `docs/fonts`), so rebuild it with `npm run docs` after editing the source. The template is deliberately not an `.html` file: it has placeholders for the tokens and fonts, so opened directly it shows no colours. Always open `docs/index.html`. It loads nothing from the network. Open it in a browser, or publish the `docs/` folder anywhere that serves static files (GitHub Pages works).

It is held to the studio's own standard. Tests check that it is up to date, loads nothing from the network, leaks no local paths, has every image at the right size, keeps the audit pins apart, and passes the audit under the strict Moon standard with one documented exception: giant display type of 96px and up, which is the page's art direction and is deliberately off Moon's type scale. Every other size must be on the scale.

Two changes to the audit itself came out of building it. Decorative content marked `aria-hidden` (a marquee, a shape) is no longer reported as clipped, because it cannot hide anything from anyone. And the page audit now waits for animations to settle before measuring, so it never reads a page mid-transition.

## What a job leaves behind

```
out/job-<date>-<time>-<brief words>-<id>/
  brief.md
  notes/                     each agent's note per step (revisions kept as .v2.md, .v3.md)
  attempts/                  every try, with the Reviewer's reasons for it
    ui-1.html  review-1.md        (screens)
    brand-plan-1.json  brand-review-1.md  assets-1/<size>/<variation>.png  images/   (brand)
    handoff-0/ ...                the React project that was type checked and rendered
  final/
    screen.html  moon.css  review.md  contrast-table.md  shots/        (screens)
    assets/<size>/<variation>.png  contact-sheet.png  manifest.json
      plan.json  review.md  source-images/                              (brand)
    handoff/
      spec.md  Screen.tsx  verify.md  react-render.html  shots/        (screen handoff)
      asset-spec.md                                                    (brand handoff)
  telegram-transcript.md     the mock chat, as it would look in Telegram
  log.md                     every approval, rejection and fix, in order
  job.json
```

The same events live in `data/studio.db` (tables `jobs`, `steps`, `events`, `memory`).

## How agents and approvals work

```
screen:  brief -> Lead -> Strategist -> UX -> UI <-> Reviewer -> you approve -> [Handoff pack]
brand:   brief -> Lead -> Strategist -> Brand plan -> you approve -> images -> compose <-> Reviewer
                                                                                     -> you approve -> [asset spec]
```

- Agents **propose**. Every step ends in inline buttons: Approve, Send back with a reason, Stop.
- Each role lives in `agents/<role>/` with `prompt.md` (its job and output format), `tools.json` (the tools it may use) and `notes.md` (standing notes you can edit, added to the prompt on every run).
- The Reviewer is code, not opinion. When it rejects, the agent gets the measured reasons and fixes them, up to three times, before you see the work.
- If the agent cannot satisfy the Reviewer, you see the failing report and can still choose **Approve anyway**. That needs a written reason and is logged as an `override`.
- Lessons from every rejection are written to the `memory` table and added to that agent's prompt on the next job.
- Everything the studio writes passes through a filter that removes em dashes, en dashes and any secret value.

## Audit

Send a web address, a screenshot, an HTML file, or the id of a job whose screen you want re-checked.

- **Plan first.** Nothing is opened until you approve the plan. Then the page is loaded once in a clean browser, scrolled to load lazy content, and measured. Never clicked, never typed into, never signed in, never downloaded from.
- **What it measures on a page:** everything the screen checks do (contrast, overflow, collisions, tap targets, labels, alt text, language) plus viewport and zoom, page title, heading order, vague link text, tiny text, long lines, autocomplete, broken images, console errors and failed requests.
- **Findings** are prioritised (1 fix first, 2 fix soon, 3 tidy up), grouped so repeats are one finding with a list, and each one has a plain fix. Contrast fixes name the nearest Moon colour that actually passes on the measured background. Moon differences name the nearest Moon token, type size, radius or grid step.
- **Annotated screenshots** box and number the priority 1 and 2 findings at each width, so the report points at the page.
- **Waive a finding** with a reason when it is deliberate. It is logged as an override, remembered for that target and not repeated.
- **Since the last audit.** Each audit of the same target is compared with the last: fixed, new, unchanged.
- **The fix list** is a checklist in priority order, with a colour map from the page's colours to Moon tokens. The agent that writes its opening is shown counts and rule names only, never text from the audited page.
- **Safe by default.** Only http and https. No username or password in an address. Private, link-local, metadata and carrier addresses are refused, and every request the page makes is checked the same way, including redirects. Localhost is refused unless `AUDIT_ALLOW_LOCALHOST=1`. Local files only from `out/`, `samples/` and `AUDIT_FILE_ROOTS`, with symlinks resolved. Downloads are denied. Pages are capped at 6000 elements and screenshots at 8000 px tall.
- **Telegram:** send a photo (a screenshot) or an HTML file, with or without a caption. Files over 10 MB, and anything that is not a PNG, JPEG, WebP or HTML file, are refused. A file is not taken while a question is waiting for your answer.

## Brand

Gemini draws the artwork only, and never any text. The studio sets every word itself, in Moon type, on a solid Moon colour panel placed over the artwork, then renders each asset in Chrome at its exact pixel size. That is what lets the Reviewer measure contrast and safe zones on every asset.

- **Plan first.** The agent proposes a plan (campaign, words, variations with an image prompt and Moon colours each, sizes). You see the exact number of images and the estimated cost, and nothing is generated until you approve.
- **One image per variation per aspect ratio.** Sizes that share a ratio share the image and Chrome crops it.
- **Fixes that cost nothing stay free.** Images are cached by variation, ratio and prompt. A layout or colour fix reuses them. Changing a prompt creates a new key, so only those images are made, and you are asked first.
- **Caps.** `BRAND_MAX_IMAGES` (default 12) is checked when the plan is validated. The cost cap (`STUDIO_MAX_USD`) is checked before generating, and asks you whether to add $1 or stop.
- **Server side only.** `src/brand/gemini.ts` follows the Darkroom pattern: the key comes from `GEMINI_API_KEY`, travels in the `x-goog-api-key` header and never in a URL, every call has a timeout, errors are sorted into plain kinds (billing, auth, filtered, rate limited, timeout, network, upstream, config), and the key is removed from any error text. Transient errors retry once. Billing, key and config errors stop the job in plain words. A filtered prompt goes back to the agent to reword, and you approve the new images.
- **Sizes**: square post 1080 by 1080, story 1080 by 1920, link preview 1200 by 628, wide banner 1500 by 500, medium ad 300 by 250. Channel rules change, so check them before a paid campaign.

### The asset checks

Run on every asset at its exact size: contrast of the text over its panel, nothing past any edge, text inside the platform safe zone (the story keeps 250px clear top and bottom), text at least 2 percent of the short side so it reads at feed size, colours and type only from Moon, only Moon asset classes, the PNG is exactly the right size. Artwork far from the Moon palette earns a note, not a block.

## Handoff

For a screen, the code is **generated** from the approved HTML by a converter that maps Moon recipes to the real Moon components (`Button`, `Card`, `Input`, `Checkbox`, `Badge`, `Alert`, `ProgressBar`, `Avatar`, `Container`) and everything else to Moon's own Tailwind utilities. The Handoff agent writes the spec around it and may propose changed code, but any code it proposes has to pass the same verification, and if it keeps failing the verified converter code is kept.

Verification, all real, all using your Moon repo:

1. **Type check** against Moon's real components with Moon's own TypeScript.
2. **Server render** with `react-dom`, bundled with Moon's esbuild.
3. **Words**: every word of the approved screen must be in the output.
4. **Render and review**: Moon's own Tailwind setup is compiled for exactly the classes used, the page is rendered in Chrome and the Reviewer runs at 375, 768 and 1024 px. Layout and structure problems block. Colour, contrast and type findings inside Moon's own components are reported as notes for the design system owner, because the code is required to use those components.

For brand assets the Handoff pack is an asset spec: sizes, safe zones, files (each re-checked for exact size), variation names, suggested alt text, naming, and a source and rights note.

The spec is assembled by code from measured facts (tokens used, components, grid columns per width, states from the UX note, differences, verification results) with the agent's written Purpose, Build notes and Open questions.

## The Reviewer's checks for screens

All of these run on the rendered page in your installed Chrome, at 375, 768 and 1024 px:

| Rule | What it measures |
|---|---|
| `contrast` | WCAG AA ratio for every piece of text: 4.5:1, or 3:1 for large text. Alpha is composited over the real background. Text on images is reported as unverified, not passed. |
| `horizontal-overflow` | Anything past the screen edge, even if the page hides it with `overflow-x: hidden`. |
| `content-clipped` | Content cut off by `overflow: hidden`, or text spilling out of its box. |
| `text-collision` | Text landing on other text. |
| `hit-target` | Tap targets under 24 px. |
| `off-palette` | Any colour that is not a Moon token. |
| `off-scale-type`, `off-brand-font` | Font sizes and families outside Moon's. |
| `off-scale-radius` | Corner radius outside 12, 16, 24 or full. |
| `off-grid` | Padding, margin or gap that is not on the 4px grid (Tailwind half steps allowed). |
| `unknown-class` | Any class that is not a Moon recipe. |
| `missing-alt`, `missing-label`, `empty-control`, `missing-lang`, `h1-count` | Basic accessibility. |

The check is checked: there is a known-answer test (black on white is 21:1), a golden page that uses every passing recipe and must pass at all three widths, and the golden asset set must pass at all five sizes.

Real findings from running it:

- Moon's `secondary` button (white on `mo-blue`) measures 2.91:1 and `tertiary` (white on `mo-grey-7`) measures 3.95:1. Both fail AA for 14px button text.
- It caught a defect in this project's own checkbox recipe (the browser's default 3px margin broke the 4px grid).
- It caught two bugs in its own new checks while building milestone 2: a vertical overflow rule that flagged every tight headline, and a JSX escaping bug in the converter. Both are fixed and have tests.

## Live agents, images and cost

Both are opt in, and separately:

```bash
STUDIO_LLM=live npm run demo          # real Claude agents
STUDIO_IMAGES=live npm run demo:brand # real Gemini images
```

- Agents: `claude-sonnet-5-5` for every agent (`STUDIO_MODEL` to change), effort `medium`, key from `ANTHROPIC_API_KEY` only. Cost is counted from real token usage after every call.
- Images: model `gemini-3.1-flash-image` (`GEMINI_IMAGE_MODEL` to change), key from `GEMINI_API_KEY` only, cost counted per image at `GEMINI_COST_PER_IMAGE_USD`.
- `STUDIO_MAX_USD` (default `1`) caps agents and images together per job. At the cap the job asks in Telegram: add $1 and continue, or stop.
- A key on its own never starts spending. If a key is set but the mode is not `live`, the demo says so and uses the free mock.

## What you must do by hand

I cannot and should not do these for you. Never paste a key or token into a chat, a commit or an issue. They only ever go in `.env`.

### 1. Create `.env`

```bash
cd ~/2026/design-studio-crew
cp .env.example .env
```

Open `.env` in your editor. It is git-ignored. A test fails if any source file contains something shaped like a key or token, or if a value in `.env.example` is filled in. Keep `.env.example` empty.

### 2. Make the Telegram bot (BotFather)

1. In Telegram, search for **@BotFather**. Check it has the blue verified tick.
2. Send `/newbot`.
3. Give it a display name, for example `Jimmy Design Studio`.
4. Give it a username ending in `bot`, for example `jimmy_design_studio_bot`. It must be unique.
5. BotFather replies with a token. Copy it into `.env` as `TELEGRAM_BOT_TOKEN=...`
6. Optional but sensible: send BotFather `/setprivacy`, pick your bot, choose **Enable**. Send `/setjoingroups`, pick your bot, choose **Disable**. The studio is for you alone.

### 3. Lock the bot to you

1. Run `npm run studio` once. With no owner set it starts in setup mode.
2. Open your bot in Telegram, press Start, and send any message.
3. It replies with your numeric Telegram user id.
4. Put that in `.env` as `TELEGRAM_OWNER_ID=...`, press Ctrl+C, and run `npm run studio` again.

From then on the bot ignores everyone except that id, for messages and for button presses. This is tested.

### 4. Anthropic key (only for live agents)

1. Open console.anthropic.com, go to API keys, create a key.
2. In the console, set a monthly spend limit before you use it.
3. Put it in `.env` as `ANTHROPIC_API_KEY=...` and set `STUDIO_LLM=live`.

### 5a. Audit settings (optional)

- To audit a dev server on your own machine, set `AUDIT_ALLOW_LOCALHOST=1` in `.env`. It is off by default.
- To audit local files outside `out/` and `samples/`, list their folders in `AUDIT_FILE_ROOTS`, comma separated.

### 5. Gemini key (only for real brand images)

1. Open aistudio.google.com, create an API key. Image models can need billing enabled on the project. If the studio reports a billing error, that is why.
2. Put it in `.env` as `GEMINI_API_KEY=...` and set `STUDIO_IMAGES=live`.
3. **Look up what one image costs on your account** and put it in `.env` as `GEMINI_COST_PER_IMAGE_USD=...`. The default is a placeholder.
4. Keep `BRAND_MAX_IMAGES` as low as the work needs. The plan always shows the exact count before anything is generated.
5. Set a spend limit on the Google side too. The studio's cap is a second line of defence, not the first.

Generated images may have usage terms. The manifest reminds you to confirm them before publishing.

### 6. Check your paths

The defaults match this machine. Change them in `.env` only if they differ:

- `MOON_PATH=~/2026/moon-design-system` (Moon's own `npm install` must have been run, because Handoff uses its TypeScript, esbuild, React and Tailwind)
- `CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

You need Node 24 or newer (you have v24.9.0).

### 7. First real run

```bash
npm run studio
```

Then message the bot a brief, for example: "A sign up screen for a student learning app. Friendly and simple." or "Autumn campaign, 3 variations of a social post, headline 'Learn a little every day'." The bot proposes a route and waits for you. Real Telegram has not been exercised yet, so expect to tell me about anything odd on the first run.

## Project layout

```
agents/<role>/prompt.md, tools.json, notes.md   one folder per agent (all seven are wired, all three routes work)
src/job.ts               the shared kit: output folder, cost cap, agent calls, approval gate
src/pipeline.ts          the job runner and routing
src/ui-step.ts           UI agent with the Reviewer loop
src/brand/               plan, Gemini client, image providers, composer, Brand step
src/audit/               target and safety, page audit, screenshot audit, findings, report, Audit step
samples/                 a deliberately messy page for the audit demo
src/handoff/             converter, verification, spec, Handoff step
src/reviewer/            checks that run in Chrome (analyze.browser.js runs in the page)
src/moon/                token loader, CSS, component and asset recipes, contrast math
src/llm/                 mock (templates) and anthropic (live, tool loop, cost)
src/channel/             Channel interface, mock Telegram, grammY Telegram
src/db.ts                SQLite jobs, steps, events, memory
src/docs.ts              builds the project page from its source, the Moon tokens and the fonts
assets/fonts/            the two bundled brand fonts and their licences
docs/                    the static project page (src/, img/, fonts/)
test/                    93 tests
```

## Next

- First real run against real Telegram, real Claude and real Gemini, with your keys. The live vision review for screenshots is the least exercised path, so try it on a real screenshot first.
- Ideas, not started: audit several pages in one job, a Figma frame as an audit target, scheduled re-audits that message you only when something regresses.
