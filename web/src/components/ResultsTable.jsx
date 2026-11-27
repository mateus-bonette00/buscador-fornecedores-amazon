import React, { forwardRef } from 'react';
import { JOB_OUTCOMES, OUTCOMES, STATES, TIMINGS, currency, percent, profitBreakdown } from '../api.js';

function EmptyDash() {
  return (
    <span className="empty-cell" aria-label="Sem valor">
      -
    </span>
  );
}

function ProfitLine({ label, value, margin }) {
  const cls = value > 0
    ? 'profit-value positive'
    : value < 0
      ? 'profit-value negative'
      : 'profit-value';
  return (
    <div className="profit-line">
      <span className="profit-model">{label}</span>
      <span className={cls}>{currency.format(value)}</span>
      <span className="profit-pct">{`${percent.format(margin * 100)}%`}</span>
    </div>
  );
}

const ResultsTable = forwardRef(function ResultsTable({ job, filter, onFilterChange }, ref) {
  if (!job) return null;

  const isDemo = job.mode === 'demo';
  const confirmed = job.items.filter((item) => item.status !== 'pending').length;
  const pending = job.items.filter((item) => item.status === 'pending').length;

  let statusClass = 'status-tag';
  if (job.status === 'error') statusClass += ' error';
  else if (job.outcome) statusClass += ' pending';
  else if (job.status === 'done') statusClass += ' ready';

  const visibleItems = job.items.filter((item) => {
    if (filter === 'ok') return item.status !== 'pending';
    if (filter === 'pending') return item.status === 'pending';
    return true;
  });

  let emptyMessage = 'Nenhum produto neste filtro.';
  if (!job.items.length) {
    if (job.status === 'queued' || job.status === 'running') emptyMessage = 'Pesquisando produtos...';
    else if (job.status === 'error') emptyMessage = 'Nenhum produto foi pesquisado.';
    else emptyMessage = 'Nenhum produto encontrado neste lote.';
  }

  return (
    <section id="results" ref={ref} className="ledger" aria-labelledby="results-heading">
      <div className="ledger-head">
        <div>
          <div className="ledger-title-row">
            <h2 id="results-heading">
              {isDemo ? 'Resultado da simulação' : `Lote ${job.brand}`}
            </h2>
            <span id="job-status" className={statusClass}>
              {JOB_OUTCOMES[job.outcome] || STATES[job.status]}
            </span>
          </div>
          <p id="job-progress" className="ledger-sub" role="status">
            {`${job.items.length} de ${job.total} produtos pesquisados`}
          </p>
        </div>

        <div className="filter-bar" role="group" aria-label="Filtrar resultados por situação">
          {[
            ['all', 'Todos', job.items.length, 'count-all'],
            ['ok', 'Confirmados', confirmed, 'count-ok'],
            ['pending', 'Pendentes', pending, 'count-pending'],
          ].map(([key, label, count, id]) => (
            <button
              key={key}
              type="button"
              className="filter-btn"
              data-filter={key}
              aria-pressed={filter === key}
              onClick={() => onFilterChange(key)}
            >
              {label} <span id={id}>{count}</span>
            </button>
          ))}
        </div>
      </div>

      {job.message && (
        <p id="job-message" className="ledger-note">
          {job.message}
        </p>
      )}

      <div className="table-scroll" tabIndex={0} aria-label="Tabela de produtos pesquisados">
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Produto</th>
              <th scope="col" className="num">Pack</th>
              <th scope="col">Fornecedores e estoque</th>
              <th scope="col" className="num">Custo</th>
              <th scope="col" className="num">Venda</th>
              <th scope="col">Lucro FBM / FBA</th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody id="product-list">
            {visibleItems.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visibleItems.map((item) => {
                const offerEntries = Object.entries(item.offers || {});
                const calc = profitBreakdown(item);
                return (
                  <tr key={item.asin}>
                    <td>
                      <div>
                        <span className="part-code">{item.part || item.asin}</span>
                        {item.part && item.asin && (
                          <span className="asin-code">{item.asin}</span>
                        )}
                      </div>
                      {item.title && <p className="item-title">{item.title}</p>}
                    </td>

                    <td className="num">
                      {item.pack ? String(item.pack) : <EmptyDash />}
                    </td>

                    <td>
                      {item.supplier && (
                        <a
                          href={item.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="winner-link"
                        >
                          {item.supplier}
                        </a>
                      )}
                      {offerEntries.length > 0 ? (
                        <ul className="offer-grid">
                          {offerEntries.map(([name, offerItem]) => {
                            const detail = offerItem.stock === undefined
                              ? offerItem.detail
                              : `${offerItem.stock}${offerItem.floor ? '+' : ''} un, ${currency.format(offerItem.price)}, ${TIMINGS[offerItem.timing] || offerItem.timing}`;
                            return (
                              <li key={name}>
                                <span className="offer-name">{name}</span>
                                <span className="offer-detail">{detail}</span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <EmptyDash />
                      )}
                    </td>

                    <td className="num">
                      {item.price ? (
                        <>
                          {currency.format(item.price)}
                          {item.shipping && (
                            <span className="cost-sub">
                              {`Frete ${currency.format(item.shipping)}`}
                            </span>
                          )}
                        </>
                      ) : (
                        <EmptyDash />
                      )}
                    </td>

                    <td className="num">
                      {item.sold_for ? (
                        <span className="sale-price">{currency.format(item.sold_for)}</span>
                      ) : (
                        <EmptyDash />
                      )}
                    </td>

                    <td>
                      {calc ? (
                        <div className="profit-compare">
                          <ProfitLine label="FBM" value={calc.fbmProfit} margin={calc.fbmMargin} />
                          <ProfitLine label="FBA" value={calc.fbaProfit} margin={calc.fbaMargin} />
                          <span className="profit-basis">
                            {calc.verified ? 'Confirmado na planilha' : 'Estimativa padrão'}
                          </span>
                        </div>
                      ) : (
                        <EmptyDash />
                      )}
                    </td>

                    <td className="state-cell">
                      <span className={`status-tag ${item.status === 'pending' ? 'pending' : 'ready'}`}>
                        {OUTCOMES[item.status]}
                      </span>
                      {item.sheet_row && <small>{`Gravado na linha ${item.sheet_row}`}</small>}
                      {item.detail && <small>{item.detail}</small>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
});

export default ResultsTable;
