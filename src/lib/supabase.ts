import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente com a service_role. Só existe no servidor.
 *
 * As tabelas de uso têm RLS ligada e nenhuma policy: só esta chave enxerga
 * qualquer coisa. Ela nunca pode vazar para o bundle do cliente — por isso o
 * nome da variável não tem o prefixo NEXT_PUBLIC_, que é o que faz o Next
 * inlinar o valor no JavaScript enviado ao navegador.
 */
let cached: SupabaseClient | null = null;

export function usageDb(): SupabaseClient | null {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Sem configuração, o app roda inteiro — apenas sem registrar uso. Medir é
  // secundário; derrubar uma transmissão porque o banco não respondeu, não.
  if (!url || !key) return null;

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
