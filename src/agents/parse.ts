export type Kind = 'ui' | 'brand' | 'audit' | 'unclear';

export interface LeadPlan {
  kind: Kind;
  screen_name: string;
  route: string[];
  summary: string;
  questions: string[];
}

function fence(text: string, lang: string): string | null {
  const re = new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = re.exec(text);
  return m ? m[1]!.trim() : null;
}

export function parseLead(text: string): LeadPlan {
  const raw = fence(text, 'json') ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let obj: Partial<LeadPlan> = {};
  try {
    obj = JSON.parse(raw) as Partial<LeadPlan>;
  } catch {
    throw new Error('The Studio Lead did not return valid JSON, so the route is unknown.');
  }
  const kind = (['ui', 'brand', 'audit', 'unclear'] as const).includes(obj.kind as Kind) ? (obj.kind as Kind) : 'unclear';
  const known = ['strategist', 'ux', 'ui', 'brand', 'reviewer', 'handoff'];
  return {
    kind,
    screen_name: String(obj.screen_name ?? 'Screen').slice(0, 60),
    route: (obj.route ?? []).filter((r) => known.includes(r)),
    summary: String(obj.summary ?? ''),
    questions: (obj.questions ?? []).map(String).slice(0, 2),
  };
}

export interface UiOutput {
  note: string;
  html: string;
}

export function parseUi(text: string): UiOutput {
  const html = fence(text, 'html');
  if (!html) throw new Error('The UI agent did not return an html block.');
  const note = text.replace(/```html[\s\S]*?```/i, '').trim();
  return { note, html };
}
