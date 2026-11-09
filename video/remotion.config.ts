import { existsSync } from 'node:fs';
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

/**
 * Remotion's bundled `chrome-headless-shell` never fires requestAnimationFrame
 * on this machine (macOS 27), so the root component load times out before a
 * frame is drawn — at 28 seconds and still at 178. A full Chrome works, so
 * use one when we can find it.
 *
 * Set REMOTION_BROWSER to override.
 */
const candidates = [
  process.env.REMOTION_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `${process.env.HOME}/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome`,
  '/usr/bin/google-chrome',
].filter((path): path is string => Boolean(path));

const browser = candidates.find((path) => existsSync(path));
if (browser) Config.setBrowserExecutable(browser);
