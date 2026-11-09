import React from 'react';
import { AbsoluteFill, Audio, staticFile } from 'remotion';
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

export const Demo: React.FC<DemoProps> = ({ sceneDurations }) => (
  <AbsoluteFill style={{ background: c.paper, fontFamily: FONT }}>
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
