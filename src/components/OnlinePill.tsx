import { useEffect, useState } from 'react';

type OnlineState = 'checking' | 'online' | 'offline';
const PING_URL = 'https://www.gstatic.com/generate_204';

export function OnlinePill() {
  const [state, setState] = useState<OnlineState>(navigator.onLine ? 'checking' : 'offline');

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const check = async () => {
      if (!navigator.onLine) {
        setState('offline');
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 4000);
      try {
        const response = await fetch(PING_URL, {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (active) setState(response.type === 'opaque' || response.ok ? 'online' : 'offline');
      } catch {
        if (active) setState('offline');
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const onOnline = () => void check();
    const onOffline = () => setState('offline');
    void check();
    const interval = window.setInterval(() => void check(), 30_000);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const label = state === 'checking' ? 'Checking connection' : state === 'online' ? 'Online' : 'Offline';
  return <span className={`online-pill ${state}`} role="status" aria-live="polite">{label}</span>;
}
