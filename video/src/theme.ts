import { loadFont } from '@remotion/google-fonts/Manrope';

/** Only the weights and the subset this video uses. The unrestricted default
 *  pulls 42 font files and the root component times out before a frame
 *  renders. */
const { fontFamily } = loadFont('normal', { weights: ['500', '600', '700'], subsets: ['latin'] });
export const FONT = fontFamily;

/** Taken from the product's own tokens in src/app/product.css, so the video
 *  and the site are the same colour, not an approximation of it. */
export const c = {
  paper: '#f7f7f2',
  surface: '#fdfdf8',
  ink: '#263b30',
  muted: '#5f695e',
  olive: '#a1af70',
  greenSoft: '#e8eddf',
  line: '#dfe3d8',
  red: '#a24f42',
  redSoft: '#f6e7e3',
  amber: '#80632c',
  amberSoft: '#f2ecdc',
} as const;

export const W = 1920;
export const H = 1080;
