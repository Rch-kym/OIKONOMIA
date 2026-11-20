// Utilidades puras: datas ISO (YYYY-MM-DD), números brasileiros, normalização de texto.

export const pad = (n) => String(n).padStart(2, '0');

export function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0); // meio-dia evita problemas de fuso/horário de verão
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function diffDays(a, b) {
  return Math.round((parseISO(a) - parseISO(b)) / 86400000);
}
export function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m = 1..12
export function monthOf(iso) { return iso.slice(0, 7); }
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function endOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(daysInMonth(y, m))}`;
}
export function dateInMonth(ym, day) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(Math.min(Math.max(day, 1), daysInMonth(y, m)))}`;
}
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function normDesc(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// Chave de "estabelecimento": ignora números soltos e datas (ex.: "(17/10)"), para agrupar o mesmo lugar.
export function merchantKey(s) {
  return normDesc(s).replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim() || normDesc(s);
}

// "1.234,56" | "-R$ 50,00" | "50,00-" | "(50,00)" | "1234.56" | "50,00 D"
export function brNumber(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { neg = true; s = s.replace(/-\s*$/, ''); }
  if (/^\s*-/.test(s)) { neg = true; s = s.replace(/^\s*-/, ''); }
  if (/\bD\b\s*$/i.test(s)) { neg = true; }
  s = s.replace(/R\$|\s|[CD]$/gi, '');
  if (s.includes(',') && s.includes('.')) {
    // o último separador é o decimal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return neg ? -Math.abs(n) : n;
}

export function parseDateAny(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})[/.-](\d{2})[/.-](\d{2})\b/);
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export function brl(n, opts = {}) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '− ' : ''}R$ ${s}`;
}
export function ddmm(iso) { return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`; }
