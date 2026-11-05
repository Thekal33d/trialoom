import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import '@fontsource-variable/dm-sans';
import './globals.css';
import './account.css';
import './product.css';
export const metadata: Metadata = {
  title: 'Trialoom — Test. Fix. Ship.',
  description: 'Useful tests, reproducible findings, and fixes you can verify.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* Extensions such as Grammarly add body attributes before hydration. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
