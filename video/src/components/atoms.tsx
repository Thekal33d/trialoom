import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig, Img, staticFile } from 'remotion';
import { c } from '../theme.ts';

/** Fade-and-rise, the only entrance this video uses. One motion, repeated,
 *  reads as deliberate; five different ones read as a template. */
export const Rise: React.FC<{
  delay?: number;
  children: React.ReactNode;
  distance?: number;
  style?: React.CSSProperties;
}> = ({ delay = 0, children, distance = 28, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 22 });
  return (
    <div
      style={{
        ...style,
        opacity: s,
        transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)`,
      }}
    >
      {children}
    </div>
  );
};

/** A screenshot of the real product, pushed in slowly so a still frame still
 *  feels like film. Cover-cropped because the captures are 16:10 and the
 *  canvas is 16:9. */
export const Shot: React.FC<{
  src: string;
  from?: number;
  to?: number;
  originY?: string;
  delay?: number;
  /** Pushes the page back so overlaid type is the only thing in focus. */
  blur?: number;
}> = ({ src, from = 1.04, to = 1.12, originY = 'top', delay = 0, blur = 0 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [from, to], {
    extrapolateRight: 'clamp',
  });
  const fade = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 14 });
  return (
    <Img
      src={staticFile(`shots/${src}`)}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        objectPosition: `center ${originY}`,
        transform: `scale(${scale})`,
        opacity: fade,
        filter: blur ? `blur(${blur}px)` : undefined,
      }}
    />
  );
};

/** The small all-caps facts that sit under a line of narration. They carry the
 *  detail the voiceover deliberately does not read aloud. */
export const Chips: React.FC<{ items: string[]; delay?: number; tone?: 'ink' | 'paper' }> = ({
  items,
  delay = 0,
  tone = 'paper',
}) => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
    {items.map((item, i) => (
      <Rise key={item} delay={delay + i * 4} distance={14}>
        <div
          style={{
            padding: '10px 20px',
            borderRadius: 999,
            fontSize: 24,
            letterSpacing: 0.2,
            fontWeight: 600,
            color: tone === 'ink' ? c.greenSoft : c.ink,
            background: tone === 'ink' ? 'rgba(232,237,223,0.12)' : c.greenSoft,
            border: `1px solid ${tone === 'ink' ? 'rgba(232,237,223,0.25)' : c.line}`,
            whiteSpace: 'nowrap',
          }}
        >
          {item}
        </div>
      </Rise>
    ))}
  </div>
);

export const Kicker: React.FC<{ children: React.ReactNode; tone?: 'ink' | 'paper' }> = ({
  children,
  tone = 'paper',
}) => (
  <div
    style={{
      fontSize: 22,
      fontWeight: 700,
      letterSpacing: 3,
      textTransform: 'uppercase',
      color: tone === 'ink' ? c.olive : c.muted,
    }}
  >
    {children}
  </div>
);
