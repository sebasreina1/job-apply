import { createHash } from 'node:crypto';
import { jobURL, provider } from './browser.mjs';

const hosts = {
  'jobs.lever.co': 'lever', 'jobs.eu.lever.co': 'lever',
  'boards.greenhouse.io': 'greenhouse', 'job-boards.greenhouse.io': 'greenhouse', 'job-boards.eu.greenhouse.io': 'greenhouse',
  'jobs.ashbyhq.com': 'ashby',
};

export function boardURL(value) {
  const url = jobURL(value);
  const type = hosts[url.hostname];
  const rootToken = url.pathname.match(/^\/([\w-]+)\/?$/)?.[1];
  const posting = provider(url.href);
  const ashbyPosting = type === 'ashby' && url.pathname.match(/^\/([\w-]+)\/[a-f\d-]{36}(?:\/apply)?\/?$/i)?.[1];
  const token = rootToken || posting?.key.split('/')[1] || ashbyPosting;
  if (!type || !token) throw new Error('Pega una bolsa o una vacante de Greenhouse, Lever o Ashby.');
  return { id: `${url.hostname}/${token.toLowerCase()}`, type, token, url: `${url.origin}/${token}`, host: url.hostname };
}

export function plainText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  let text = String(value || '');
  for (let i = 0; i < 2; i++) text = text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (full, key) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? full;
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : full;
  });
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/?(?:li|p|br|h[1-6]|div|ul|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, 45000);
}

export async function fetchBoard(source, request = fetch) {
  const get = async url => {
    const response = await request(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 404) throw new Error('El portal no encontró esa bolsa. Copia el enlace de la página de empleos de la empresa o de una vacante activa.');
    if (!response.ok) throw new Error(`El portal respondió ${response.status}.`);
    return response.json();
  };
  const board = encodeURIComponent(source.token);
  let entries;
  if (source.type === 'greenhouse') {
    const origin = source.host.includes('.eu.') ? 'https://boards-api.eu.greenhouse.io' : 'https://boards-api.greenhouse.io';
    const payload = await get(`${origin}/v1/boards/${board}/jobs?content=true`);
    entries = payload.jobs;
    if (payload.meta?.total > entries?.length) throw new Error('La respuesta de Greenhouse está incompleta.');
  } else if (source.type === 'ashby') {
    entries = (await get(`https://api.ashbyhq.com/posting-api/job-board/${board}`)).jobs;
  } else {
    entries = [];
    const origin = source.host === 'jobs.eu.lever.co' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    for (let skip = 0; skip < 10000; skip += 100) {
      const page = await get(`${origin}/v0/postings/${board}?mode=json&limit=100&skip=${skip}`);
      if (!Array.isArray(page)) throw new Error('Respuesta inesperada de Lever.');
      entries.push(...page);
      if (page.length < 100) break;
      if (skip === 9900) throw new Error('La bolsa supera el límite de lectura.');
    }
  }
  if (!Array.isArray(entries)) throw new Error('La fuente no devolvió una lista de vacantes.');
  return entries.flatMap(item => {
    if (item.isListed === false) return [];
    try {
      const url = jobURL(item.hostedUrl || item.absolute_url || item.jobUrl).href;
      const target = provider(url);
      if (target && (target.name.toLowerCase() !== source.type || target.key.split('/')[1].toLowerCase() !== source.token.toLowerCase())) return [];
      const title = String(item.title || item.text || '').slice(0, 200);
      if (!title) return [];
      const location = [item.location?.name || item.location || item.categories?.location, item.address?.postalAddress?.addressCountry || item.country].filter(x => typeof x === 'string').join(', ');
      const description = plainText([item.descriptionPlain || item.content || item.description, ...(item.lists || []).map(list => `${list.text}\n${list.content}`), item.additionalPlain || item.additional].filter(Boolean).join('\n'));
      const key = target?.key || `${source.id}/${item.id || new URL(url).pathname}`;
      const revision = createHash('sha256').update(JSON.stringify([title, location, description, url])).digest('hex');
      return [{ key, url, title, location, description, target, revision, company: source.token, sourceId: source.id }];
    } catch { return []; }
  });
}
