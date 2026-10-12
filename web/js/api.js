// api.js — shared helpers, API client, toasts, modal, DOM utils

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript: el('div.card', {onclick}, [children]) */
export function el(tag, attrs = {}, children = []) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// --------------------------------------------------------------------- toasts
export function toast(msg, kind = '') {
  const t = el(`div.toast${kind ? '.' + kind : ''}`, { text: msg });
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
}

// --------------------------------------------------------------------- modal
//
// Modals nest: the voice picker is opened *from* the agent create form, and both
// live in the same #modalBody. Without a stack, opening the picker replaces the
// form's nodes, and closing the picker shuts the whole overlay — so a user who
// clicked 🔍 halfway through naming an agent came back to an empty screen with
// their work gone. The outgoing panel is kept here instead, and `close()`
// restores it, re-attaching the *same* elements so every field still holds what
// was typed.
const modalStack = [];

export function modal({ title, body, footer, wide = false }) {
  const back = $('#modalBack'), m = $('#modal');
  const mb = $('#modalBody'), mf = $('#modalFoot');
  if (back.classList.contains('open')) {
    modalStack.push({
      title: $('#modalTitle').textContent,
      body: [...mb.childNodes],
      footer: [...mf.childNodes],
      footShown: mf.style.display !== 'none',
      wide: m.classList.contains('wide'),
    });
  }
  $('#modalTitle').textContent = title || '';
  mb.replaceChildren(...(Array.isArray(body) ? body : [body]));
  mf.replaceChildren(...(Array.isArray(footer) ? footer : (footer ? [footer] : [])));
  mf.style.display = (footer && (Array.isArray(footer) ? footer.length : true)) ? '' : 'none';
  m.classList.toggle('wide', wide);
  back.classList.add('open');
  return { close };
}

export function close() {
  const back = $('#modalBack'), m = $('#modal');
  const prev = modalStack.pop();
  if (prev) {                       // an outer modal is waiting underneath
    $('#modalTitle').textContent = prev.title;
    $('#modalBody').replaceChildren(...prev.body);
    $('#modalFoot').replaceChildren(...prev.footer);
    $('#modalFoot').style.display = prev.footShown ? '' : 'none';
    m.classList.toggle('wide', prev.wide);
    return;
  }
  back.classList.remove('open');
}

// --------------------------------------------------------------------- fetch
async function parse(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  if (ct.startsWith('audio/') || ct.includes('octet-stream')) return res.blob();
  return res.text();
}

export async function apiFetch(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail;
    try { detail = await res.json(); } catch { detail = await res.text().catch(() => res.statusText); }
    // A 401 from the studio's own password gate means the session expired or
    // never existed: go to the login page. A 401 from Fish (a missing or
    // rejected API key) must NOT do that, which is why the server marks the
    // gate with `login_required` rather than relying on the status code.
    if (res.status === 401 && detail?.login_required) {
      location.href = '/login';
      throw new Error('redirecting to sign in');
    }
    const msg = detail?.message || detail?.detail || (typeof detail === 'string' ? detail : '') || res.statusText;
    const err = new Error(`${res.status} · ${msg}`);
    err.status = res.status; err.detail = detail;
    throw err;
  }
  return raw ? res : parse(res);
}

/** Authenticated passthrough to any Fish Audio endpoint. */
export const fish = {
  get:  (path, q) => apiFetch(`/api/fish/${path}${q ? '?' + new URLSearchParams(q) : ''}`),
  post: (path, body, h) => apiFetch(`/api/fish/${path}`, { method: 'POST', body, headers: h }),
  patch:(path, body) => apiFetch(`/api/fish/${path}`, { method: 'PATCH', body }),
  put:  (path, body) => apiFetch(`/api/fish/${path}`, { method: 'PUT', body }),
  del:  (path) => apiFetch(`/api/fish/${path}`, { method: 'DELETE' }),
};

// --------------------------------------------------------------------- misc
export function debounce(fn, ms = 300) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
export function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
export function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export function localStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem('fd3.' + key)) ?? fallback; } catch { return fallback; }
}
export function localSave(key, val) { try { localStorage.setItem('fd3.' + key, JSON.stringify(val)); } catch {} }

export function bytesToB64(bytes) {
  let bin = ''; const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
export function b64ToBlob(b64, type = 'audio/wav') {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
