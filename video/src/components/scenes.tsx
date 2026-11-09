import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { c } from '../theme.ts';
import { proof } from '../scenes.ts';
import { Chips, Kicker, Rise, Shot } from './atoms.tsx';

const pad: React.CSSProperties = { padding: '96px 120px' };

/** 01 — the cold open. No product, no logo: just the thing that happened. */
export const Hook: React.FC = () => (
  <AbsoluteFill style={{ background: c.ink, ...pad, justifyContent: 'center' }}>
    <Rise delay={2}>
      <div style={{ fontSize: 86, lineHeight: 1.08, color: c.paper, fontWeight: 700, maxWidth: 1400 }}>
        Your app broke for somebody last week.
      </div>
    </Rise>
    <Rise delay={26}>
      <div style={{ fontSize: 86, lineHeight: 1.08, color: c.olive, fontWeight: 700, marginTop: 8 }}>
        You didn’t know.
      </div>
    </Rise>
    <Rise delay={54} style={{ marginTop: 56 }}>
      <div
        style={{
          display: 'inline-block',
          padding: '14px 26px',
          borderRadius: 10,
          background: c.redSoft,
          color: c.red,
          fontSize: 30,
          fontWeight: 700,
        }}
      >
        Invitation rejected
      </div>
    </Rise>
  </AbsoluteFill>
);

/** 02 — the product, in one unbroken look at the real page. */
export const Turn: React.FC = () => (
  <AbsoluteFill style={{ background: c.paper }}>
    <Shot src="landing.png" from={1.06} to={1.14} />
  </AbsoluteFill>
);

/** 03 — the wallet beat. The cost answer is on screen because it is the
 *  objection every judge and every builder raises first. */
export const SignIn: React.FC = () => (
  <AbsoluteFill style={{ background: c.paper }}>
    <Shot src="signin.png" from={1.05} to={1.11} />
    <AbsoluteFill style={{ justifyContent: 'flex-end', ...pad }}>
      <Chips
        delay={10}
        items={['one signature', 'no deposit', 'no gas', 'nothing spent']}
      />
    </AbsoluteFill>
  </AbsoluteFill>
);

type Row = { label: string; state: 'pass' | 'attention' };
const rows: Row[] = [
  { label: 'Email address with a + sign', state: 'attention' },
  { label: 'Standard email invitation', state: 'pass' },
  { label: 'Duplicate invitation', state: 'pass' },
];

/** 04 — what a run produces. The rows are the real ones from the public
 *  example report, rendered rather than screenshotted so they are crisp and
 *  can land one at a time. */
