# Brand assets

Rendered from the mark the product actually draws — `LoomMark` in
[`src/components/icons.tsx`](../../src/components/icons.tsx) — not traced or
redrawn, so they match the live site exactly. Colours are the product's own
tokens from `src/app/product.css`: ink `#263b30`, olive `#a1af70`, paper
`#f7f7f2`. The wordmark is Manrope 800, the site's display face.

| File | Use |
| --- | --- |
| `trialoom-mark-512.png`, `trialoom-mark-1024.png` | Square mark, transparent. 25% padding, so a circular crop does not clip it |
| `trialoom-mark-1024-paper.png` | Square mark on brand paper. The safe choice where transparency renders badly or the background is unknown — this is what the hackathon entry uses |
| `trialoom-mark-1024-dark.png` | Reversed out of ink, for dark backgrounds |
| `trialoom-wordmark*.png` | Mark plus "trialoom.", about 2000×600, in the same three treatments |

To regenerate, render the two paths of `LoomMark` at the size you need; the
SVG is the source of truth and these PNGs are derived from it.
