'use client';

/**
 * O hostKey vive só no navegador de quem criou a sala.
 * Trocar de navegador = perder a posse (esperado no MVP sem contas).
 */
const key = (slug: string) => `screenshare:host:${slug}`;

export function rememberHostKey(slug: string, hostKey: string): void {
  try {
    localStorage.setItem(key(slug), hostKey);
  } catch {
    // modo privado / storage bloqueado: segue como espectador
  }
}

export function recallHostKey(slug: string): string | null {
  try {
    return localStorage.getItem(key(slug));
  } catch {
    return null;
  }
}
