import './globals.css';

export const metadata = {
  title: 'Dispatch Desk · Voice order support',
  description: 'Shop everyday essentials and manage your orders by voice or text in English, Hindi and Marathi.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
