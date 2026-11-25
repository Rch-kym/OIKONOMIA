// Leitor de extrato em PDF (conta corrente do Banco do Brasil gerado pelo internet banking).
// 1) pdf.js (Mozilla) extrai cada trecho de texto com a sua posição na página;
// 2) parseBBItems monta as linhas do extrato a partir das colunas e confere a soma com os saldos do próprio PDF.
import { brNumber, round2 } from './util.js';

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const AMOUNT = /^([\d.]+,\d{2})\s*\(([+-])\)$/;
const STAMP = /^\d{2}\/\d{2}\s+\d{2}:\d{2}/;
const BALANCE_LABEL = /^(saldo anterior|saldo do dia|saldo|s a l d o)$/i;

const toISO = (d) => { const m = DATE.exec(d); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const signed = (txt) => { const m = AMOUNT.exec(txt.trim()); return m ? (m[2] === '-' ? -1 : 1) * brNumber(m[1]) : null; };

function cleanDetail(parts) {
  let s = parts.join(' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\d{2}\/\d{2}\s+\d{2}:\d{2}\s*/, ''); // data e hora da operação
  s = s.replace(/^\d{11,}\s+/, '');                   // CPF/CNPJ à frente do nome
  return s;
}

// pages: [{ items: [{ str, x, y }] }]
export function parseBBItems(pages) {
  const stream = []; // { kind: 'anchor'|'line', y, ... } em ordem de leitura (página, depois y decrescente)
  let stop = false;
  pages.forEach((page, pi) => {
    if (stop) return;
    const items = page.items.filter((i) => i.str && i.str.trim());
    const head = items.find((i) => i.str.trim() === 'Histórico');
    const valor = items.find((i) => i.str.trim() === 'Valor');
    if (!head || !valor) return; // página sem tabela
    const histX = head.x - 4, valX = valor.x - 60;
    const info = items.find((i) => /^Informações Adicionais/.test(i.str.trim()));
    const yMax = head.y - 1, yMin = info ? info.y + 1 : -Infinity;
    const body = items.filter((i) => i.y < yMax && i.y > yMin);
    if (info) stop = true;

    // âncoras: linha que tem data na 1ª coluna e valor "(+)/(-)" na última
    const dates = body.filter((i) => i.x < histX && DATE.test(i.str.trim()));
    const anchors = dates.map((d) => {
      const row = body.filter((i) => Math.abs(i.y - d.y) < 2);
      const amt = row.find((i) => i.x >= valX && AMOUNT.test(i.str.trim()));
      const label = row.filter((i) => i.x >= histX && i.x < valX).map((i) => i.str.trim()).join(' ').trim();
      return { kind: 'anchor', page: pi, y: d.y, date: toISO(d.str.trim()), amount: amt ? signed(amt.str) : null, label, rowItems: new Set(row) };
    }).filter((a) => a.amount != null && a.date && a.date !== '0000-00-00');

    // linhas de histórico: texto na coluna "Histórico" que não é rótulo de saldo na própria linha da âncora
    const used = new Set(anchors.flatMap((a) => (BALANCE_LABEL.test(a.label) ? [...a.rowItems] : [])));
    const histItems = body.filter((i) => i.x >= histX && i.x < valX && !used.has(i));
    const lines = [];
    for (const it of histItems.sort((a, b) => b.y - a.y || a.x - b.x)) {
      const l = lines.find((q) => Math.abs(q.y - it.y) < 1.5);
      if (l) l.parts.push(it.str.trim()); else lines.push({ kind: 'line', page: pi, y: it.y, parts: [it.str.trim()] });
    }
    for (const l of lines) l.text = l.parts.join(' ');
    // texto na própria linha do valor: com data/hora é o detalhe; sem data/hora é o tipo da operação
    for (const a of anchors) {
      const i = lines.findIndex((l) => Math.abs(l.y - a.y) < 1.5);
      if (i >= 0 && !BALANCE_LABEL.test(a.label)) { a.rowLine = lines[i].text; lines.splice(i, 1); }
    }
    // ordem: y decrescente; com y igual, a âncora vem antes (o detalhe na mesma linha pertence a ela)
    stream.push(...[...anchors, ...lines].sort((a, b) => b.y - a.y || (a.kind === 'anchor' ? -1 : 1)));
  });

  const txns = []; let opening = null, closing = null; const daily = [];
  for (let k = 0; k < stream.length; k++) {
    const a = stream[k];
    if (a.kind !== 'anchor') continue;
    // linhas entre esta âncora e a próxima: a última é o tipo da próxima transação; o resto é detalhe desta
    let j = k + 1; const between = [];
    while (j < stream.length && stream[j].kind === 'line') { between.push(stream[j]); j++; }
    const next = stream[j];
    const nextIsTxn = next && next.kind === 'anchor' && !BALANCE_LABEL.test(next.label);
    const nextOwnType = nextIsTxn && next.rowLine && !STAMP.test(next.rowLine);
    const detail = nextIsTxn && !nextOwnType ? between.slice(0, -1) : between;
    if (nextIsTxn && !nextOwnType && between.length) next._type = between[between.length - 1].text;
    if (BALANCE_LABEL.test(a.label)) {
      const lab = a.label.toLowerCase();
      if (lab === 'saldo anterior') opening = { date: a.date, amount: round2(a.amount) };
      else if (lab === 'saldo do dia') daily.push({ date: a.date, amount: round2(a.amount) });
      else closing = { date: a.date, amount: round2(a.amount) };
      continue;
    }
    let type = a._type ?? '';
    const det = detail.map((l) => l.text);
    if (a.rowLine) { if (STAMP.test(a.rowLine)) det.unshift(a.rowLine); else type = a.rowLine; }
    if (!type && det.length && !STAMP.test(det[0])) type = det.shift();
    txns.push({ date: a.date, amount: round2(a.amount), type, detail: cleanDetail(det) });
  }
  return finish(txns, opening, closing, daily);
}

function finish(txns, opening, closing, daily) {
  const out = txns.map((t) => ({ date: t.date, amount: t.amount, desc: [t.type, t.detail].filter(Boolean).join(' · ') }));
  // conferência: saldo anterior + soma dos lançamentos = saldo final do próprio PDF
  let check = null;
  if (opening && closing) {
    const sum = round2(out.reduce((s, t) => s + t.amount, 0));
    const expected = round2(closing.amount - opening.amount);
    // cada "Saldo do dia" do PDF também precisa fechar com a soma acumulada (pega lançamento no dia errado)
    const badDays = daily.filter((d) => Math.abs(out.filter((t) => t.date <= d.date).reduce((a, t) => a + t.amount, opening.amount) - d.amount) >= 0.006).map((d) => d.date);
    check = { ok: Math.abs(sum - expected) < 0.005 && !badDays.length, sum, expected, count: out.length, days: daily.length, badDays };
  }
  return { format: 'pdf', account: 'banco', txns: out, balance: closing, opening, daily, check };
}

// ---- leitura do arquivo no navegador (pdf.js carregado só quando você escolhe um PDF) ----
export async function parsePDF(buffer) {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    pages.push({ items: tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5] })) });
  }
  const parsed = parseBBItems(pages);
  if (!parsed.txns.length) throw new Error('Não encontrei lançamentos nesse PDF. Ele é o extrato da conta corrente do BB? Se for outro formato, mande um exemplo.');
  return parsed;
}
