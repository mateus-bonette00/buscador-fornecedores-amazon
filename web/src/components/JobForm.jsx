import React, { useRef, useState } from 'react';
import { domainOf } from '../api.js';
import SupplierCard from './SupplierCard.jsx';

export default function JobForm({
  known,
  mode,
  onModeChange,
  suppliers,
  onSuppliersChange,
  disabled,
  submitting,
  formNote,
  formNoteError,
  onClearFormNote,
  onShowFormError,
  onSubmitJob,
}) {
  const [brand, setBrand] = useState('SMC');
  const [limit, setLimit] = useState(8);
  const [inputText, setInputText] = useState('');
  const [newLinksText, setNewLinksText] = useState('');
  const [linkError, setLinkError] = useState('');
  const newLinkRef = useRef(null);

  const isDemo = mode === 'demo';
  const isKeepa = mode === 'keepa';
  const isInput = mode === 'input';

  const handleAddLinks = () => {
    const rejected = [];
    let added = 0;
    const nextSuppliers = suppliers.map((s) => ({ ...s, links: [...s.links] }));

    for (const text of newLinksText.split(/\s+/).filter(Boolean)) {
      const link = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
      const domain = domainOf(link);
      let supplier = nextSuppliers.find((item) => item.domain === domain);
      if (!domain || (!supplier && nextSuppliers.length === 8) || supplier?.links.length === 10) {
        rejected.push(text);
        continue;
      }
      if (!supplier) {
        const { shipping = 40, handling = 5 } = known[domain] || {};
        supplier = { domain, links: [], shipping, handling };
        nextSuppliers.push(supplier);
      }
      if (!supplier.links.includes(link)) {
        supplier.links.push(link);
        added += 1;
      }
    }

    setNewLinksText(rejected.join('\n'));
    setLinkError(
      rejected.length
        ? 'Não foi possível adicionar o que ficou no campo. Use links https de um site válido (até 8 sites e 10 links por site).'
        : '',
    );
    if (added) onClearFormNote();
    onSuppliersChange(nextSuppliers);
  };

  const handleUpdateSupplier = (domain, updater) => {
    onSuppliersChange((prev) =>
      prev.map((item) => (item.domain === domain ? updater(item) : item)),
    );
  };

  const handleRemoveLink = (domain, link) => {
    onSuppliersChange((prev) =>
      prev
        .map((item) => {
          if (item.domain !== domain) return item;
          const remaining = item.links.filter((itemLink) => itemLink !== link);
          const copy = { ...item, links: remaining };
          delete copy.check;
          return copy;
        })
        .filter((item) => item.links.length > 0),
    );
    newLinkRef.current?.focus();
  };

  const handleFileChange = async (event) => {
    const [file] = event.target.files || [];
    if (!file) return;
    if (file.size <= 120000) {
      setInputText(await file.text());
      onClearFormNote();
    } else {
      event.target.value = '';
      onShowFormError('O CSV excede 120 kB. Divida o arquivo em lotes menores.');
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    onClearFormNote();
    if (!isDemo && !suppliers.length) {
      onShowFormError('Adicione pelo menos um link de fornecedor antes de pesquisar.');
      newLinkRef.current?.focus();
      return;
    }
    onSubmitJob({
      brand,
      limit: Number(limit),
      mode,
      input: inputText,
    });
  };

  return (
    <section className="composer" aria-labelledby="new-heading">
      <div className="section-head">
        <h2 id="new-heading">Novo lote</h2>
      </div>
      <form id="job-form" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>
            Marca
            <input
              name="brand"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Ex.: SMC"
              maxLength={80}
              autoComplete="off"
              required
            />
          </label>
          <label>
            Limite
            <input
              name="limit"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              min={1}
              max={500}
              inputMode="numeric"
              required
            />
          </label>
        </div>

        <label>
          Origem dos anúncios
          <select
            name="mode"
            id="mode"
            value={mode}
            onChange={(e) => onModeChange(e.target.value)}
          >
            <option value="demo">Simulação</option>
            <option value="keepa">Consulta no Keepa</option>
            <option value="input">CSV do Keepa, ASINs ou links Amazon</option>
          </select>
        </label>

        {!isDemo && (
          <div id="source" className="source-block">
            {isInput && (
              <label id="file-label" className="file-field">
                Importar CSV do Keepa
                <input type="file" id="file" accept=".csv,text/csv" onChange={handleFileChange} />
              </label>
            )}
            <label>
              <span id="source-label">
                {isKeepa ? 'Filtros do Product Finder (JSON)' : 'CSV, ASINs ou links'}
              </span>
              <textarea
                name="input"
                rows={4}
                aria-describedby="source-hint"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
              />
            </label>
            <small id="source-hint">
              {isKeepa
                ? 'Cole o JSON de Show API query. Se ficar em branco, busca pela marca informada.'
                : 'Cole o CSV exportado do Keepa ou insira um ASIN ou link amazon.com por linha.'}
            </small>
          </div>
        )}

        {!isDemo && (
          <fieldset id="supplier-fields" className="supplier-section">
            <legend>Fornecedores</legend>
            <label htmlFor="new-link">Links dos sites onde o robô deve procurar</label>
            <div className="add-row">
              <textarea
                ref={newLinkRef}
                id="new-link"
                rows={2}
                aria-describedby="link-hint link-error"
                aria-invalid={linkError ? 'true' : 'false'}
                placeholder="https://www.fornecedor.com/..."
                value={newLinksText}
                onChange={(e) => setNewLinksText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return;
                  e.preventDefault();
                  handleAddLinks();
                }}
              />
              <button type="button" id="add-link" className="secondary" onClick={handleAddLinks}>
                Adicionar
              </button>
            </div>
            <small id="link-hint">
              Cole um ou vários links de produto, busca, categoria ou página inicial. Links do mesmo site ficam agrupados.
            </small>
            {linkError && (
              <p id="link-error" className="note error" role="alert">
                {linkError}
              </p>
            )}
            {suppliers.length === 0 && (
              <p id="supplier-empty" className="empty">
                Nenhum fornecedor adicionado. Cole um link acima e use Testar para confirmar o que o robô consegue ler.
              </p>
            )}
            <ul id="suppliers" className="supplier-list">
              {suppliers.map((supplier) => (
                <SupplierCard
                  key={supplier.domain}
                  supplier={supplier}
                  dedicated={known[supplier.domain]}
                  onUpdateSupplier={handleUpdateSupplier}
                  onRemoveLink={handleRemoveLink}
                />
              ))}
            </ul>
          </fieldset>
        )}

        <div className="form-actions">
          <button id="run" className="primary" type="submit" disabled={disabled || submitting}>
            {isDemo ? 'Iniciar simulação' : 'Pesquisar e gravar'}
          </button>
          <p id="form-note" className={`note${formNoteError ? ' error' : ''}`} role="status">
            {formNote}
          </p>
        </div>
      </form>
    </section>
  );
}
