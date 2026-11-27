import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SAVED_SUPPLIERS_KEY, THEME_KEY, api, payloadFor } from './api.js';
import HistoryRail from './components/HistoryRail.jsx';
import JobForm from './components/JobForm.jsx';
import ResultsTable from './components/ResultsTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import Topbar from './components/Topbar.jsx';

function readInitialSuppliers() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_SUPPLIERS_KEY)) || [];
  } catch {
    return [];
  }
}

function readInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Private mode: fall back to system preference.
  }
  return null;
}

function defaultFormNote(mode) {
  return mode === 'demo'
    ? 'A simulação usa dados de exemplo e não altera a planilha.'
    : 'Os produtos confirmados são gravados na planilha com lucro FBM e FBA.';
}

function updateBrowserUrl(id, push) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('job', id);
  else url.searchParams.delete('job');
  const next = url.pathname + url.search;
  if (push) window.history.pushState({ job: id }, '', next);
  else window.history.replaceState({ job: id }, '', next);
}

export default function App() {
  const [savedTheme, setSavedTheme] = useState(readInitialTheme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [setupData, setSetupData] = useState(null);
  const [setupError, setSetupError] = useState('');
  const [mode, setMode] = useState('demo');
  const [suppliers, setSuppliers] = useState(readInitialSuppliers);
  const [history, setHistory] = useState([]);
  const [currentJobId, setCurrentJobId] = useState('');
  const [activeJob, setActiveJob] = useState(null);
  const [filter, setFilter] = useState('all');
  const [submitting, setSubmitting] = useState(false);
  const [formNote, setFormNote] = useState(() => defaultFormNote('demo'));
  const [formNoteError, setFormNoteError] = useState(false);

  const activeJobIdRef = useRef('');
  const pollTimerRef = useRef(null);
  const resultsRef = useRef(null);

  const isDark = savedTheme ? savedTheme === 'dark' : systemDark;

  useEffect(() => {
    if (savedTheme === 'dark' || savedTheme === 'light') {
      document.documentElement.dataset.theme = savedTheme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#0d1317' : '#f3f5f7');
  }, [savedTheme, isDark]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => setSystemDark(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const handleToggleTheme = () => {
    const next = isDark ? 'light' : 'dark';
    setSavedTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode: applies only for this session.
    }
  };

  const handleSuppliersChange = useCallback((nextOrUpdater) => {
    setSuppliers((prev) => {
      const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(prev) : nextOrUpdater;
      try {
        localStorage.setItem(SAVED_SUPPLIERS_KEY, JSON.stringify(next));
      } catch {
        // Private mode: list stays in memory.
      }
      return next;
    });
  }, []);

  const showError = useCallback((message) => {
    setFormNote(message);
    setFormNoteError(true);
  }, []);

  const resetFormNote = useCallback((nextMode) => {
    const targetMode = nextMode ?? mode;
    setFormNote(defaultFormNote(targetMode));
    setFormNoteError(false);
  }, [mode]);

  const refreshHistory = useCallback(async () => {
    const jobs = await api('/api/jobs');
    setHistory(jobs);
  }, []);

  const selectJob = useCallback(async (id, { push = false } = {}) => {
    activeJobIdRef.current = id;
    setCurrentJobId(id);
    clearTimeout(pollTimerRef.current);
    updateBrowserUrl(id, push);
    try {
      const job = await api(`/api/jobs/${id}`);
      if (id !== activeJobIdRef.current) return;
      setActiveJob(job);
      await refreshHistory();
      if (id === activeJobIdRef.current && (job.status === 'running' || job.status === 'queued')) {
        pollTimerRef.current = setTimeout(() => {
          selectJob(id, { push: false });
        }, 1500);
      }
    } catch (error) {
      showError(error.message);
    }
  }, [refreshHistory, showError]);

  const loadSetup = useCallback(async () => {
    setSetupError('');
    try {
      const data = await api('/api/setup');
      setSetupData(data);
      const nextMode = data.remote_worker
        ? 'input'
        : data.keepa
          ? 'keepa'
          : data.sheets
            ? 'input'
            : 'demo';
      setMode(nextMode);
      setFormNote(defaultFormNote(nextMode));
      setFormNoteError(false);
      await refreshHistory();
      const initialJob = new URLSearchParams(window.location.search).get('job');
      if (initialJob) await selectJob(initialJob, { push: false });
    } catch (error) {
      setSetupData(null);
      setSetupError(
        `${error.message} Verifique se o servidor local está em execução e tente novamente.`,
      );
    }
  }, [refreshHistory, selectJob]);

  useEffect(() => {
    loadSetup();
    return () => clearTimeout(pollTimerRef.current);
  }, [loadSetup]);

  useEffect(() => {
    const onPopState = () => {
      const id = new URLSearchParams(window.location.search).get('job');
      if (id) {
        selectJob(id, { push: false });
      } else {
        activeJobIdRef.current = '';
        setCurrentJobId('');
        setActiveJob(null);
        clearTimeout(pollTimerRef.current);
        refreshHistory().catch(() => {});
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectJob, refreshHistory]);

  const handleModeChange = (nextMode) => {
    setMode(nextMode);
    resetFormNote(nextMode);
  };

  const handleSubmitJob = async ({ brand, limit, mode: jobMode, input }) => {
    setSubmitting(true);
    try {
      const job = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand,
          limit,
          mode: jobMode,
          input,
          suppliers: suppliers.map(payloadFor),
        }),
      });
      setFilter('all');
      await selectJob(job.id, { push: true });
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior, block: 'nearest' });
      }, 0);
    } catch (error) {
      showError(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <a className="skip" href="#main">
        Ir para o conteúdo
      </a>

      <Topbar dark={isDark} onToggleTheme={handleToggleTheme} />

      <main id="main" className="frame">
        <StatusBar setupData={setupData} />

        {setupError && (
          <div id="setup-error" className="alert-banner" role="alert">
            <p id="setup-error-text">{setupError}</p>
            <button type="button" id="retry-setup" className="secondary" onClick={loadSetup}>
              Tentar novamente
            </button>
          </div>
        )}

        <div className="workbench">
          <JobForm
            known={setupData?.known || {}}
            mode={mode}
            onModeChange={handleModeChange}
            suppliers={suppliers}
            onSuppliersChange={handleSuppliersChange}
            disabled={!setupData}
            submitting={submitting}
            formNote={formNote}
            formNoteError={formNoteError}
            onClearFormNote={() => resetFormNote()}
            onShowFormError={showError}
            onSubmitJob={handleSubmitJob}
          />

          <HistoryRail
            jobs={history}
            currentJobId={currentJobId}
            onSelectJob={selectJob}
          />
        </div>

        <ResultsTable
          ref={resultsRef}
          job={activeJob}
          filter={filter}
          onFilterChange={setFilter}
        />
      </main>
    </>
  );
}
