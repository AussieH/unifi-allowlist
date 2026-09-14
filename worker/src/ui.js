/** The whole visual layer: one card, theme-aware, no external assets. */

import { config } from './config.js';
import { esc } from './util.js';

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg:#f6f7f9; --card:#fff; --fg:#14161a; --muted:#5c6470; --line:#e2e5ea;
    --accent:#2f6fed; --accent-fg:#fff; --warn:#8a5a00; --warn-bg:#fff6e0;
    --discord:#5865f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1115; --card:#171a20; --fg:#e8eaee; --muted:#9aa2b1; --line:#272b33;
      --accent:#5b8dff; --accent-fg:#0b0d11; --warn:#f0c168; --warn-bg:#2a230f;
      --discord:#5865f2;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:34rem; margin:0 auto; padding:3rem 1.25rem 4rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:1.75rem; }
  h1 { margin:0 0 1rem; font-size:1.5rem; letter-spacing:-.01em; }
  p { margin:0 0 1rem; }
  .lead { font-size:1.05rem; }
  .muted { color:var(--muted); font-size:.925rem; }
  code { background:rgba(127,127,127,.14); padding:.1em .38em; border-radius:5px; font-size:.92em; }
  .ipbox { display:flex; flex-direction:column; gap:.3rem; align-items:center;
           border:1px solid var(--line); border-radius:10px; padding:1rem; margin:1.25rem 0; }
  .iplabel { font-size:.78rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
  .ip { font:600 1.4rem/1.2 ui-monospace,"Cascadia Code",Consolas,monospace;
        word-break:break-all; text-align:center; }
  button, .btn { display:block; width:100%; padding:.85rem 1rem; font-size:1rem; font-weight:600;
                 text-align:center; text-decoration:none; cursor:pointer; border:0; border-radius:10px;
                 background:var(--accent); color:var(--accent-fg); }
  button:hover, .btn:hover { filter:brightness(1.08); }
  .btn-discord { background:var(--discord); color:#fff; }
  .warn { background:var(--warn-bg); color:var(--warn); border-radius:9px; padding:.8rem .9rem;
          font-size:.9rem; margin-top:1.25rem; }
  .row { display:flex; gap:.6rem; align-items:center; justify-content:space-between;
         border-top:1px solid var(--line); padding:.6rem 0; font-size:.92rem; }
  footer { text-align:center; margin-top:1.5rem; font-size:.8rem; color:var(--muted); }
  footer a { color:var(--muted); }
`;

export function page(env, status, title, body, headers = {}) {
  const c = config(env);
  return new Response(
    `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — ${esc(c.siteName)}</title>
<style>${STYLE}</style>
</head><body><main>
<div class="card"><h1>${esc(title)}</h1>${body}</div>
<footer>${esc(c.siteName)} · access self-service</footer>
</main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        // The pages are one inline stylesheet and a form back to the same origin; nothing else may load or run.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        ...headers,
      },
    }
  );
}

export const notFoundPage = (env) =>
  page(env, 404, 'Not found', `
    <p class="lead">That link isn't valid.</p>
    <p class="muted">Check you copied the whole thing, or ask an admin for a fresh one.</p>`);

export const errorPage = (env, status, title, message) =>
  page(env, status, title, `<p class="lead">${esc(message)}</p>`);
