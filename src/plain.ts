import { secretValues } from './config.ts';

/**
 * House style for everything the studio writes: plain language, no em dashes,
 * no en dashes. Applied to agent output, Telegram messages and the log, so a
 * model that slips cannot break the rule.
 */
export function plain(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/(\d)\s*\u2013\s*(\d)/g, '$1 to $2')
    .replace(/\s*\u2013\s*/g, ', ');
}

/** Remove any secret value that somehow ended up in text. */
export function scrub(text: string): string {
  let out = text;
  for (const s of secretValues()) out = out.split(s).join('[secret removed]');
  return out;
}

export function clean(text: string): string {
  return scrub(plain(text));
}

export function slug(text: string, max = 32): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'job'
  );
}
