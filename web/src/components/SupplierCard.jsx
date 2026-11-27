import React, { useRef, useState } from 'react';
import { api, asPattern, currency, payloadFor } from '../api.js';

export default function SupplierCard({
  supplier,
  dedicated,
  onUpdateSupplier,
  onRemoveLink,
}) {
  const [testing, setTesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const sampleRef = useRef(null);

  const handleNumberChange = (key, rawValue) => {
    const parsed = rawValue === '' ? null : Number(rawValue);
    onUpdateSupplier(supplier.domain, (prev) => ({ ...prev, [key]: parsed }));
  };

  const handleSampleChange = (value) => {
    onUpdateSupplier(supplier.domain, (prev) => ({ ...prev, sample: value }));
  };

  const runTest = async () => {
    const part = (supplier.sample || '').trim();
    if (!part) {
      setStatusMessage({ ok: false, text: 'Digite um part number que este site venda.' });
      sampleRef.current?.focus();
      return;
    }

    const updatedLinks = [...new Set(supplier.links.map((link) => asPattern(link, part)))];
    onUpdateSupplier(supplier.domain, (prev) => ({
      ...prev,
      links: updatedLinks,
      sample: part,
    }));

    setTesting(true);
    setStatusMessage({ ok: null, text: 'Lendo o site do fornecedor. Pode levar até um minuto.' });

    let check;
    try {
      const result = await api('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          part,
          supplier: payloadFor({ ...supplier, links: updatedLinks }),
        }),
      });
      if (!result.found) {
        check = {
          ok: false,
          text: 'Nada encontrado para esse código ou sem estoque. Cole o link da página do produto ou de uma busca feita no site.',
        };
      } else {
        const enough = result.stock >= result.minimum;
        check = {
          ok: enough,
          link: result.link,
          text: `Leu ${currency.format(result.price)} e ${result.stock}${result.floor ? '+' : ''} peças.${enough ? '' : ` Abaixo do mínimo de ${result.minimum}.`}`,
        };
      }
    } catch (error) {
      check = { ok: false, text: error.message };
    }

    setTesting(false);
    setStatusMessage(null);
    onUpdateSupplier(supplier.domain, (prev) => ({ ...prev, check }));
  };

  const activeOutput = statusMessage || supplier.check || null;
  const outputClass = activeOutput
    ? `test-result${activeOutput.ok === true ? ' ok' : activeOutput.ok === false ? ' error' : ''}`
    : 'test-result';

  return (
    <li className="supplier">
      <div className="supplier-head">
        <strong>{dedicated?.name || supplier.domain}</strong>
        <span className="status-tag">{dedicated ? 'Leitor dedicado' : 'Leitor genérico'}</span>
      </div>

      <ul className="link-list">
        {supplier.links.map((link) => (
          <li key={link}>
            <span>{link}</span>
            <button
              type="button"
              className="quiet"
              aria-label={`Remover ${link}`}
              onClick={() => onRemoveLink(supplier.domain, link)}
            >
              Remover
            </button>
          </li>
        ))}
      </ul>

      {dedicated && (
        <small>Este site tem leitor próprio: o robô monta a busca pelo código da peça.</small>
      )}

      <div className="terms">
        <label>
          Frete (US$)
          <input
            type="number"
            min="0"
            max="10000"
            step="0.01"
            required
            value={supplier.shipping ?? ''}
            onChange={(e) => handleNumberChange('shipping', e.target.value)}
          />
        </label>
        <label>
          Prazo (dias)
          <input
            type="number"
            min="0"
            max="365"
            step="1"
            required
            value={supplier.handling ?? ''}
            onChange={(e) => handleNumberChange('handling', e.target.value)}
          />
        </label>
      </div>

      <div className="test-row">
        <label>
          Testar com um part number
          <input
            ref={sampleRef}
            type="text"
            maxLength={80}
            autoComplete="off"
            value={supplier.sample || ''}
            onChange={(e) => handleSampleChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              runTest();
            }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={testing}
          onClick={runTest}
        >
          {testing ? 'Testando...' : 'Testar'}
        </button>
      </div>

      <p className={outputClass} role="status">
        {activeOutput && (
          <>
            {activeOutput.text}{' '}
            {activeOutput.link && (
              <a href={activeOutput.link} target="_blank" rel="noopener noreferrer">
                Abrir produto lido
              </a>
            )}
          </>
        )}
      </p>
    </li>
  );
}
