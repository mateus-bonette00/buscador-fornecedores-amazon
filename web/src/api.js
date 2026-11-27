export const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
export const percent = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const dates = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export const STATES = {
  queued: 'Na fila',
  running: 'Pesquisando',
  done: 'Concluído',
  error: 'Interrompido',
};

export const JOB_OUTCOMES = {
  no_writes: 'Sem gravações',
  partial_write: 'Gravado com pendências',
};

export const OUTCOMES = {
  written: 'Gravado',
  pending: 'Pendente',
  demo: 'Simulado',
  ready: 'Pronto para gravar',
};

export const TIMINGS = {
  Today: 'Envio hoje',
  Tomorrow: 'Dia seguinte',
  Estoque: 'Em estoque',
};

export const DEFAULT_PREP = 7;
export const DEFAULT_FBA_FEE = 6;
export const AMAZON_FEE_RATE = 0.15;
export const SAVED_SUPPLIERS_KEY = 'fornecedores';
export const THEME_KEY = 'tema';

export async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Falha de conexão com o painel.');
  return data;
}

export function domainOf(link) {
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname.includes('.')
      ? url.hostname.replace(/^www\./, '')
      : '';
  } catch {
    return '';
  }
}

export function asPattern(link, part) {
  const cut = link.search(/\?|;q=/);
  if (cut < 0) return link;
  const escaped = encodeURIComponent(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return link.slice(0, cut) + link.slice(cut).replace(new RegExp(`(=)${escaped}(?=$|[&;#])`, 'gi'), '$1{part}');
}

export function payloadFor({ links, shipping, handling }) {
  return { links, shipping, handling };
}

export function profitBreakdown(item) {
  const sale = Number(item.sold_for);
  const cost = Number(item.price);
  if (!sale || Number.isNaN(cost)) return null;
  const shipping = Number(item.shipping || 0);
  const verified = item.margin !== undefined && item.fba_margin !== undefined;
  const fbmMargin = verified
    ? item.margin
    : (sale - cost - DEFAULT_PREP - shipping - sale * AMAZON_FEE_RATE) / sale;
  const fbaMargin = verified
    ? item.fba_margin
    : (sale - cost - DEFAULT_PREP - shipping - sale * AMAZON_FEE_RATE - DEFAULT_FBA_FEE) / sale;
  return {
    verified,
    fbmProfit: sale * fbmMargin,
    fbmMargin,
    fbaProfit: sale * fbaMargin,
    fbaMargin,
  };
}
