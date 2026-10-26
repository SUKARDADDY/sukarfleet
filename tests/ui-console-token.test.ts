// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ui/app.js keeps the console token in sessionStorage, which throws in a few hardened browser
// configurations. The page must then still unlock: the submitted token also lives in memory, and
// the api transport falls back to it. This test runs the real app.js in a node:vm context with a
// stub DOM, submits a token through the real form handler, and reads the Authorization header the
// next request carries.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SOURCE = readFileSync(join(import.meta.dir, '..', 'ui', 'app.js'), 'utf8');
const TOKEN = 'Hk8w2-PqN5zR1cYt7LmX0aVbJ4dGeS3u';

type Handler = (ev: unknown) => unknown;

// Any property is a no-op function or a stub, so the page's wiring runs without a browser.
function stubElement(listeners: Map<string, Handler>, id: string, value = ''): any {
  const target: Record<string, unknown> = { id, value, hidden: false, textContent: '', dataset: {}, style: {} };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'addEventListener') return (type: string, fn: Handler) => void listeners.set(`${id}:${type}`, fn);
      if (prop in t) return t[prop as string];
      if (prop === 'classList') return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === 'children' || prop === 'childNodes') return [];
      if (prop === 'firstChild' || prop === 'lastChild' || prop === 'parentNode') return null;
      if (prop === Symbol.toPrimitive) return () => '';
      return () => stubElement(listeners, `${id}.${String(prop)}`);
    },
    set(t, prop, v) {
      t[prop as string] = v;
      return true;
    },
  });
}

async function submitToken(storageThrows: boolean): Promise<{ firstAuth: string | undefined; storedToken: boolean }> {
  const listeners = new Map<string, Handler>();
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, stubElement(listeners, id, id === 'console-token-input' ? TOKEN : ''));
    return elements.get(id);
  };
  const authorizations: Array<string | undefined> = [];
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => {
      if (storageThrows) throw new Error('SecurityError');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storageThrows) throw new Error('SecurityError');
      store.set(k, v);
    },
    removeItem: (k: string) => {
      if (storageThrows) throw new Error('SecurityError');
      store.delete(k);
    },
  };
  const document = {
    hidden: false,
    getElementById: element,
    querySelector: () => stubElement(listeners, 'q'),
    querySelectorAll: () => [],
    createElement: (tag: string) => stubElement(listeners, tag),
    createTextNode: () => stubElement(listeners, 'text'),
    addEventListener() {},
    body: stubElement(listeners, 'body'),
  };
  const fetchStub = async (_path: string, init: { headers?: Record<string, string> }) => {
    authorizations.push(init.headers?.authorization);
    const ok = init.headers?.authorization === `Bearer ${TOKEN}`;
    return {
      status: ok ? 200 : 401,
      ok,
      text: async () =>
        ok ? '{}' : JSON.stringify({ error: 'console-token-required', message: 'Paste the console token.' }),
    };
  };
  const context: Record<string, unknown> = {
    document,
    sessionStorage,
    fetch: fetchStub,
    location: { hash: '', pathname: '/ui/', search: '' },
    window: { addEventListener() {}, location: { hash: '' } },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    console,
    URLSearchParams,
    encodeURIComponent,
    AbortController,
    Intl,
    Date,
    JSON,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'app.js' });
  // Let the boot poll finish and the gate close on its refusal before the operator submits.
  await new Promise((r) => setTimeout(r, 20));
  authorizations.length = 0;
  const submit = listeners.get('console-token-form:submit');
  expect(submit).toBeDefined();
  await submit!({ preventDefault() {} });
  return { firstAuth: authorizations[0], storedToken: store.size > 0 };
}

describe('ui/app.js console token transport', () => {
  test('a submitted token is sent when sessionStorage works', async () => {
    const r = await submitToken(false);
    expect(r.firstAuth).toBe(`Bearer ${TOKEN}`);
    expect(r.storedToken).toBe(true);
  });

  test('a submitted token is still sent when sessionStorage throws', async () => {
    const r = await submitToken(true);
    expect(r.firstAuth).toBe(`Bearer ${TOKEN}`);
  });
});
