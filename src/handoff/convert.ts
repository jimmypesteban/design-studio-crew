import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type El = DefaultTreeAdapterMap['element'];
type Txt = DefaultTreeAdapterMap['textNode'];

export interface ConvertResult {
  componentName: string;
  tsx: string;
  /** Moon components used, with counts. */
  components: Record<string, number>;
  /** Classes with no Moon component or utility equivalent. */
  unmapped: string[];
  /** Places where the Moon component differs from the approved screen. */
  differences: string[];
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
const BLOCKISH = new Set(['div', 'section', 'ul', 'ol', 'li', 'form', 'main', 'header', 'footer', 'nav', 'article', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Recipe class to Tailwind utilities, using Moon's own tokens (bg-mo-*, text-mo-*, rounded-mo-*). */
const TW: Record<string, string> = {
  'mo-section': 'py-12',
  'mo-narrow': 'mx-auto w-full max-w-120',
  'mo-stack': 'flex flex-col',
  'mo-row': 'flex flex-wrap items-center',
  'mo-between': 'justify-between',
  'mo-center': 'items-center text-center',
  'mo-grow': 'min-w-0 flex-1',
  'mo-grid': 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))]',
  'mo-grid--2': 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))]',
  'mo-h1': 'font-heading text-mo-h1 font-bold',
  'mo-h2': 'font-heading text-mo-h2 font-bold',
  'mo-h3': 'font-heading text-mo-h3 font-bold',
  'mo-h4': 'font-heading text-mo-h4 font-bold',
  'mo-h5': 'font-heading text-mo-h5 font-bold',
  'mo-h6': 'font-heading text-mo-h6 font-bold',
  'mo-h7': 'font-heading text-mo-h7 font-bold',
  'mo-body-lg': 'text-mo-body-lg',
  'mo-body': 'text-mo-body',
  'mo-body-sm': 'text-mo-body-sm',
  'mo-subhead': 'text-mo-subhead font-semibold',
  'mo-annotation': 'text-mo-annotation',
  'mo-muted': 'text-mo-grey-8',
  'mo-on-dark': 'text-mo-white',
  'mo-text-error': 'text-mo-red-8',
  'mo-bold': 'font-bold',
  'mo-surface-dark': 'bg-mo-ocean text-mo-white',
  'mo-surface-brand': 'bg-mo-forest text-mo-white',
  'mo-surface-white': 'bg-mo-grey-1 text-mo-black',
  'mo-link': 'font-medium text-mo-red-7 underline',
  'mo-stat': 'flex flex-col items-start gap-1',
  'mo-stat__value': 'font-heading text-mo-h5 font-bold',
  'mo-list': 'm-0 flex list-none flex-col p-0',
  'mo-list__item': 'flex items-center gap-3 border-b border-mo-grey-3 py-3',
  'mo-divider': 'm-0 h-px border-0 bg-mo-grey-3',
  'mo-skip': 'sr-only focus:not-sr-only',
};

function twFor(classes: string[]): { tw: string[]; unmapped: string[] } {
  const tw: string[] = [];
  const unmapped: string[] = [];
  const has = new Set(classes);
  for (const c of classes) {
    let m: RegExpExecArray | null;
    if (c === 'mo-grid' && has.has('mo-grid--2')) continue; // the wider variant replaces the base
    if (TW[c]) tw.push(TW[c]);
    else if ((m = /^mo-gap-(\d+)$/.exec(c))) tw.push(`gap-${m[1]}`);
    else if ((m = /^mo-pad-(\d+)$/.exec(c))) tw.push(`p-${m[1]}`);
    else if ((m = /^mo-mt-(\d+)$/.exec(c))) tw.push(`mt-${m[1]}`);
    else unmapped.push(c);
  }
  return { tw: tw.join(' ').split(' ').filter(Boolean), unmapped };
}

