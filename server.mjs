import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResume, languages, tailor } from './resume.mjs';
import { inspectForm, jobURL, manualPortal, openBrowser, provider, readJob, waitForReceipt } from './browser.mjs';
import { aiConfigured, analyzePosting, automaticAttempts, evaluateMatch, localExtraction, orderMatches } from './matching.mjs';
import { fetchBoard } from './boards.mjs';
import { createMonitor, macNotice, writeRecord } from './monitor.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const local = process.env.JOB_APPLY_DATA || join(root, '.local');
const runsDir = join(local, 'runs');
const templateDir = join(local, 'template');
try { process.loadEnvFile(join(local, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    if (['reading', 'generating', 'filling', 'queued'].includes(job.state)) {
      job.state = job.sourceId ? 'review' : 'interrupted';
      if (job.sourceId) job.autoHold = true;
    }
    jobs.set(job.id, job);
  } catch { /* An incomplete directory has no record. */ }
}

async function save(job, patch) {
  Object.assign(job, patch);
  const directory = join(runsDir, job.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeRecord(join(directory, 'record.json'), job);
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
let queue = Promise.resolve();
function launch(job, operation) {
  busy.add(job.id);
  queue = queue.then(operation).catch(async error => {
    const state = irreversible.has(job.state) ? 'unconfirmed' : 'error';
    await save(job, { state, message: String(error.message).split('\n')[0].slice(0, 350), autoHold: true });
    if (job.sourceId) await notifyOnce(job, 'attention', 'Revisa la candidatura');
  }).catch(error => console.error('Error guardando la candidatura:', error.code || error.name)).finally(() => busy.delete(job.id));
}

async function notifyOnce(job, event, title) {
  const notices = job.notices || [];
  if (notices.includes(event)) return;
  await save(job, { notices: [...notices, event] });
  macNotice(title, `${job.title || 'Vacante'} · ${job.company || 'Job Apply'}`.slice(0, 170));
}

async function assess(job, posting, candidate) {
  let extraction;
  let analysisNote = '';
  try { extraction = await analyzePosting(posting, candidate, job.language); }
  catch (error) { analysisNote = error.message; }
  const match = evaluateMatch(posting, candidate, extraction || localExtraction(posting, candidate));
  if (!extraction) {
    match.eligible = false;
    match.blockers.push(analysisNote || 'Configura el análisis de IA para habilitar el envío automático.');
  }
  await save(job, { match, analyzed: true, analysisMode: extraction ? 'ai' : 'local', analyzedAt: new Date().toISOString(), wording: extraction?.wording || [] });
  if (match.score > 80 && job.sourceId && !job.baseline) await notifyOnce(job, `match:${job.revision}`, 'Vacante con más del 80 % de encaje');
  return match;
}

async function prepare(job, description = '', submit = false, automatic = false) {
  const candidate = await profile();
  let posting = job.posting;
  if (!posting) {
    await save(job, { state: 'reading', message: '' });
    if (manualPortal(job.url)) {
      if (!description) {
        await save(job, { state: 'review', message: 'Pega la descripción de LinkedIn para preparar el CV. La solicitud se completa manualmente.' });
        return;
      }
      posting = { title: 'Vacante de LinkedIn', company: '', description, target: null };
    } else {
      const page = await (await openContext()).newPage();
      sessions.set(job.id, page);
      posting = await readJob(page, job.url, description);
    }
  }
  if (!job.analyzed) await assess(job, posting, candidate);
  const result = tailor(candidate, posting, job.language, job.wording);
  await save(job, { state: 'generating', posting, title: posting.title, company: posting.company, location: posting.location, target: posting.target, focus: result.focus, terms: result.terms, evidence: result.evidence });
  await createResume({ templateDir, outputDir: join(runsDir, job.id), result });
  await save(job, { state: 'ready', pdf: true, message: '' });
  if (submit && posting.target?.key === provider(job.url)?.key && posting.target) await apply(job, true, automatic);
}

function onPosting(posting, flags) {
  const update = queue.then(() => updatePosting(posting, flags));
  queue = update.catch(() => {});
  return update;
}

async function updatePosting(posting, { baseline, closed }) {
  let job = [...jobs.values()].find(item => item.sourceId && item.key === posting.key);
  if (closed) {
    if (job && !irreversible.has(job.state)) await save(job, { state: 'closed', closed: true });
    return;
  }
  if (job && (irreversible.has(job.state) || (job.revision === posting.revision && !job.closed))) return;
  if (!job) {
    job = { id: randomUUID(), key: posting.key, createdAt: new Date().toISOString() };
    jobs.set(job.id, job);
  }
  const french = evaluateMatch(posting, { experience: [] }, null).inFrance;
  await save(job, {
    url: posting.url, title: posting.title, company: posting.company, location: posting.location, target: posting.target,
    posting, sourceId: posting.sourceId, revision: posting.revision, baseline, closed: false, autoHold: false,
    language: french ? 'fr' : 'en', state: 'detected', analyzed: false, match: null, pdf: false, message: '',
  });
}

let scheduling = false;
function schedule() {
  if (scheduling) return;
  scheduling = true;
  // Source reads are independent from Chrome and CV compilation. All submits share the same queue.
  queue = queue.then(async () => {
    const candidate = await profile();
    const detected = [...jobs.values()].filter(job => job.sourceId && !job.closed && !job.autoHold && !busy.has(job.id) &&
      (job.state === 'detected' && !job.analyzed || job.state === 'review' && job.analysisMode === 'local' && aiConfigured() && Date.now() - Date.parse(job.analyzedAt) > 300000));
    detected.sort((a, b) => Number(b.language === 'fr') - Number(a.language === 'fr') || Number(a.baseline) - Number(b.baseline));
    for (const job of detected.slice(0, 4)) {
      const match = await assess(job, job.posting, candidate);
      await save(job, { state: match.eligible && !job.baseline ? 'detected' : 'review' });
    }
    if (!monitor.enabled()) return;
    const eligible = orderMatches([...jobs.values()].filter(job => job.sourceId && !job.baseline && !job.closed && !job.autoHold &&
      ['detected', 'ready', 'queued'].includes(job.state) && job.match?.eligible && !busy.has(job.id) && monitor.source(job.sourceId)));
    for (const job of eligible) {
      if (!monitor.enabled() || automaticAttempts(jobs.values()) >= 10) break;
      try {
        await save(job, { state: 'queued' });
        if (job.pdf) await apply(job, true, 'watch');
        else await prepare(job, '', true, 'watch');
      } catch (error) {
        await save(job, { state: irreversible.has(job.state) ? 'unconfirmed' : 'review', autoHold: true, message: error.message.split('\n')[0].slice(0, 300) });
        await notifyOnce(job, 'attention', 'Revisa la candidatura');
      }
    }
  }).catch(error => console.error('Error de la cola:', error.message)).finally(() => { scheduling = false; });
}

const monitor = await createMonitor(join(local, 'monitor.json'), { onPosting, afterScan: schedule });

async function apply(job, submit, automatic = false) {
  if (job.closed || irreversible.has(job.state)) throw new Error('La vacante está cerrada o ya tiene un intento de envío.');
  const allowed = () => !automatic || (aiConfigured() && job.match?.eligible && !job.closed && automaticAttempts(jobs.values()) < 10 &&
    (automatic !== 'watch' || monitor.enabled() && monitor.source(job.sourceId) && !job.baseline));
  if (!allowed()) {
    await save(job, { state: 'review', message: 'El envío automático requiere cumplir los filtros, tener análisis de IA y disponer de intentos diarios.' });
    return;
  }
  const source = job.sourceId && monitor.source(job.sourceId);
  if (automatic && source) {
    const fresh = (await fetchBoard(source)).find(item => item.key === job.key);
    if (!fresh || fresh.revision !== job.revision) {
      await save(job, { state: fresh ? 'review' : 'closed', closed: !fresh, autoHold: true, message: 'La oferta cambió desde el análisis. Se actualizará en la próxima lectura.' });
      await notifyOnce(job, 'attention', 'Revisa la candidatura');
      return;
    }
  }
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
  const form = await inspectForm(page, job.target, candidate, join(runsDir, job.id, 'cv.pdf'), true, submit);
  if (form.missing.length || !submit) {
    await save(job, { state: form.missing.length ? 'needs_input' : 'filled', providerOpened: true, missing: form.missing });
    if (form.missing.length && job.sourceId) await notifyOnce(job, 'attention', 'El formulario requiere tu intervención');
    return;
  }
  // Recheck after asynchronous browser work. Mark the attempt before clicking to prevent retries.
  if ([...jobs.values()].some(other => other.id !== job.id && other.target?.key === job.target.key && irreversible.has(other.state))) {
    await save(job, { state: 'duplicate', message: 'Otra ejecución ya intentó enviar esta candidatura.' });
    return;
  }
  if (!allowed()) {
    await save(job, { state: 'ready' });
    return;
  }
  const formSnapshot = await form.form.evaluate(element => Array.from(element.elements).filter(field =>
    field.name && !['hidden', 'password', 'submit', 'button', 'reset'].includes(field.type) && field.getClientRects().length
  ).map(field => ({ name: field.name, label: field.labels?.[0]?.textContent?.trim(), value: field.type === 'file' ? [...field.files].map(file => file.name) : ['radio', 'checkbox'].includes(field.type) ? field.checked : field.value })));
  await writeRecord(join(runsDir, job.id, 'form.json'), { url: page.url(), fields: formSnapshot });
  // The last check is after form snapshot I/O, just before reserving the attempt.
  if (!allowed()) {
    await save(job, { state: 'ready' });
    return;
  }
  await save(job, { state: 'sending', automaticAttempt: Boolean(automatic), attemptedAt: new Date().toISOString() });
  if (automatic === 'watch' && (!monitor.enabled() || !monitor.source(job.sourceId))) {
    await save(job, { state: 'ready', automaticAttempt: false, attemptedAt: null });
    return;
  }
  await form.button.click({ timeout: 8000 });
  const receipt = await waitForReceipt(page);
  let receiptCapture = false;
  let receiptUrl = null;
  if (receipt) {
    try {
      const url = jobURL(page.url());
      if (url.origin === new URL(job.target.apply).origin && !url.search && url.href !== job.target.apply) receiptUrl = url.href;
      await page.screenshot({ path: join(runsDir, job.id, 'receipt.png'), timeout: 5000 });
      receiptCapture = true;
    } catch { /* Receipt text remains available if the portal closes its window. */ }
  }
  await save(job, receipt ? { state: 'submitted', receipt, receiptCapture, receiptUrl, submittedAt: new Date().toISOString() } : {
    state: 'unconfirmed', message: 'Se pulsó Enviar, pero el portal no confirmó la recepción. Comprueba la pestaña o tu correo antes de volver a aplicar.',
  });
  await notifyOnce(job, receipt ? 'submitted' : 'attention', receipt ? 'Candidatura enviada' : 'Envío sin confirmar');
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
  if (req.method === 'GET' && pathname === '/api/jobs') return send(res, 200, {
    token, monitor: monitor.snapshot(), automaticToday: automaticAttempts(jobs.values()), aiConfigured: aiConfigured(),
    jobs: [...jobs.values()].reverse().map(({ posting, wording, ...job }) => job),
  });
  const receipt = pathname.match(/^\/receipt\/([\da-f-]{36})$/);
  if (req.method === 'GET' && receipt && jobs.get(receipt[1])?.state === 'submitted') {
    const job = jobs.get(receipt[1]);
    if (job.receiptCapture) {
      const path = join(runsDir, job.id, 'receipt.png');
      try { await access(path); } catch { return send(res, 200, { receipt: job.receipt, submittedAt: job.submittedAt, receiptUrl: job.receiptUrl }); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      const file = createReadStream(path);
      file.on('error', () => res.destroy());
      return file.pipe(res);
    }
    return send(res, 200, { receipt: job.receipt, submittedAt: job.submittedAt, receiptUrl: job.receiptUrl });
  }
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
  if (pathname === '/api/sources') return send(res, 201, await monitor.add(input.url));
  if (pathname === '/api/monitor') {
    if (input.auto === true && !aiConfigured()) throw new Error('Configura OPENAI_API_KEY y JOB_APPLY_MODEL antes de activar el envío automático.');
    if (input.auto === true && !monitor.snapshot().sources.some(source => source.enabled && source.lastSuccess)) throw new Error('Añade una fuente y revisa su primera lectura.');
    const state = await monitor.update(input);
    schedule();
    return send(res, 200, state);
  }
  if (pathname === '/api/scan') {
    triggerScan(true);
    return send(res, 202, { scanning: true });
  }
  if (pathname === '/api/start' || pathname === '/api/batch') {
    if (!languages.includes(input.language)) throw new Error('Idioma no disponible.');
    if (pathname === '/api/batch' && (!Array.isArray(input.urls || []) || !Array.isArray(input.ids || []))) throw new Error('Lote inválido.');
    const urls = [...new Map((pathname === '/api/start' ? [input.url] : input.urls || []).map(value => {
      const url = jobURL(value).href;
      return [provider(url)?.key || url, url];
    })).values()];
    const ids = [...new Set(pathname === '/api/batch' ? input.ids || [] : [])];
    if (urls.length + ids.length < 1 || urls.length + ids.length > 50) throw new Error('Selecciona entre 1 y 50 vacantes.');
    const selected = ids.map(id => {
      const job = jobs.get(id);
      if (!job || busy.has(id) || job.closed || irreversible.has(job.state)) throw new Error('Una vacante seleccionada ya no está disponible.');
      return job;
    });
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description && urls.length !== 1) throw new Error('Pega una descripción solo al preparar una vacante.');
    for (const url of urls) {
      const job = { id: randomUUID(), url, language: input.language, createdAt: new Date().toISOString(), state: 'queued' };
      jobs.set(job.id, job);
      selected.push(job);
    }
    for (const job of selected) busy.add(job.id);
    for (const job of selected) {
      const languageChanged = job.language !== input.language;
      launch(job, async () => {
        await save(job, { language: input.language, state: 'queued', ...(languageChanged ? { analyzed: false, pdf: false } : {}) });
        await prepare(job, description, input.auto === true, pathname === '/api/batch' ? 'batch' : false);
      });
    }
    return send(res, 202, { id: selected[0].id, ids: selected.map(job => job.id) });
  }
  if (pathname === '/api/advance') {
    const job = jobs.get(input.id);
    if (!job || busy.has(job.id) || !['ready', 'review', 'filled', 'needs_input'].includes(job.state) || !job.pdf || !job.target) throw new Error('La candidatura no está disponible para continuar.');
    launch(job, () => apply(job, input.submit === true));
    return send(res, 202, { id: job.id });
  }
  return send(res, 404, { error: 'Ruta desconocida.' });
}

let scanning = false;
function triggerScan(force = false) {
  if (scanning) return;
  scanning = true;
  void monitor.scan(force).catch(error => console.error('Error de monitoreo:', error.message)).finally(() => { scanning = false; });
}
const timer = setInterval(triggerScan, 15000);
timer.unref();
const server = http.createServer((req, res) => request(req, res).catch(error => send(res, 400, { error: error.message })));
server.listen(port, '127.0.0.1', () => { console.log(`Job Apply · ${origin}`); triggerScan(); });
process.once('SIGINT', async () => { await (await contextPromise?.catch(() => null))?.close(); server.close(); });
