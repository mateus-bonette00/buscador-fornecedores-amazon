import React from 'react';
import { JOB_OUTCOMES, STATES, dates } from '../api.js';

export default function HistoryRail({ jobs, currentJobId, onSelectJob }) {
  return (
    <aside className="history-rail" aria-labelledby="history-heading">
      <div className="section-head">
        <h2 id="history-heading">Histórico</h2>
        <span id="history-count" className="count-tag">
          {jobs.length ? String(jobs.length) : ''}
        </span>
      </div>
      <ul id="history" className="history">
        {jobs.length === 0 ? (
          <li className="empty-inline">
            Nenhum lote executado ainda. Inicie uma simulação ou um lote real ao lado.
          </li>
        ) : (
          jobs.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                aria-current={currentJobId === job.id ? 'true' : undefined}
                onClick={() => onSelectJob(job.id, { push: true })}
              >
                <span className="history-row-top">
                  <strong>{job.brand}</strong>
                  <span className="history-mode">{job.mode === 'demo' ? 'Simulação' : 'Real'}</span>
                </span>
                <span className="history-meta">
                  <span>{dates.format(job.created * 1000)}</span>
                  <span>{JOB_OUTCOMES[job.outcome] || STATES[job.status]}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}
