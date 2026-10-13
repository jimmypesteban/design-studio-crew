import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.ts';
import { copyDocFonts, renderDocs } from '../src/docs.ts';
import { loadMoonTokens } from '../src/moon/tokens.ts';

const cfg = loadConfig();
const tokens = await loadMoonTokens(cfg.moonPath);
fs.writeFileSync(path.join(ROOT, 'docs', 'index.html'), renderDocs(tokens));
copyDocFonts();
console.log('Wrote docs/index.html and docs/fonts');
