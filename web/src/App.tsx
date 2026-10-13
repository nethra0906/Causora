import { useEffect, useState } from 'react';
import { api, usePoll } from './api.ts';
import { Evaluation } from './pages/Evaluation.tsx';
import { InvestigationPage } from './pages/Investigation.tsx';
import { Overview } from './pages/Overview.tsx';

function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const route = useRoute();
  const health = usePoll(api.health, 3000);
  const failureMatch = /^#\/failure\/([^/?]+)/.exec(route);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Causora home">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="8" cy="16" r="4" fill="var(--svc-order)" />
            <circle cx="24" cy="8" r="4" fill="var(--svc-inventory)" />
            <circle cx="24" cy="24" r="4" fill="var(--svc-payment)" />
            <path d="M12 15l8-6M12 17l8 6" stroke="var(--muted)" strokeWidth="2" />
          </svg>
          <span>Causora</span>
        </a>
        <nav aria-label="Primary">
          <a href="#/" className={route === '#/' || failureMatch ? 'active' : ''}>Failures &amp; Fault Lab</a>
          <a href="#/evaluation" className={route.startsWith('#/evaluation') ? 'active' : ''}>Evaluation</a>
        </nav>
        <div className="spacer" />
        <div className="pills" aria-label="Stack health">
          {health.data?.services.map((s) => (
            <span key={s.name} className={`pill ${s.up ? 'ok' : 'down'}`} title={s.up ? 'up' : 'down'}>
              {s.name.replace('-service', '')}: {s.up ? 'up' : 'down'}
            </span>
          ))}
          {health.error && <span className="pill down">platform unreachable</span>}
          {health.data && <span className="pill dim">{health.data.events} events · {health.data.edges} edges</span>}
        </div>
      </header>
      <main>
        {failureMatch ? <InvestigationPage failureId={failureMatch[1]!} /> : route.startsWith('#/evaluation') ? <Evaluation health={health.data} /> : <Overview health={health.data} />}
      </main>
    </div>
  );
}