const ATTR: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  autocomplete: 'autoComplete',
  maxlength: 'maxLength',
  minlength: 'minLength',
  readonly: 'readOnly',
  novalidate: 'noValidate',
  crossorigin: 'crossOrigin',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  enctype: 'encType',
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '{': '{"{"}', '}': '{"}"}' };
/** One pass, so the braces we add are never escaped again. */
const escText = (s: string) => s.replace(/[&<>{}]/g, (c) => ESC[c]!);
const jsStr = (s: string) => JSON.stringify(s);
const attrStr = (name: string, value: string) => (/["{}\\<>&\n]/.test(value) ? `${name}={${jsStr(value)}}` : `${name}="${value}"`);

const isEl = (n: Node): n is El => 'tagName' in n;
const isText = (n: Node): n is Txt => n.nodeName === '#text';
const attrOf = (el: El, name: string) => el.attrs.find((a) => a.name === name)?.value;
const classesOf = (el: El) => (attrOf(el, 'class') ?? '').split(/\s+/).filter(Boolean);
const elems = (el: El) => el.childNodes.filter(isEl);
const textOf = (n: Node): string =>
  isText(n) ? n.value : 'childNodes' in n ? (n.childNodes as Node[]).map(textOf).join('') : '';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function styleObject(css: string): string {
  const parts = css.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(':');
    const k = p.slice(0, i).trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return `${k}: ${jsStr(p.slice(i + 1).trim())}`;
  });
  return `{{ ${parts.join(', ')} }}`;
}

export function pascal(name: string): string {
  const w = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const out = w.map((x) => x[0]!.toUpperCase() + x.slice(1)).join('');
  return /^[A-Za-z]/.test(out) ? out : 'Screen';
}

