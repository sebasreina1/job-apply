import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResume, languages, tailor } from './resume.mjs';
import { inspectForm, jobURL, openBrowser, provider, readJob, waitForReceipt } from './browser.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const local = join(root, '.local');
const runsDir = join(local, 'runs');
const templateDir = join(local, 'template');
await mkdir(runsDir, { recursive: true, mode: 0o700 });
const jobs = new Map();
const sessions = new Map();
const token = randomBytes(32).toString('hex');
let contextPromise;
const irreversible = new Set(['sending', 'unconfirmed', 'submitted']);
for (const name of await readdir(runsDir)) {
  try {
    const job = JSON.parse(await readFile(join(runsDir, name, 'record.json'), 'utf8'));
    if (job.state === 'sending') job.state = 'unconfirmed';
    if (['reading', 'generating', 'filling'].includes(job.state)) job.state = 'interrupted';
    jobs.set(job.id, job);
  } catch { /* An incomplete directory has no record. */ }
}

async function save(job, patch) {
  Object.assign(job, patch);
  const directory = join(runsDir, job.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = join(directory, 'record.tmp');
  await writeFile(pending, JSON.stringify(job, null, 2), { mode: 0o600 });
  await rename(pending, join(directory, 'record.json'));
}

function openContext() {
  contextPromise ??= openBrowser(join(local, 'browser')).then(context => {
    context.on('close', () => { contextPromise = undefined; });
    return context;
  }).catch(error => { contextPromise = undefined; throw error; });
  return contextPromise;
}

async function profile() {
  try { return JSON.parse(await readFile(join(local, 'profile.json'), 'utf8')); }
  catch { throw new Error('Falta el perfil local. Consulta la sección de instalación en el README.'); }
}

const busy = new Set();
function launch(job, operation) {
  busy.add(job.id);
  void operation().catch(async error => {
    await save(job, { state: irreversible.has(job.state) ? 'unconfirmed' : 'error', message: String(error.message).split('\n')[0].slice(0, 350) });
  }).finally(() => busy.delete(job.id));
}

async function prepare(job, description, auto) {
  await save(job, { state: 'reading', message: '' });
  const candidate = await profile();
  const browser = await openContext();
  const page = await browser.newPage();
  sessions.set(job.id, page);
  const posting = await readJob(page, job.url, description);
  const result = tailor(candidate, posting, job.language);
  await save(job, { state: 'generating', title: posting.title, company: posting.company, target: posting.target, focus: result.focus, terms: result.terms, evidence: result.evidence });
  await createResume({ templateDir, outputDir: join(runsDir, job.id), result });
  await save(job, { state: 'ready', pdf: true });
  if (auto && posting.target?.key === provider(job.url)?.key && posting.target) await apply(job, true);
}

async function apply(job, submit) {
  if (!job.target || !job.pdf) throw new Error('Abre el portal y adjunta el CV manualmente para esta vacante.');
  const previous = [...jobs.values()].find(other => other.id !== job.id && other.target?.key === job.target.key && irreversible.has(other.state));
  if (previous) {
    await save(job, { state: 'duplicate', message: 'Ya existe un envío o un intento sin confirmar para esta vacante.' });
    return;
  }
  await save(job, { state: 'filling', message: '', missing: [] });
  const candidate = await profile();
  let page = sessions.get(job.id);
  if (!page || page.isClosed()) {
    page = await (await openContext()).newPage();
    sessions.set(job.id, page);
  }
  if (page.url() !== job.target.apply && !(job.providerOpened && /^https:/.test(page.url()) && provider(page.url())?.key === job.target.key)) {
    await page.goto(job.target.apply, { waitUntil: 'domcontentloaded', timeout: 22000 });
  }
  await page.bringToFront();
  const form = await inspectForm(page, job.target, candidate, join(runsDir, job.id, 'cv.pdf'));
  if (form.missing.length || !submit) {
    await save(job, { state: form.missing.length ? 'needs_input' : 'filled', providerOpened: true, missing: form.missing });
    return;
  }
  // Recheck after asynchronous browser work. Mark the attempt before clicking to prevent retries.
  if ([...jobs.values()].some(other => other.id !== job.id && other.target?.key === job.target.key && irreversible.has(other.state))) {
    await save(job, { state: 'duplicate', message: 'Otra ejecución ya intentó enviar esta candidatura.' });
    return;
  }
  await save(job, { state: 'sending', attemptedAt: new Date().toISOString() });
  await form.button.click({ timeout: 8000 });
  const receipt = await waitForReceipt(page);
  await save(job, receipt ? { state: 'submitted', receipt, submittedAt: new Date().toISOString() } : {
    state: 'unconfirmed', message: 'Se pulsó Enviar, pero el portal no confirmó la recepción. Comprueba la pestaña o tu correo antes de volver a aplicar.',
  });
}

const port = Number(process.env.PORT || 4328);
const origin = `http://127.0.0.1:${port}`;
const send = (res, code, value) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
const publicFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

async function request(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Origen no permitido.' });
  const pathname = new URL(req.url, origin).pathname;
  if (req.method === 'GET' && Object.hasOwn(publicFiles, pathname)) {
    const [file, mime] = publicFiles[pathname];
    return res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }).end(await readFile(join(root, 'public', file)));
  }
  if (req.method === 'GET' && pathname === '/api/jobs') return send(res, 200, { token, jobs: [...jobs.values()].reverse() });
  const document = pathname.match(/^\/pdf\/([\da-f-]{36})$/);
  if (req.method === 'GET' && document && jobs.get(document[1])?.pdf) {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="CV.pdf"' });
    const file = createReadStream(join(runsDir, document[1], 'cv.pdf'));
    file.on('error', () => res.destroy());
    return file.pipe(res);
  }
  if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-local-token'] !== token) return send(res, 403, { error: 'Solicitud no permitida.' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 42000) return send(res, 413, { error: 'El texto de la oferta es demasiado largo.' });
  }
  const input = JSON.parse(body);
  if (pathname === '/api/start') {
    const url = jobURL(input.url).href;
    if (!languages.includes(input.language)) throw new Error('Idioma no disponible.');
    const job = { id: randomUUID(), url, language: input.language, createdAt: new Date().toISOString(), state: 'reading' };
    jobs.set(job.id, job);
    launch(job, () => prepare(job, typeof input.description === 'string' ? input.description.trim() : '', input.auto === true));
    return send(res, 202, { id: job.id });
  }
  if (pathname === '/api/advance') {
    const job = jobs.get(input.id);
    if (!job || busy.has(job.id) || !['ready', 'filled', 'needs_input'].includes(job.state) || !job.target) throw new Error('La candidatura no está disponible para continuar.');
    launch(job, () => apply(job, input.submit === true));
    return send(res, 202, { id: job.id });
  }
  return send(res, 404, { error: 'Ruta desconocida.' });
}

const server = http.createServer((req, res) => request(req, res).catch(error => send(res, 400, { error: error.message })));
server.listen(port, '127.0.0.1', () => console.log(`Job Apply · ${origin}`));
process.once('SIGINT', async () => { await (await contextPromise?.catch(() => null))?.close(); server.close(); });
