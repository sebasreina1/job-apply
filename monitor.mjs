import { execFile } from 'node:child_process';
import { open, readFile, rename } from 'node:fs/promises';
import { boardURL, fetchBoard } from './boards.mjs';

export async function writeRecord(path, value) {
  const temp = `${path}.tmp`;
  const file = await open(temp, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
}

export function macNotice(title, body) {
  if (process.platform !== 'darwin') return;
  execFile('/usr/bin/osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', title, body], { timeout: 5000 }, () => {});
}

export async function createMonitor(path, { onPosting, afterScan, request = fetch, now = () => new Date() }) {
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { auto: false, sources: [] };
  }
  let chain = Promise.resolve();
  const exclusive = operation => {
    const next = chain.then(operation);
    chain = next.catch(() => {});
    return next;
  };
  const persist = () => writeRecord(path, state);
  function snapshot() {
    return { auto: state.auto, sources: state.sources.map(({ seen, ...source }) => ({ ...source, count: Object.values(seen).filter(item => item.open).length })) };
  }
  async function check(source, supplied) {
    const posts = supplied || await fetchBoard(source, request);
    const baseline = !source.lastSuccess;
    const current = new Set(posts.map(post => post.key));
    for (const post of posts) {
      const previous = source.seen[post.key];
      if (!previous || previous.revision !== post.revision || !previous.open) {
        await onPosting(post, { baseline: baseline || Boolean(previous?.baseline && previous.revision === post.revision), previous });
        source.seen[post.key] = { revision: post.revision, open: true, baseline };
      }
    }
    for (const [key, item] of Object.entries(source.seen)) if (!current.has(key) && item.open) {
      await onPosting({ key }, { closed: true });
      item.open = false;
    }
    source.lastSuccess = now().toISOString();
    source.error = '';
  }
  return {
    snapshot,
    enabled: () => state.auto,
    source: id => state.sources.find(item => item.id === id && item.enabled),
    async add(url) {
      return exclusive(async () => {
        const descriptor = boardURL(url);
        if (state.sources.some(item => item.id === descriptor.id)) throw new Error('Esta fuente ya está registrada.');
        const posts = await fetchBoard(descriptor, request);
        const source = { ...descriptor, enabled: true, seen: {}, failures: 0, lastSuccess: null, nextCheck: null };
        await check(source, posts);
        source.nextCheck = new Date(+now() + 300000).toISOString();
        state.sources.push(source);
        await persist();
        return snapshot();
      });
    },
    async update({ auto, id, enabled }) {
      if (id) {
        const source = state.sources.find(item => item.id === id);
        if (!source || typeof enabled !== 'boolean') throw new Error('Fuente desconocida.');
        source.enabled = enabled;
        if (enabled) source.nextCheck = null;
      }
      if (typeof auto === 'boolean') state.auto = auto;
      return exclusive(async () => {
        await persist();
        return snapshot();
      });
    },
    scan(force = false) {
      return exclusive(async () => {
        for (const source of state.sources) {
          if (!source.enabled || (!force && source.nextCheck && +new Date(source.nextCheck) > +now())) continue;
          try { await check(source); source.failures = 0; }
          catch (error) { source.failures++; source.error = String(error.message).slice(0, 160); }
          source.nextCheck = new Date(+now() + Math.min(3600000, 300000 * 2 ** Math.min(source.failures, 4))).toISOString();
          await persist();
        }
        await afterScan();
        return snapshot();
      });
    },
  };
}
