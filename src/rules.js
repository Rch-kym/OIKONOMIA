// Categorias (as mesmas da aba Config da planilha) e classificação automática.
import { normDesc, merchantKey } from './util.js';

export const CATS_OUT = ['Saúde', 'Educação', 'Telefone e internet', 'Moradia', 'Dívidas/Empréstimos', 'Cuidados pessoais', 'Assinaturas', 'Alimentação', 'Transporte', 'Lazer', 'Vestuário e pessoal', 'Casa', 'Presentes', 'Dízimo e ofertas', 'Trabalho/Ferramentas', 'Fatura do cartão', 'Transferências e repasses', 'Outros', 'Ignorado'];
export const CATS_IN = ['Salário', 'Freelance', 'Rendimentos', 'Vale Transporte', 'Vale Alimentação', 'Transferências e repasses', 'Outros', 'Ignorado'];

// Palpites por palavra-chave. Nunca são aplicados sem você confirmar uma vez.
const GUESSES = [
  [/posto|combust|gasolin|etanol|ipiranga|shell|petrobras/, 'Transporte'],
  [/uber|99 tecnologia|99pop|taxi/, 'Transporte'],
  [/supermerc|mercado|atacad|padaria|sorvet|pizza|lanch|restaur|cafe|ifood|churrasc|acai|hamburg|milk/, 'Alimentação'],
  [/farmac|drogar|droga |clinica|odonto|laborat|hospital/, 'Saúde'],
  [/netflix|spotify|xbox|youtube|google one|chatgpt|openai|anthropic|claude|disney|amazon prime/, 'Assinaturas'],
  [/faculdade|escola|curso|anhanguera|livraria/, 'Educação'],
  [/tim |claro|vivo|oi fibra|internet|provedor/, 'Telefone e internet'],
];

export function isOwnTransfer(desc, state) {
  const nd = normDesc(desc);
  const own = (state.config?.ownNames || []).map(normDesc).filter(Boolean);
  return own.some((n) => nd.includes(n)) && /pix|transf|ted|doc/.test(nd);
}
export function classify(desc, amount, state, acct = 'banco') {
  const nd = normDesc(desc);
  const mk = merchantKey(desc);
  const kindBySign = amount >= 0 ? 'in' : 'out';
  // Pix/transferência para ou de você mesmo (outra conta sua) não é renda nem gasto: vem antes de qualquer regra
  if (acct !== 'cartao' && isOwnTransfer(desc, state)) return { cat: 'Transferências e repasses', kind: 'transfer', status: 'ok', guess: '', why: 'entre as suas contas' };

  const rule = (state.rules || []).find((r) => r.key === mk);
  if (rule) return { cat: rule.cat, kind: rule.kind || kindBySign, status: 'ok', guess: '', why: 'regra' };

  if (acct === 'cartao') {
    if (amount > 0 && /pagamento|pagto|recebido|credito/.test(nd)) return { cat: 'Fatura do cartão', kind: 'transfer', status: 'ok', guess: '', why: 'pagamento da fatura' };
  } else {
    if (amount < 0 && (/(pagamento|pagto|pgto).*(cart|fatura)/.test(nd) || /fatura.*cart/.test(nd) || /^cartao de credito/.test(nd))) {
      return { cat: 'Fatura do cartão', kind: 'cardpay', status: 'ok', guess: '', why: 'pagamento de fatura' };
    }
    if (amount < 0 && /juros|iof|tarifa|encargo|anuidade|cesta de servico/.test(nd)) return { cat: 'Outros', kind: 'out', status: 'ok', guess: '', why: 'tarifa ou juros' };
  }

  for (const [re, cat] of GUESSES) if (re.test(nd + ' ')) return { cat: '', kind: kindBySign, status: 'review', guess: cat, why: 'palpite' };
  if (amount > 0 && /pix recebido|ted recebid|deposito|transferencia recebida/.test(nd)) return { cat: '', kind: 'in', status: 'review', guess: 'Freelance', why: 'palpite' };
  return { cat: '', kind: kindBySign, status: 'review', guess: '', why: 'sem regra' };
}
