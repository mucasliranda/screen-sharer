import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Screen Sharer',
  description: 'Compartilhe sua tela por link. Sem cadastro.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
