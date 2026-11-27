import React from 'react';

export default function StatusBar({ setupData }) {
  const badges = !setupData
    ? []
    : setupData.remote_worker
      ? [{ label: 'Servidor homelab ativo', ready: true }]
      : [
          { label: `Keepa API: ${setupData.keepa ? 'configurado' : 'pendente'}`, ready: setupData.keepa },
          { label: `Google Sheets: ${setupData.sheets ? 'configurado' : 'pendente'}`, ready: setupData.sheets },
          { label: `VPN SMC EUA: ${setupData.smc ? 'configurado' : 'pendente'}`, ready: setupData.smc },
        ];

  return (
    <section className="status-bar" aria-labelledby="heading">
      <div className="status-title">
        <h1 id="heading">Pesquisa de produtos</h1>
        <p>Cruza anúncios da Amazon EUA via Keepa com fornecedores e calcula lucro FBM e FBA na planilha.</p>
      </div>
      <ul id="connections" className="connections" aria-label="Status das integrações">
        {badges.map((badge) => (
          <li key={badge.label} className={`status-tag ${badge.ready ? 'ready' : 'pending'}`}>
            {badge.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
