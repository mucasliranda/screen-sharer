'use client';

/**
 * fetch + JSON com falha legível.
 *
 * Um `res.json()` cru estoura com "Unexpected token '<'" sempre que a resposta
 * é HTML — proxy no caminho, rota 404, servidor reiniciando. O usuário merece
 * uma mensagem melhor que essa.
 */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Sem resposta do servidor. Verifique sua conexão.');
  }

  const text = await res.text();

  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`O servidor respondeu algo inesperado (HTTP ${res.status}).`);
    }
  }

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Falha na requisição (HTTP ${res.status}).`;
    throw new Error(message);
  }

  return data as T;
}
