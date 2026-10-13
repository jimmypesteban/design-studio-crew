export type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16';

export interface SizeSpec {
  id: string;
  label: string;
  channel: string;
  width: number;
  height: number;
  /** The nearest ratio the image model offers. The picture is cropped to the exact size afterwards. */
  genRatio: AspectRatio;
  /** Keep text at least this far from the left and right (x) and top and bottom (y). */
  safe: { x: number; y: number };
  /** Moon type classes for this size. */
  headline: string;
  sub: string;
  cta: 'xl' | 'lg' | 'sm';
}

/** Common social and display sizes. Channel specs change, so check them before a real campaign. */
export const SIZES: SizeSpec[] = [
  { id: 'ig-square', label: 'Square post', channel: 'Instagram or Facebook feed', width: 1080, height: 1080, genRatio: '1:1', safe: { x: 44, y: 44 }, headline: 'mo-h3', sub: 'mo-h6', cta: 'xl' },
  { id: 'ig-story', label: 'Story', channel: 'Instagram or Facebook story', width: 1080, height: 1920, genRatio: '9:16', safe: { x: 64, y: 250 }, headline: 'mo-h2', sub: 'mo-h6', cta: 'xl' },
  { id: 'link-landscape', label: 'Link preview', channel: 'Link share, LinkedIn, Facebook', width: 1200, height: 628, genRatio: '16:9', safe: { x: 48, y: 32 }, headline: 'mo-h5', sub: 'mo-body', cta: 'lg' },
  { id: 'banner-wide', label: 'Wide banner', channel: 'Website or newsletter header', width: 1500, height: 500, genRatio: '16:9', safe: { x: 48, y: 24 }, headline: 'mo-h5', sub: 'mo-body', cta: 'lg' },
  { id: 'display-medium', label: 'Medium rectangle', channel: 'Display ads', width: 300, height: 250, genRatio: '4:3', safe: { x: 12, y: 12 }, headline: 'mo-h7', sub: 'mo-body-sm', cta: 'sm' },
];

export const SIZE_BY_ID = new Map(SIZES.map((s) => [s.id, s]));
export const HEADLINE_CLASSES = ['mo-h2', 'mo-h3', 'mo-h4', 'mo-h5', 'mo-h6', 'mo-h7'];
export const CTA_VARIANTS = ['primary', 'highlight', 'accent'];