export const Run: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: c.paper, ...pad, justifyContent: 'center' }}>
      <Kicker>What the browser saw</Kicker>
      <div style={{ height: 36 }} />
      <div style={{ display: 'flex', gap: 64, alignItems: 'center' }}>
        <div style={{ flex: '0 0 560px' }}>
          <Rise delay={4}>
            <div style={{ fontSize: 58, fontWeight: 700, color: c.ink, lineHeight: 1.12 }}>
              A sealed browser,
              <br />
              then the truth.
            </div>
          </Rise>
          <div style={{ height: 36 }} />
          <Chips
            delay={20}
            items={['reaches your site', 'and nothing else', 'destroyed after']}
          />
        </div>
        <div
          style={{
            flex: 1,
            background: c.surface,
            border: `1px solid ${c.line}`,
            borderRadius: 24,
            padding: '20px 44px',
          }}
        >
          {rows.map((row, i) => {
            const s = spring({
              frame: frame - (18 + i * 14),
              fps,
              config: { damping: 200 },
              durationInFrames: 20,
            });
            const attention = row.state === 'attention';
            return (
              <div
                key={row.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '34px 0',
                  borderBottom: i < rows.length - 1 ? `1px solid ${c.line}` : 'none',
                  opacity: s,
                  transform: `translateX(${interpolate(s, [0, 1], [36, 0])}px)`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                  <div
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: 999,
                      background: attention ? c.redSoft : c.greenSoft,
                      color: attention ? c.red : c.ink,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 30,
                      fontWeight: 700,
                    }}
                  >
                    {attention ? '!' : '✓'}
                  </div>
                  <div style={{ fontSize: 34, color: c.ink, fontWeight: 500 }}>{row.label}</div>
                </div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    color: attention ? c.red : c.muted,
                    background: attention ? c.redSoft : 'transparent',
                    padding: attention ? '10px 18px' : 0,
                    borderRadius: 8,
                  }}
                >
                  {attention ? 'Needs attention' : 'Passed'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** 05 — the replay. The claim is "not a score, a recording", so the evidence
 *  page itself has to be on screen. */
export const Proof: React.FC = () => (
  <AbsoluteFill style={{ background: c.paper }}>
    <Shot src="demo-details.png" from={1.04} to={1.12} />
  </AbsoluteFill>
);

const Line: React.FC<{ k: string; v: string; mono?: boolean; delay: number }> = ({
  k,
  v,
  mono,
  delay,
}) => (
  <Rise delay={delay} distance={12}>
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 40,
        padding: '18px 0',
        borderBottom: `1px solid rgba(232,237,223,0.16)`,
      }}
    >
      <div style={{ fontSize: 26, color: c.olive, fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</div>
      <div
        style={{
          fontSize: 26,
          color: c.paper,
          fontWeight: 600,
          fontFamily: mono ? 'ui-monospace, Menlo, monospace' : undefined,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {v}
      </div>
    </div>
  </Rise>
);

/** 06a — the judges' beat. Every value here was read back from Celo mainnet,
 *  and the explorer path is on screen so it can be checked mid-video. */
export const Rents: React.FC = () => (
  <AbsoluteFill style={{ background: c.ink, ...pad, justifyContent: 'center' }}>
    <div style={{ display: 'flex', gap: 80, alignItems: 'center' }}>
      <div style={{ flex: '0 0 620px' }}>
        <Kicker tone="ink">It paid for this itself</Kicker>
        <div style={{ height: 28 }} />
        <Rise delay={4}>
          <div style={{ fontSize: 64, fontWeight: 700, color: c.paper, lineHeight: 1.1 }}>
            Trialoom rents
            <br />
            what it doesn’t own.
          </div>
        </Rise>
        <div style={{ height: 36 }} />
        <Chips tone="ink" delay={22} items={['usebuy', 'x402', 'Celo mainnet', 'one cent']} />
      </div>
      <div
        style={{
          flex: 1,
          background: 'rgba(247,247,242,0.06)',
          border: `1px solid rgba(232,237,223,0.22)`,
          borderRadius: 24,
          padding: '34px 44px',
        }}
      >
        <Rise delay={10}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 30, color: c.paper, fontWeight: 700 }}>One explanation</div>
            <div style={{ fontSize: 44, color: c.olive, fontWeight: 700 }}>{proof.amount}</div>
          </div>
        </Rise>
        <div style={{ height: 18 }} />
        <Line k="Bought through" v={proof.boughtThrough} delay={16} />
        <Line k="Chain" v={proof.chain} delay={20} />
        <Line k="Block" v={proof.block.toLocaleString('en-US')} mono delay={25} />
        <Line k="Status" v={proof.status} delay={30} />
        <Line k="Transaction" v={`${proof.tx.slice(0, 14)}…${proof.tx.slice(-8)}`} mono delay={36} />
        <Line k="Check it" v={proof.explorer} mono delay={42} />
      </div>
    </div>
  </AbsoluteFill>
);

const Node: React.FC<{ title: string; sub: string; delay: number; accent?: boolean }> = ({
  title,
  sub,
  delay,
  accent,
}) => (
  <Rise delay={delay} style={{ flex: 1 }}>
    <div
      style={{
        background: accent ? c.ink : c.surface,
        border: `1px solid ${accent ? c.ink : c.line}`,
        borderRadius: 22,
        padding: '38px 36px',
        minHeight: 210,
      }}
    >
      <div style={{ fontSize: 38, fontWeight: 700, color: accent ? c.paper : c.ink, lineHeight: 1.15 }}>
        {title}
      </div>
      <div style={{ fontSize: 26, color: accent ? c.olive : c.muted, marginTop: 14, lineHeight: 1.35 }}>
        {sub}
      </div>
    </div>
  </Rise>
);

const Arrow: React.FC<{ delay: number }> = ({ delay }) => (
  <Rise delay={delay} distance={0} style={{ flex: '0 0 64px' }}>
    <div style={{ fontSize: 44, color: c.olive, textAlign: 'center', fontWeight: 700 }}>→</div>
  </Rise>
);

/** 06b — where the money actually goes. Three boxes, because the thing worth
 *  understanding is the direction of travel, not the plumbing. */
export const Payouts: React.FC = () => (
  <AbsoluteFill style={{ background: c.paper, ...pad, justifyContent: 'center' }}>
    <Kicker>The same rail, both directions</Kicker>
    <div style={{ height: 44 }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <Node delay={2} title="You" sub="Free. No deposit, no gas, no paywall." />
      <Arrow delay={14} />
      <Node delay={18} title="Trialoom" sub="Buys inference through usebuy, over x402 on Celo." accent />
      <Arrow delay={30} />
      <Node delay={34} title="Testers" sub="Paid in USDC through Remesso." />
    </div>
  </AbsoluteFill>
);

/** 06c — one line, held. */
export const Paywall: React.FC = () => (
  <AbsoluteFill style={{ background: c.ink, ...pad, justifyContent: 'center', alignItems: 'center' }}>
    <Rise delay={2}>
      <div style={{ fontSize: 104, fontWeight: 700, color: c.paper, textAlign: 'center' }}>
        You never see
        <br />
        <span style={{ color: c.olive }}>a paywall.</span>
      </div>
    </Rise>
  </AbsoluteFill>
);

/** 07 — the close. The URL is the only call to action. */
export const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  // The landing page is nearly white, so the veil has to be heavy enough
  // for white type to read against it.
  const dim = interpolate(frame, [0, durationInFrames], [0.86, 0.94], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: c.paper }}>
      <Shot src="landing.png" from={1.12} to={1.18} blur={9} />
      <AbsoluteFill style={{ background: c.ink, opacity: dim }} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Rise delay={6}>
          <div style={{ fontSize: 92, fontWeight: 700, color: c.paper, textAlign: 'center' }}>
            trialoom.xyz
          </div>
        </Rise>
        <Rise delay={24}>
          <div style={{ fontSize: 34, color: c.greenSoft, marginTop: 20, textAlign: 'center' }}>
            Bring your app. Let an agent test it. Follow the proof.
          </div>
        </Rise>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
