import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newState, importParsed } from '../src/ledger.js';
import { parseOFX } from '../src/ofx.js';
import { pullState, pushState, rowsFromState } from '../src/sheets.js';

const seed = JSON.parse(readFileSync(new URL('../seed.json', import.meta.url)));
const ofx = readFileSync(new URL('../samples/extrato-exemplo.ofx', import.meta.url), 'latin1');

test('envia o estado e o espelho legível; recebe de volta', async () => {
  const { state } = importParsed(newState(seed), parseOFX(ofx));
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => (sent.body.action === 'pull' ? { ok: true, state: sent.body.token === 'x' ? JSON.stringify(state) : null, updatedAt: 'agora' } : { ok: true }) };
  };
  try {
    await pushState({ url: 'https://exemplo/exec', token: 'x' }, state);
    assert.equal(sent.init.headers['Content-Type'], 'text/plain;charset=utf-8'); // evita pré-voo de CORS
    assert.equal(sent.body.action, 'push');
    assert.equal(sent.body.lancamentos.length, 25); // cabeçalho + 24
    assert.deepEqual(sent.body.lancamentos[0].slice(0, 3), ['id', 'data', 'valor']);
    assert.equal(JSON.parse(sent.body.state).txns.length, 24);
    const back = await pullState({ url: 'https://exemplo/exec', token: 'x' });
    assert.equal(back.state.txns.length, 24);
  } finally { globalThis.fetch = realFetch; }
});

test('erro da planilha vira mensagem', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'Senha incorreta.' }) });
  try { await assert.rejects(() => pushState({ url: 'u', token: 'errado' }, newState(seed)), /Senha incorreta/); } finally { globalThis.fetch = realFetch; }
});

test('linhas legíveis têm uma linha por lançamento', () => {
  const { state } = importParsed(newState(seed), parseOFX(ofx));
  assert.equal(rowsFromState(state).length, 25);
});
