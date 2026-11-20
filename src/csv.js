// Leitor de CSV de extrato/fatura com detecção de separador, cabeçalho e colunas.
// Aceita: Data;Descrição;Valor | Data;Histórico;Entrada;Saída | Valor + coluna C/D | saldo opcional.
import { brNumber, normDesc, parseDateAny } from './util.js';

export function splitLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelim(lines) {
  const sample = lines.slice(0, 15).join('\n');
  const score = (d) => (sample.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length;
  const cands = [';', ',', '\t'].map((d) => [d, score(d)]).sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : ';';
}

export function parseCSV(text) {
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
  const delim = detectDelim(lines);
  const rows = lines.map((l) => splitLine(l, delim));

  // linha de cabeçalho = primeira que tem "data" e ("valor" ou "entrada/crédito" ou "saída/débito")
  let hi = rows.findIndex((r) => {
    const n = r.map(normDesc);
    return n.some((c) => /^(data|dt|date)\b/.test(c)) && n.some((c) => /(valor|entrada|saida|credito|debito|montante)/.test(c));
  });
  let col = { date: -1, desc: [], amount: -1, credit: -1, debit: -1, balance: -1, dc: -1 };
  if (hi >= 0) {
    rows[hi].map(normDesc).forEach((c, i) => {
      if (col.date < 0 && /^(data|dt|date)\b/.test(c) && !/balancete/.test(c)) col.date = i;
      else if (/(hist|descri|lancamento|memo|estabelec|detalh|beneficiario|nome)/.test(c)) col.desc.push(i);
      else if (/^(c d|inf c d|d c|natureza|tipo)\b/.test(c) || /\bc d\b/.test(c)) col.dc = i;
      else if (/^saldo/.test(c)) col.balance = i;
      else if (/(credito|entrada)/.test(c) && !/cartao/.test(c)) col.credit = i;
      else if (/(debito|saida)/.test(c)) col.debit = i;
      else if (/^(valor|montante|value)/.test(c) && col.amount < 0) col.amount = i;
    });
  } else {
    // sem cabeçalho: acha a coluna de data e a de valor pelo formato
    const first = rows.find((r) => r.some((c) => parseDateAny(c)));
    if (first) {
      col.date = first.findIndex((c) => parseDateAny(c));
      const numIdx = first.map((c, i) => [i, brNumber(c)]).filter(([i, n]) => Number.isFinite(n) && i !== col.date);
      col.amount = numIdx.length ? numIdx[numIdx.length - 1][0] : -1;
      col.desc = first.map((c, i) => i).filter((i) => i !== col.date && i !== col.amount && /[A-Za-zÀ-ú]/.test(first[i]));
    }
    hi = -1;
  }
  if (col.date < 0 || (col.amount < 0 && col.credit < 0 && col.debit < 0)) {
    throw new Error('Não consegui identificar as colunas de data e valor neste CSV.');
  }

  const txns = [];
  const balances = [];
  for (const r of rows.slice(hi + 1)) {
    const date = parseDateAny(r[col.date]);
    const descRaw = col.desc.map((i) => r[i]).filter(Boolean).join(' - ');
    const dn = normDesc(descRaw);
    // linhas de saldo (BB traz "Saldo Anterior" e "S A L D O")
    if (/^(saldo|s a l d o|total)/.test(dn)) {
      const bi = col.balance >= 0 ? col.balance : col.amount;
      const b = brNumber(r[bi]);
      if (date && Number.isFinite(b)) balances.push({ date, amount: b });
      continue;
    }
    if (!date) continue;
    let amount = NaN;
    if (col.amount >= 0) {
      amount = brNumber(r[col.amount]);
      if (col.dc >= 0 && Number.isFinite(amount)) {
        const t = normDesc(r[col.dc]);
        if (/^(d|debito|saida)/.test(t)) amount = -Math.abs(amount);
        else if (/^(c|credito|entrada)/.test(t)) amount = Math.abs(amount);
      }
    } else {
      const cr = col.credit >= 0 ? brNumber(r[col.credit]) : NaN;
      const db = col.debit >= 0 ? brNumber(r[col.debit]) : NaN;
      if (Number.isFinite(cr) && cr !== 0) amount = Math.abs(cr);
      else if (Number.isFinite(db) && db !== 0) amount = -Math.abs(db);
    }
    if (!Number.isFinite(amount) || amount === 0) continue;
    txns.push({ date, amount: Math.round(amount * 100) / 100, desc: descRaw || 'Sem descrição' });
    if (col.balance >= 0 && col.balance !== col.amount) {
      const b = brNumber(r[col.balance]);
      if (Number.isFinite(b)) balances.push({ date, amount: b });
    }
  }
  const last = balances.length ? balances[balances.length - 1] : null;
  return { format: 'csv', account: 'banco', txns, balance: last ? { amount: Math.round(last.amount * 100) / 100, date: last.date } : null };
}
