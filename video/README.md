# The demo video

A 44-second Remotion composition, rendered to 1080p with an ElevenLabs
voiceover. It lives here rather than in the product so Remotion, React and a
headless Chrome never enter the application's dependency tree.

## Rebuild it

```bash
cd video
npm install
ELEVENLABS_API_KEY=... npm run voiceover   # writes public/vo/*.mp3
npm run render                             # writes out/trialoom-demo.mp4
```

`npm run studio` opens the editor if you want to re-time a scene.

## What is and isn't in Git

The source is committed. The rendered MP4, the generated MP3s and
`node_modules` are not: they are reproducible from the two commands above, and
an 11 MB binary that changes on every render does not belong in history.

## The script is the single source of truth

[`src/scenes.ts`](src/scenes.ts) holds every spoken line and the on-chain
figures. The voiceover generator and the composition both read it, so the audio
cannot drift from what is on screen. Changing a line means regenerating that
scene's MP3 — delete the file, or run with `FORCE=1`.

The payment shown in the `06-rents` scene was re-read from Celo mainnet on
2026-11-09 before it was put on screen: transaction `0x339fe5f4…2943ef`,
block 82,243,718, finalized, 0.010000 USD₮ from the agent wallet to Cencori's
payee. The explorer path is on screen so a viewer can check it during the video
rather than taking our word for it.

## Visuals

Every screenshot in `public/shots/` is a real capture of the live site taken on
2026-11-09 at 1440×900 with a 2× device pixel ratio — the landing page, the
sign-in page and the public example report at `/demo`. Nothing is a mock-up.
The check rows in the `04-run` scene are rendered as components rather than
screenshotted, so they stay sharp at 1080p and can land one at a time; their
content is the same three checks the public example report shows.

## Two things that will bite you

**The bundled headless Chrome does not work on macOS 26+.** Remotion's
`chrome-headless-shell` never fires `requestAnimationFrame` here, so the root
component times out before a frame is drawn — at 28 seconds, and still at 178.
`remotion.config.ts` looks for a full Google Chrome and uses that instead. Set
`REMOTION_BROWSER` to point somewhere else.

**Load fonts narrowly.** `loadFont()` without options makes 42 requests for
Manrope and times the render out on its own. `src/theme.ts` asks for three
weights and the Latin subset.
