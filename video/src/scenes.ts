/**
 * The script, in one place. The voiceover generator and the composition both
 * read it, so the audio can never drift from what is on screen.
 *
 * Every factual claim here is checked rather than asserted:
 * the payment was re-verified against Celo mainnet on 2026-11-09 and the
 * numbers in `proof` are what the chain returned.
 */
export type Scene = {
  id: string;
  /** Spoken. No hex, no symbols — those live on screen where they can be read. */
  vo: string;
  /** Seconds of silence held after the line, so a cut can breathe. */
  tail: number;
  /** Floor, in seconds. Some shots need longer on screen than their line
   *  takes to say — the receipt and the check rows have to be readable. */
  min?: number;
};

export const scenes: Scene[] = [
  { id: '01-hook', vo: "Your app broke for somebody last week. You didn't know.", tail: 0.8, min: 5 },
  { id: '02-turn', vo: 'Trialoom hires agents to find it before your users do.', tail: 0.5 },
  { id: '03-in', vo: 'Your wallet is your account. One signature. Nothing spent.', tail: 0.4 },
  {
    id: '04-run',
    vo: 'A real browser opens your site in a sealed box, does the steps, and tells you what it saw.',
    tail: 0.5,
    min: 7.5,
  },
  { id: '05-proof', vo: 'Not a score. A recording. Open it at the moment it broke.', tail: 0.6, min: 5.5 },
  // The money beat is three shots, not one. Fourteen seconds on a single
  // static panel reads as a stall, and this is the part judges watch.
  {
    // "use buy" is spelled with a space on purpose: it is the text handed to
    // the speech model, and it guarantees the brand is pronounced rather than
    // mangled. On screen it is written "usebuy".
    id: '06-rents',
    vo: 'Trialoom rents what it needs. It bought that explanation through the use buy gateway, over x402 on Celo, for one cent, from its own wallet.',
    tail: 0.7,
  },
  { id: '06-payouts', vo: 'The same rail pays testers, in USDC, through Remesso.', tail: 0.5, min: 4.5 },
  { id: '06-paywall', vo: 'You never see a paywall.', tail: 0.9, min: 3 },
  { id: '07-close', vo: 'Bring your app. Let an agent test it. Follow the proof.', tail: 1.2, min: 5.5 },
];

/** Read from Celo mainnet on 2026-11-09; shown on screen, never spoken. */
export const proof = {
  boughtThrough: 'usebuy · x402',
  chain: 'Celo mainnet',
  tx: '0x339fe5f4bf8c0885c4070cd9700cdca935125ce2f90a952da473c977782943ef',
  block: 82_243_718,
  amount: '0.01 USD₮',
  token: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
  payer: '0xf8Ff4F7C83404e04506785b7DFDf838CA75C22ae',
  payee: '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B',
  explorer: 'celoscan.io/tx/0x339fe5f4…',
  status: 'Finalized',
};

export const FPS = 30;