export function convertToReact(fragmentHtml: string, screenName: string): ConvertResult {
  const root = parseFragment(fragmentHtml);
  const components: Record<string, number> = {};
  const unmapped = new Set<string>();
  const differences = new Set<string>();
  const use = (name: string) => (components[name] = (components[name] ?? 0) + 1);

  const generic = (el: El, ind: string, extraClass: string[] = [], skipAttrs: string[] = []): string => {
    const classes = classesOf(el).filter((c) => !c.startsWith('mo-card__'));
    const { tw, unmapped: un } = twFor(classes);
    un.forEach((c) => unmapped.add(c));
    const className = [...tw, ...extraClass].join(' ');
    let attrs = className ? ` ${attrStr('className', className)}` : '';
    attrs += otherAttrs(el, skipAttrs);
    return wrap(el.tagName, attrs, el.childNodes, ind);
  };

  const otherAttrs = (el: El, skip: string[] = []): string => {
    let out = '';
    for (const a of el.attrs) {
      if (a.name === 'class' || skip.includes(a.name)) continue;
      if (a.name === 'style') {
        out += ` style=${styleObject(a.value)}`;
        differences.add('Inline styles were kept as React style objects. Prefer a Tailwind class when you build it for real.');
        continue;
      }
      if (a.name === 'checked') {
        out += ' defaultChecked';
        continue;
      }
      if (a.name === 'value' && el.tagName === 'input') {
        out += ` ${attrStr('defaultValue', a.value)}`;
        continue;
      }
      const name = ATTR[a.name] ?? a.name;
      out += a.value === '' && !name.startsWith('aria-') && a.name !== 'alt' ? ` ${name}` : ` ${attrStr(name, a.value)}`;
    }
    return out;
  };

  const isMixed = (kids: Node[]) => kids.some((k) => isText(k) && norm(k.value)) && kids.some(isEl);

  /** Children as a block of lines or one inline string. */
  const body = (kids: Node[], ind: string): { inline: boolean; text: string } => {
    const live = kids.filter((k) => !(isText(k) && !norm(k.value)) && k.nodeName !== '#comment');
    if (!live.length) return { inline: true, text: '' };
    if (isMixed(kids)) {
      const text = kids
        .filter((k) => k.nodeName !== '#comment')
        .map((k) => (isText(k) ? escText(k.value.replace(/\s+/g, ' ')) : node(k, '').trim()))
        .join('')
        .trim();
      return { inline: true, text };
    }
    if (live.length === 1 && isText(live[0]!)) return { inline: true, text: escText(norm(live[0]!.value)) };
    const lines = live.map((k) => (isText(k) ? `${ind}  ${escText(norm(k.value))}` : node(k, `${ind}  `)));
    return { inline: false, text: lines.join('\n') };
  };

  const wrap = (tag: string, attrs: string, kids: Node[], ind: string): string => {
    if (VOID.has(tag)) return `${ind}<${tag}${attrs} />`;
    const b = body(kids, ind);
    if (!b.text) return `${ind}<${tag}${attrs} />`;
    if (b.inline && !BLOCKISH.has(tag) && !/\n/.test(b.text)) return `${ind}<${tag}${attrs}>${b.text}</${tag}>`;
    if (b.inline && b.text.length <= 90 && !/\n/.test(b.text)) return `${ind}<${tag}${attrs}>${b.text}</${tag}>`;
    if (b.inline) return `${ind}<${tag}${attrs}>\n${ind}  ${b.text}\n${ind}</${tag}>`;
    return `${ind}<${tag}${attrs}>\n${b.text}\n${ind}</${tag}>`;
  };

  const component = (name: string, props: string, kids: Node[] | string[], ind: string): string => {
    use(name);
    const p = props ? ` ${props.trim()}` : '';
    if (typeof kids[0] === 'string') {
      const lines = (kids as string[]).filter(Boolean);
      return lines.length ? `${ind}<${name}${p}>\n${lines.join('\n')}\n${ind}</${name}>` : `${ind}<${name}${p} />`;
    }
    const b = body(kids as Node[], ind);
    if (!b.text) return `${ind}<${name}${p} />`;
    if (b.inline && !/\n/.test(b.text) && b.text.length <= 70) return `${ind}<${name}${p}>${b.text}</${name}>`;
    if (b.inline) return `${ind}<${name}${p}>\n${ind}  ${b.text}\n${ind}</${name}>`;
    return `${ind}<${name}${p}>\n${b.text}\n${ind}</${name}>`;
  };

  // ---- component conversions ----

  const button = (el: El, ind: string): string => {
    const c = classesOf(el);
    const variant = c.find((x) => /^mo-btn--(primary|highlight|secondary|tertiary|danger|ghost|link|outline|soft|info|accent)$/.test(x))?.replace('mo-btn--', '') ?? 'primary';
    const size = c.find((x) => /^mo-btn--(xs|sm|lg|xl)$/.test(x))?.replace('mo-btn--', '');
    const props = [`variant="${variant}"`, size ? `size="${size}"` : '', c.includes('mo-btn--pill') ? 'shape="pill"' : '', c.includes('mo-btn--block') ? 'fullWidth' : ''].filter(Boolean);
    differences.add("Button sizes follow Moon's own padding scale, so heights can differ by a few pixels from the approved screen.");
    if (el.tagName === 'a') {
      const inner = wrap('a', otherAttrs(el), el.childNodes, `${ind}  `);
      return component('Button', ['asChild', ...props].join(' '), [inner], ind);
    }
    const attrs = otherAttrs(el);
    return component('Button', `${props.join(' ')}${attrs}`, el.childNodes, ind);
  };

  const card = (el: El, ind: string): string => {
    const c = classesOf(el);
    const header = elems(el).find((k) => classesOf(k).includes('mo-card__header'));
    const bodyEl = elems(el).find((k) => classesOf(k).includes('mo-card__body'));
    const footer = elems(el).find((k) => classesOf(k).includes('mo-card__footer'));
    const props: string[] = [];
    if (c.includes('mo-card--student')) props.push('audience="student"');
    const extra = c.filter((x) => !x.startsWith('mo-card'));
    const { tw, unmapped: un } = twFor(extra);
    un.forEach((x) => unmapped.add(x));
    if (tw.length) props.push(attrStr('className', tw.join(' ')));

    let kids: string[] = [];
    if (header) {
      const hs = elems(header);
      if (hs.length === 1 && /^h[1-6]$/.test(hs[0]!.tagName) && !elems(hs[0]!).length) {
        props.push(attrStr('title', norm(textOf(hs[0]!))));
        if (hs[0]!.tagName !== 'h3') differences.add(`Card renders its title as an h3. The approved screen used ${hs[0]!.tagName}, so check the heading order when you build it.`);
      } else {
        kids.push(wrap('div', '', header.childNodes, `${ind}  `));
        unmapped.add('mo-card__header with more than a heading');
      }
    }
    if (footer) {
      const inner = body(footer.childNodes, `${ind}    `);
      props.push(`footer={<>${inner.inline ? inner.text : `\n${inner.text}\n${ind}  `}</>}`);
    }
    if (bodyEl) {
      const bc = classesOf(bodyEl).filter((x) => x !== 'mo-card__body');
      if (bc.length) kids.push(generic(bodyEl, `${ind}  `)); // a utility wrapper keeps the body layout
      else kids.push(...body(bodyEl.childNodes, `${ind}`).text.split('\n').filter((l) => l.trim().length));
    } else if (!header) {
      kids = body(el.childNodes, ind).text.split('\n').filter((l) => l.trim().length);
    }
    differences.add("Card draws its own border and white background, and pads its body at px-5 py-4.");
    if (el.tagName === 'form') {
      const attrs = otherAttrs(el);
      const inner = component('Card', props.join(' '), kids.length ? kids : [`${ind}    `], `${ind}  `);
      return `${ind}<form${attrs}>\n${inner}\n${ind}</form>`;
    }
    return component('Card', props.join(' '), kids.length ? kids : [], ind);
  };

  const field = (el: El, ind: string): string | null => {
    const kids = elems(el);
    const label = kids.find((k) => k.tagName === 'label' && classesOf(k).includes('mo-label'));
    const input = kids.find((k) => k.tagName === 'input' && classesOf(k).includes('mo-input'));
    if (!label || !input || kids.some((k) => k.tagName === 'select' || k.tagName === 'textarea')) return null;
    const help = kids.find((k) => classesOf(k).includes('mo-help'));
    const err = kids.find((k) => classesOf(k).includes('mo-error'));
    const props: string[] = [attrStr('label', norm(textOf(label)))];
    if (help) props.push(attrStr('helperText', norm(textOf(help))));
    if (err) props.push(attrStr('error', norm(textOf(err))));
    for (const a of input.attrs) {
      if (a.name === 'class') continue;
      const name = ATTR[a.name] ?? a.name;
      props.push(a.value === '' ? name : attrStr(name, a.value));
    }
    return `${ind}${(() => { use('Input'); return `<Input ${props.join(' ')} />`; })()}`;
  };

  const check = (el: El, ind: string): string | null => {
    const input = elems(el).find((k) => k.tagName === 'input' && attrOf(k, 'type') === 'checkbox');
    const span = elems(el).find((k) => k.tagName === 'span');
    if (!input || !span) return null;
    const props: string[] = [];
    for (const a of input.attrs) {
      if (a.name === 'class' || a.name === 'type') continue;
      props.push(a.value === '' ? ATTR[a.name] ?? a.name : attrStr(ATTR[a.name] ?? a.name, a.value));
    }
    const hasInline = elems(span).length > 0;
    if (hasInline) {
      const inner = body(span.childNodes, '').text;
      props.push(`label={<>${inner}</>}`);
    } else props.push(attrStr('label', norm(textOf(span))));
    use('Checkbox');
    return `${ind}<Checkbox ${props.join(' ')} />`;
  };

  const progress = (el: El, ind: string): string => {
    const bar = elems(el).find((k) => classesOf(k).includes('mo-progress__bar'));
    const now = Number(attrOf(el, 'aria-valuenow') ?? /width:\s*(\d+)/.exec(attrOf(bar ?? el, 'style') ?? '')?.[1] ?? 0);
    differences.add('ProgressBar fills with mo-blue and has no aria-label prop. The approved screen used a mo-forest fill and labelled each bar.');
    use('ProgressBar');
    return `${ind}<ProgressBar value={${Number.isFinite(now) ? now : 0}} />`;
  };

  const badge = (el: El, ind: string): string => {
    const tone = classesOf(el).find((x) => x.startsWith('mo-badge--'))?.replace('mo-badge--', '') ?? 'neutral';
    const variant = tone === 'neutral' ? '' : `variant="${tone}" `;
    differences.add('Badge uses a 10 percent tint of its colour as the background, which is lighter than the approved screen.');
    return component('Badge', `${variant}size="sm"`, el.childNodes, ind);
  };

  const alert = (el: El, ind: string): string => {
    const tone = classesOf(el).find((x) => x.startsWith('mo-alert--'))?.replace('mo-alert--', '') ?? 'info';
    differences.add('Alert adds an icon and uses role="alert". The approved screen used role="status" and no icon.');
    const inner = elems(el).length === 1 && elems(el)[0]!.tagName === 'span' ? elems(el)[0]!.childNodes : el.childNodes;
    return component('Alert', `variant="${tone}"`, inner, ind);
  };

  const avatar = (el: El, ind: string): string => {
    differences.add('Avatar uses its own default fill. The approved screen used a soft purple fill and marked the avatar as decorative with aria-hidden, which the Avatar component does not take as a prop, so decide how it should be announced.');
    use('Avatar');
    return `${ind}<Avatar initials=${jsStr(norm(textOf(el)))} />`;
  };

  function node(n: Node, ind: string): string {
    if (isText(n)) return `${ind}${escText(norm(n.value))}`;
    if (!isEl(n)) return '';
    const c = classesOf(n);
    if (c.includes('mo-btn')) return button(n, ind);
    if (c.includes('mo-card')) return card(n, ind);
    if (c.includes('mo-badge')) return badge(n, ind);
    if (c.includes('mo-alert')) return alert(n, ind);
    if (c.includes('mo-progress')) return progress(n, ind);
    if (c.includes('mo-avatar')) return avatar(n, ind);
    if (c.includes('mo-field')) {
      const f = field(n, ind);
      if (f) return f;
      unmapped.add('mo-field without a plain text input');
    }
    if (c.includes('mo-check')) {
      const k = check(n, ind);
      if (k) return k;
    }
    if (c.includes('mo-container')) {
      const extra = c.filter((x) => x !== 'mo-container');
      const { tw, unmapped: un } = twFor(extra);
      un.forEach((x) => unmapped.add(x));
      return component('Container', tw.length ? attrStr('className', tw.join(' ')) : '', n.childNodes, ind);
    }
    return generic(n, ind);
  }

  const content = root.childNodes
    .filter((k) => !(isText(k) && !norm(k.value)) && k.nodeName !== '#comment')
    .map((k) => node(k, '        '))
    .join('\n');

  const name = pascal(screenName);
  const used = Object.keys(components).sort();
  const imports = used.length ? `import { ${used.join(', ')} } from 'moon-design-system';\n\n` : '';
  const tsx = `${imports}/** ${screenName}. Generated from the approved screen with the Moon components. */
export function ${name}() {
  return (
    <div className="min-h-screen bg-mo-grey-2 font-body text-mo-black">
      <a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>
      <main id="main">
${content}
      </main>
    </div>
  );
}

export default ${name};
`;
  return { componentName: name, tsx, components, unmapped: [...unmapped].sort(), differences: [...differences].sort() };
}
