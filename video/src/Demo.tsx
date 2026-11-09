import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useVideoConfig } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { scenes } from './scenes.ts';
import { c, FONT } from './theme.ts';
import { Close, Hook, Paywall, Payouts, Proof, Rents, Run, SignIn, Turn } from './components/scenes.tsx';

export const CROSSFADE = 12;

const byId: Record<string, React.FC> = {
  '01-hook': Hook,
  '02-turn': Turn,
  '03-in': SignIn,
  '04-run': Run,
  '05-proof': Proof,
  '06-rents': Rents,
  '06-payouts': Payouts,
  '06-paywall': Paywall,
  '07-close': Close,
};

export type DemoProps = { sceneDurations: number[] };

export const Demo: React.FC<DemoProps> = ({ sceneDurations }) => {
  const { durationInFrames, fps } = useVideoConfig();

  // Where each cut lands, so a whoosh can sit on it. Each scene starts one
  // crossfade earlier than the one before would suggest, because the
  // transition overlaps them.
  const cuts: number[] = [];
  let at = 0;
  for (const duration of sceneDurations.slice(0, -1)) {
    at += duration - CROSSFADE;
    cuts.push(at);
  }

  return (
  <AbsoluteFill style={{ background: c.paper, fontFamily: FONT }}>
    {/* Under everything, quiet enough that the narration never fights it. */}
    <Audio
      src={staticFile('audio/bed.mp3')}
      loop
      volume={(f) =>
        interpolate(
          f,
          [0, fps, durationInFrames - fps * 1.5, durationInFrames],
          [0, 0.09, 0.09, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        )
      }
    />
    {cuts.map((cut) => (
      <Sequence key={cut} from={Math.max(0, cut - 4)} durationInFrames={fps * 2}>
        <Audio src={staticFile('audio/whoosh.mp3')} volume={0.18} />
      </Sequence>
    ))}
    <TransitionSeries>
      {scenes.flatMap((scene, i) => {
        const Scene = byId[scene.id];
        const sequence = (
          <TransitionSeries.Sequence key={scene.id} durationInFrames={sceneDurations[i]}>
            <Scene />
            <Audio src={staticFile(`vo/${scene.id}.mp3`)} />
          </TransitionSeries.Sequence>
        );
        if (i === 0) return [sequence];
        return [
          <TransitionSeries.Transition
            key={`t-${scene.id}`}
            presentation={fade()}
            timing={linearTiming({ durationInFrames: CROSSFADE })}
          />,
          sequence,
        ];
      })}
    </TransitionSeries>
  </AbsoluteFill>
  );
};
