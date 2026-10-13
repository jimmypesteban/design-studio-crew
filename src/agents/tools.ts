import { allowedClasses, recipesCss } from '../moon/recipes.ts';
import { contrastRatio, parseHex } from '../moon/contrast.ts';
import { rgbOf, type MoonTokens } from '../moon/tokens.ts';
import type { ToolRunner } from './types.ts';

const DEFS = {
  lookup_token: {
    name: 'lookup_token',
    description: 'Look up a Moon token by name, for example mo-red-6, mo-h3, radius-mo-sm. Returns its value.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Token name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  check_contrast: {
    name: 'check_contrast',
    description: 'Measure the WCAG contrast ratio between two Moon colour tokens, for example mo-black on mo-grey-2.',
    input_schema: {
      type: 'object',
      properties: {
        foreground: { type: 'string', description: 'Text colour token, for example mo-grey-8' },
        background: { type: 'string', description: 'Surface colour token, for example mo-grey-1' },
      },
      required: ['foreground', 'background'],
      additionalProperties: false,
    },
  },
  list_classes: {
    name: 'list_classes',
    description: 'List every CSS class the screen may use. Any class not in this list is rejected.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
} as const;

export function makeTools(t: MoonTokens): ToolRunner {
  return {
    definitions(names) {
      return names
        .filter((n): n is keyof typeof DEFS => n in DEFS)
        .map((n) => ({ ...DEFS[n], input_schema: { ...DEFS[n].input_schema } }));
    },
    run(name, input) {
      try {
        if (name === 'lookup_token') {
          const key = String(input.name ?? '');
          if (t.colors[key]) return `${key} = ${t.colors[key]}`;
          if (t.fontSize[key]) return `${key} = ${t.fontSize[key].size} / ${t.fontSize[key].lineHeight}`;
          const r = key.replace(/^radius-/, '');
          if (t.radius[r]) return `${key} = ${t.radius[r]}`;
          if (t.shadow[key.replace(/^shadow-/, '')]) return `${key} = ${t.shadow[key.replace(/^shadow-/, '')]}`;
          if (t.spacing[key]) return `${key} = ${t.spacing[key]}`;
          return `No Moon token called ${key}.`;
        }
        if (name === 'check_contrast') {
          const fg = String(input.foreground ?? '');
          const bg = String(input.background ?? '');
          const a = fg.startsWith('#') ? parseHex(fg) : rgbOf(t, fg);
          const b = bg.startsWith('#') ? parseHex(bg) : rgbOf(t, bg);
          const ratio = Math.round(contrastRatio(a, b) * 100) / 100;
          return `${fg} on ${bg} is ${ratio}:1. Normal text (4.5:1): ${ratio >= 4.5 ? 'pass' : 'fail'}. Large text (3:1): ${ratio >= 3 ? 'pass' : 'fail'}.`;
        }
        if (name === 'list_classes') return allowedClasses(recipesCss(t)).join(' ');
        return `Unknown tool ${name}.`;
      } catch (e) {
        return `Tool error: ${(e as Error).message}`;
      }
    },
  };
}
