import type { SVGProps } from 'react';

const shapes = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  evidence: (
    <>
      <path d="M7 3h8l4 4v14H5V3h2ZM14 3v5h5M8 12h8M8 16h5" />
    </>
  ),
  wallet: (
    <>
      <path d="M20 7H5a2 2 0 0 1 0-4h13v4M4 7v13h17V7M21 11h-6v5h6" />
      <circle cx="17.5" cy="13.5" r=".5" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  book: (
    <>
      <path d="M12 5c-4-3-9-1-9-1v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1ZM12 5v15" />
    </>
  ),
};
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: keyof typeof shapes }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {shapes[name]}
    </svg>
  );
}
export function LoomMark() {
  return (
    <svg width="31" height="31" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M5 6h22v7H12v13H5V6Z" fill="currentColor" />
      <path d="M16 17h11v9H16v-9Z" fill="var(--olive)" />
    </svg>
  );
}
