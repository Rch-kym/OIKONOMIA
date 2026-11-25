// Filtro de lançamentos (usado pela tela Extrato e pelo assistente).
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// f: { q, from, to, cat, type: 'in'|'out', acct, status: 'review'|'ok'|'rec', min, max, sort: 'date'|'value' }
export function filterTxns(state, f = {}) {
  const words = norm(f.q).split(/\s+/).filter(Boolean);
  const min = f.min === '' || f.min == null ? null : Number(f.min);
  const max = f.max === '' || f.max == null ? null : Number(f.max);
  let list = state.txns.filter((t) => {
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.cat && (t.cat || '') !== f.cat) return false;
    if (f.type === 'in' && !(t.amount > 0)) return false;
    if (f.type === 'out' && !(t.amount < 0)) return false;
    if (f.acct && t.acct !== f.acct) return false;
    if (f.status === 'review' && t.status !== 'review') return false;
    if (f.status === 'ok' && t.status === 'review') return false;
    if (f.status === 'rec' && !t.rec) return false;
    const a = Math.abs(t.amount);
    if (min != null && Number.isFinite(min) && a < min) return false;
    if (max != null && Number.isFinite(max) && a > max) return false;
    if (words.length) {
      const hay = norm(`${t.desc} ${t.cat || ''} ${String(Math.abs(t.amount).toFixed(2)).replace('.', ',')} ${String(Math.abs(t.amount).toFixed(2))}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  list = list.sort(f.sort === 'value' ? (a, b) => Math.abs(b.amount) - Math.abs(a.amount) : (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const sum = (fn) => Math.round(list.filter(fn).reduce((s, t) => s + t.amount, 0) * 100) / 100;
  return { list, count: list.length, entradas: sum((t) => t.amount > 0), saidas: sum((t) => t.amount < 0), total: sum(() => true) };
}
export const hasFilter = (f) => !!(f.q || f.from || f.to || f.cat || f.type || f.acct || f.status || (f.min !== '' && f.min != null) || (f.max !== '' && f.max != null));
