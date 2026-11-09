import React from 'react';
import { CalculateMetadataFunction, Composition, staticFile } from 'remotion';
import { FPS, scenes } from './scenes.ts';
import { getAudioDuration } from './get-audio-duration.ts';
import { CROSSFADE, Demo, DemoProps } from './Demo.tsx';
import { H, W } from './theme.ts';

/** The composition is as long as the narration, not as long as a guess.
 *  Each scene runs for its line plus its tail, or its floor, whichever is
 *  longer; the crossfades overlap, so they come back off the total. */
const calculateMetadata: CalculateMetadataFunction<DemoProps> = async () => {
  const spoken = await Promise.all(
    scenes.map((scene) => getAudioDuration(staticFile(`vo/${scene.id}.mp3`))),
  );
  const sceneDurations = scenes.map((scene, i) =>
    Math.ceil(Math.max(spoken[i] + scene.tail, scene.min ?? 0) * FPS),
  );
  const total = sceneDurations.reduce((a, b) => a + b, 0) - CROSSFADE * (scenes.length - 1);
  return { durationInFrames: total, props: { sceneDurations } };
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="TrialoomDemo"
    component={Demo}
    width={W}
    height={H}
    fps={FPS}
    durationInFrames={1200}
    defaultProps={{ sceneDurations: [] }}
    calculateMetadata={calculateMetadata}
  />
);
