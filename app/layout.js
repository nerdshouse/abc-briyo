import './globals.css';

export const metadata = {
  title: 'Briyo Supplements — Abandoned Carts',
  description: 'Abandoned cart events received from GoKwik',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
