import './globals.css';

export const metadata = {
  title: 'Dispatch Desk · Voice order support',
  description: 'Change wholesale orders in Hindi or Marathi by voice or text.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
