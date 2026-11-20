// Leitor de OFX (versões 1.x em SGML e 2.x em XML). Devolve lançamentos com valor com sinal.
import { parseDateAny } from './util.js';

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}
const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function looksLikeOFX(text) {
  return /<OFX>/i.test(text) || /OFXHEADER/i.test(text);
}

export function parseOFX(text) {
  const body = text.slice(Math.max(0, text.search(/<OFX>/i)));
  const isCard = /<CREDITCARDMSGSRSV1>|<CCSTMTRS>/i.test(body);
  const txns = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
  let m;
  while ((m = re.exec(body))) {
    const b = m[1];
    const date = parseDateAny(tag(b, 'DTPOSTED'));
    const amt = Number(tag(b, 'TRNAMT').replace(',', '.'));
    if (!date || !Number.isFinite(amt)) continue;
    const name = decodeEntities(tag(b, 'NAME'));
    const memo = decodeEntities(tag(b, 'MEMO'));
    const parts = [name, memo].filter(Boolean);
    const desc = (parts.length === 2 && parts[0] === parts[1]) ? parts[0] : parts.join(' - ');
    txns.push({ date, amount: Math.round(amt * 100) / 100, desc: desc || tag(b, 'TRNTYPE') || 'Sem descrição', fitid: tag(b, 'FITID') });
  }
  let balance = null;
  const lb = body.match(/<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i);
  if (lb) {
    const amt = Number(tag(lb[1], 'BALAMT').replace(',', '.'));
    const date = parseDateAny(tag(lb[1], 'DTASOF'));
    if (Number.isFinite(amt)) balance = { amount: Math.round(amt * 100) / 100, date };
  }
  const bankId = tag(body, 'BANKID');
  const acctId = tag(body, 'ACCTID');
  return { format: 'ofx', account: isCard ? 'cartao' : 'banco', bankId, acctId, txns, balance };
}
