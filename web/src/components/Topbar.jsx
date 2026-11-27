import React from 'react';

export default function Topbar({ dark, onToggleTheme }) {
  return (
    <header className="topbar">
      <div className="frame topbar-inner">
        <a className="wordmark" href="/">
          <svg
            className="mark"
            viewBox="0 0 24 24"
            width="24"
            height="24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="square"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 9v12" />
          </svg>
          <span>Buscador de Fornecedores Amazon</span>
        </a>
        <div className="topbar-meta">
          <span className="market">Amazon EUA</span>
          <button
            type="button"
            id="theme-toggle"
            className="theme-toggle"
            aria-pressed={dark}
            onClick={onToggleTheme}
          >
            {dark ? 'Tema claro' : 'Tema escuro'}
          </button>
        </div>
      </div>
    </header>
  );
}
