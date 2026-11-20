// Ciclo do cartão: a compra de um dia cai na fatura que vence em determinada data.
import { addMonths, dateInMonth, monthOf } from './util.js';

export function cardDueFor(dateISO, config) {
  const close = config.cardCloseDay ?? 8;
  const due = config.cardDueDay ?? 16;
  const ym = monthOf(dateISO);
  const day = Number(dateISO.slice(8, 10));
  const closingMonth = day <= close ? ym : addMonths(ym, 1);
  const dueMonth = due > close ? closingMonth : addMonths(closingMonth, 1);
  return dateInMonth(dueMonth, due);
}
