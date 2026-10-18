import { loadFont } from '@remotion/google-fonts/DMSans';
import { Easing } from 'remotion';

export const { fontFamily: FONT } = loadFont('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });

/** Dark scenes: near-black with violet and coral glows. Light scenes: pearl. One gradient accent, used sparingly. */
export const C = {
  ink: '#0b0912',
  ink2: '#171225',
  panel: '#16131f',
  line: '#2c2740',
  text: '#f5f2fb',
  dim: '#a59fb8',
  blue: '#8b7bff',
  blueSoft: '#2a2150',
  red: '#ff6b6b',
  redSoft: '#3a1c25',
  green: '#4ade80',
  amber: '#ffb366',
  violet: '#c084fc',
  white: '#ffffff',
  pearl: '#efecf3',
  dark: '#14111c',
  dimDark: '#6e6880',
};

export const ACCENT = 'linear-gradient(90deg, #a855f7, #ff7a59)';

export const OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const INOUT = Easing.bezier(0.65, 0, 0.35, 1);

export const FPS = 30;
export const W = 1920;
export const H = 1080;

export const lakh = (minor: number) => (minor / 1e7).toFixed(1);
