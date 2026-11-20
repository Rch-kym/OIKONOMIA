// Sincronização opcional com a planilha do Google, via um Apps Script publicado como "app da web".
// O app é a fonte da verdade no aparelho; a planilha guarda uma cópia legível (abas Conc_*) e um backup.
// Requisições "text/plain" evitam o pré-voo de CORS.

async function call(cfg, body) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: cfg.token, ...body }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Falha ao falar com a planilha (HTTP ${res.status})`);
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'A planilha recusou o pedido.');
  return out;
}

export function rowsFromState(state) {
  const head = ['id', 'data', 'valor', 'descricao', 'conta', 'categoria', 'tipo', 'situacao', 'previsto'];
  const rows = state.txns
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
    .map((t) => [t.id, t.date, t.amount, t.desc, t.acct, t.cat, t.kind, t.status === 'review' ? 'revisar' : 'ok', t.rec || '']);
  return [head, ...rows];
}

export async function pushState(cfg, state) {
  return call(cfg, {
    action: 'push',
    updatedAt: new Date().toISOString(),
    state: JSON.stringify(state),
    lancamentos: rowsFromState(state),
    regras: [['estabelecimento', 'categoria', 'tipo'], ...state.rules.map((r) => [r.key, r.cat, r.kind])],
  });
}

export async function pullState(cfg) {
  const out = await call(cfg, { action: 'pull' });
  return { state: out.state ? JSON.parse(out.state) : null, updatedAt: out.updatedAt || null };
}
