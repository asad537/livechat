// ─── Self-executing embed entry ──────────────────────────────
// <script src="http://localhost:4000/widget.js" data-livechat-key="wk_..." async></script>
// Optional: data-livechat-server="https://chat.example.com"
// Renders the Preact app inside a Shadow DOM root so host-page
// styles can never leak in (and ours never leak out).

import { render } from 'preact';
import { App } from './app';
import { WIDGET_CSS } from './styles';

const HOST_ID = 'livechat-widget-host';

function findScript(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement && current.getAttribute('data-livechat-key')) {
    return current;
  }
  return document.querySelector<HTMLScriptElement>('script[data-livechat-key]');
}

function resolveServer(script: HTMLScriptElement): string {
  const explicit = script.getAttribute('data-livechat-server');
  if (explicit) return explicit.replace(/\/+$/, '');
  try {
    return new URL(script.src, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
}

function mount(widgetKey: string, server: string): void {
  if (document.getElementById(HOST_ID)) return; // embed once
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = WIDGET_CSS;
  shadow.appendChild(style);

  const root = document.createElement('div');
  shadow.appendChild(root);

  document.body.appendChild(host);
  render(<App server={server} widgetKey={widgetKey} />, root);
}

(function boot(): void {
  const script = findScript();
  if (!script) {
    console.warn('[livechat] widget: missing <script data-livechat-key="..."> tag');
    return;
  }
  const widgetKey = script.getAttribute('data-livechat-key');
  if (!widgetKey) {
    console.warn('[livechat] widget: empty data-livechat-key');
    return;
  }
  const server = resolveServer(script);
  if (document.body) {
    mount(widgetKey, server);
  } else {
    document.addEventListener('DOMContentLoaded', () => mount(widgetKey, server), { once: true });
  }
})();
