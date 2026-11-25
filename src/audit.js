// "Nada passa": confere um mês inteiro e diz o que ainda precisa de atenção. Também sugere contas fixas.
import { coverage, isSalary, monthItems, payWindow, salaryComp } from './recurring.js';
import { dizimoFor, fatura, reconcile } from './summary.js';
import { brl, dateInMonth, diffDays, merchantKey, monthOf, normDesc, round2 } from './util.js';

// Palavra-chave que identifica a conta no extrato: o nome depois do tipo, sem números.
export function keywordFor(desc) {
  const parts = String(desc).split(' · ');
  const base = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
  const words = normDesc(base).replace(/\d+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  return words.slice(0, 3).join(' ');
}

// Quantos lançamentos já importados batem com esta palavra-chave (para conferir antes de salvar).
export function matchPreview(state, key, type) {
  const k = normDesc(key || '');
  if (!k) return { count: 0, sample: [] };
  const pool = [...state.txns.filter((t) => t.acct === 'banco'), ...(state.hist || [])];
  const hits = pool.filter((t) => (type === 'in') === (t.amount > 0) && normDesc(t.desc).includes(k));
  hits.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { count: hits.length, sample: hits.slice(0, 3) };
}

// Contas que se repetem em meses diferentes e ainda não são fixas.
export function suggestFixed(state) {
  const known = state.recurring.map((r) => normDesc(r.match || '')).filter(Boolean);
  const ignored = new Set(state.ignored || []);
  const pool = [...(state.hist || []).map((h) => ({ ...h, acct: 'banco', kind: h.amount > 0 ? 'in' : 'out' })), ...state.txns.filter((t) => t.acct === 'banco' && !t.rec && t.kind !== 'transfer' && t.kind !== 'cardpay')];
  const groups = new Map();
  for (const t of pool) {
    if (t.kind === 'transfer' || t.kind === 'cardpay') continue;
    const k = merchantKey(t.desc);
    if (!k || ignored.has(k)) continue;
    if (known.some((kw) => normDesc(t.desc).includes(kw))) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [key, list] of groups) {
    const months = [...new Set(list.map((t) => monthOf(t.date)))].sort();
    if (months.length < 2) continue;
    // um lançamento por mês (o mais próximo do dia típico); precisa ter valor e dia parecidos
    const amounts = list.map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
    const med = amounts[Math.floor(amounts.length / 2)];
    const days = list.map((t) => Number(t.date.slice(8))).sort((a, b) => a - b);
    const spreadDays = days[days.length - 1] - days[0];
    const perMonth = list.length / months.length;
    if (perMonth > 1.5 || med < 5 || spreadDays > 7) continue;
    const spread = (amounts[amounts.length - 1] - amounts[0]) / med;
    const last = list.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    out.push({ key, desc: last.desc, type: last.amount > 0 ? 'in' : 'out', amount: round2(med), day: days[Math.floor(days.length / 2)], months: months.length, variable: spread > 0.1, match: keywordFor(last.desc), cat: last.cat || '' });
  }
  return out.sort((a, b) => b.months - a.months || b.amount - a.amount);
}

const L = { ok: 0, info: 1, warn: 2, bad: 3 };

// Confere um mês. Cada item: { level: 'ok'|'info'|'warn'|'bad', title, detail, go, list }
export function audit(state, ym, today) {
  const items = [];
  const cov = coverage(state);
  const add = (level, title, detail = '', extra = {}) => items.push({ level, title, detail, ...extra });
  const isCurrent = monthOf(today) === ym;

  // 1) saldo e atualização do extrato
  const rec = reconcile(state);
  if (rec.status === 'ok') add('ok', 'Saldo confere com o banco', `Extrato de ${rec.bank.date.slice(8)}/${rec.bank.date.slice(5, 7)}`);
  else if (rec.status === 'diff') add('bad', 'Saldo não confere com o banco', `Diferença de ${brl(rec.diff)}`, { go: 'inicio', kind: 'diff', amount: rec.diff });
  else add('warn', 'Sem saldo do banco para conferir', 'Importe um extrato com saldo ou digite o saldo em Ajustes.', { go: 'ajustes' });
  if (isCurrent) {
    const age = diffDays(today, cov);
    if (age >= 2) add('warn', `O último lançamento é de ${age} dias atrás`, 'Importe o extrato de hoje para a conferência valer.', { go: 'ajustes', kind: 'stale', days: age });
  }

  // 2) lançamentos sem categoria
  const pend = state.txns.filter((t) => t.acct === 'banco' && t.status === 'review' && t.date.startsWith(ym));
  if (pend.length) add('bad', `${pend.length} lançamento${pend.length > 1 ? 's' : ''} esperando revisão`, '', { go: 'revisar', kind: 'review', count: pend.length, amount: round2(pend.reduce((s, t) => s + t.amount, 0)) });
  else add('ok', 'Nenhum lançamento sem revisão');

  // 3) contas fixas (saídas)
  const fixed = monthItems(state, ym, today);
  const outs = fixed.filter((i) => i.rec.type === 'out' && !i.rec.card);
  if (outs.length) {
    const live = outs.filter((i) => i.status !== 'pulada');
    const paid = live.filter((i) => i.status === 'paga' || i.status === 'diferente');
    const missing = live.filter((i) => i.status === 'sem débito');
    const diff = live.filter((i) => i.status === 'diferente');
    if (missing.length) add('bad', `${missing.length} conta${missing.length > 1 ? 's' : ''} fixa${missing.length > 1 ? 's' : ''} sem débito no extrato`, 'Já passou do vencimento e o extrato não trouxe o pagamento.', { go: 'fixas', list: missing.map((i) => ({ label: i.rec.desc, date: i.due, amount: -i.planned, rec: i.rec.id })) });
    if (diff.length) add('warn', `${diff.length} conta${diff.length > 1 ? 's' : ''} fixa${diff.length > 1 ? 's' : ''} com valor diferente do previsto`, '', { go: 'fixas', list: diff.map((i) => ({ label: i.rec.desc, date: i.txn.date, amount: i.txn.amount, extra: `previsto ${brl(i.planned)}` })) });
    if (!missing.length && !diff.length && paid.length) add('ok', `Todas as ${paid.length} contas fixas já vencidas foram pagas`);
    const soon = live.filter((i) => i.status === 'a vencer' && diffDays(i.due, today) >= 0 && diffDays(i.due, today) <= 7);
    if (soon.length) add('info', `${soon.length} vence${soon.length > 1 ? 'm' : ''} nos próximos 7 dias`, '', { go: 'fixas', list: soon.map((i) => ({ label: i.rec.desc, date: i.due, amount: -i.planned })) });
    const ends = outs.filter((i) => i.rec.until === ym);
    if (ends.length) add('info', `${ends.map((i) => i.rec.desc).join(', ')} termina${ends.length > 1 ? 'm' : ''} neste mês`, 'Última cobrança prevista.', { go: 'fixas' });
  }

  // 4) salário / entradas fixas
  for (const i of fixed.filter((x) => x.rec.type === 'in' && x.rec.cat !== 'Vale Alimentação')) {
    const w = payWindow(state, i.rec, i.due);
    const cm = isSalary(i.rec) ? salaryComp(state, i.rec, i.due) : ym;
    const label = isSalary(i.rec) ? `Salário de ${cm.slice(5)}/${cm.slice(0, 4)}` : i.rec.desc;
    if (i.status === 'paga' || i.status === 'diferente') add(i.status === 'diferente' ? 'warn' : 'ok', `${label} recebido em ${i.txn.date.slice(8)}/${i.txn.date.slice(5, 7)}`, i.status === 'diferente' ? 'O valor veio diferente do previsto.' : '', { go: 'mes' });
    else if (i.status === 'pulada') continue;
    else if (w && today >= w.from) add(i.due < today ? 'warn' : 'info', `${label} ainda não chegou`, `Janela: ${w.from.slice(8)}/${w.from.slice(5, 7)} a ${w.to.slice(8)}/${w.to.slice(5, 7)}.`, { go: 'mes' });
  }

  // 5) fatura do cartão
  const due = dateInMonth(ym, state.config.cardDueDay ?? 16);
  const f = fatura(state, due);
  if (f.total > 0 || f.pago > 0) {
    if (due <= cov && f.pago === 0) add('bad', 'Fatura do cartão sem pagamento no extrato', `Prevista: ${brl(f.total)}`, { go: 'mes', kind: 'fatura', amount: -f.total });
    else if (f.pago > 0 && Math.abs(f.pago - f.total) > 1) add('warn', 'Pagamentos do cartão diferentes da fatura prevista', `Pago no banco: ${brl(f.pago)}. Previsto na fatura: ${brl(f.total)}. Importe a fatura do cartão para conferir as compras.`, { go: 'ajustes', kind: 'fatura-diff', pago: f.pago, total: f.total });
    else if (f.pago > 0) add('ok', 'Fatura do cartão paga');
  }

  // 6) dízimo
  const dz = dizimoFor(state, ym);
  if (dz && dz.amount > 0) {
    if (dz.paid) add('ok', 'Dízimo pago'); else if (isCurrent || ym < monthOf(today)) add(ym < monthOf(today) ? 'warn' : 'info', `Dízimo do mês ainda não pago`, `Previsto ${brl(dz.amount)} no fim do mês.`, { go: 'mes' });
  }

  // 7) anotado à mão e que não apareceu no extrato
  const lost = state.txns.filter((t) => t.manual && t.acct === 'banco' && !t.confirmed && diffDays(cov, t.date) > 3);
  if (lost.length) add('warn', `${lost.length} lançamento${lost.length > 1 ? 's' : ''} seu${lost.length > 1 ? 's' : ''} sem aparecer no extrato`, 'Se foi em dinheiro, mova para a conta Dinheiro.', { go: 'lancamentos', list: lost.map((t) => ({ label: t.desc, date: t.date, amount: t.amount })) });

  // 8) possíveis duplicidades (mesmo valor, mesmo dia, mesmo estabelecimento, valor alto)
  const dup = new Map();
  for (const t of state.txns) {
    if (t.acct !== 'banco' || !t.date.startsWith(ym) || Math.abs(t.amount) < 20) continue;
    const k = `${t.date}|${t.amount}|${merchantKey(t.desc)}`;
    dup.set(k, [...(dup.get(k) || []), t]);
  }
  const dups = [...dup.values()].filter((l) => l.length > 1);
  if (dups.length) add('info', `${dups.length} possível${dups.length > 1 ? 'is' : ''} cobrança${dups.length > 1 ? 's' : ''} em duplicidade`, 'Mesmo valor, mesmo dia, mesmo destino. Pode ser legítimo.', { go: 'lancamentos', list: dups.map((l) => ({ label: l[0].desc, date: l[0].date, amount: l[0].amount, extra: `${l.length}x` })) });

  // 9) contas fixas que o app encontrou
  const sug = suggestFixed(state);
  if (sug.length) add('info', `${sug.length} possível${sug.length > 1 ? 'is' : ''} conta${sug.length > 1 ? 's' : ''} fixa${sug.length > 1 ? 's' : ''} encontrada${sug.length > 1 ? 's' : ''}`, 'Se repetem em meses diferentes e ainda não estão cadastradas.', { go: 'fixas' });

  items.sort((a, b) => L[b.level] - L[a.level]);
  const bad = items.filter((i) => i.level === 'bad').length, warn = items.filter((i) => i.level === 'warn').length;
  return { ym, items, bad, warn, clean: bad === 0 && warn === 0 };
}
