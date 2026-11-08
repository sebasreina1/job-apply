import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { browserLibrary } from '../browser.mjs';

const board = 'https://job-boards.greenhouse.io/example';
const posting = `${board}/jobs/1234`;
const description = 'Java is required. We offer visa sponsorship.';

async function until(read, predicate, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read().catch(() => null);
    if (value && predicate(value)) return value;
    await sleep(100);
  }
  throw new Error('The expected workflow state did not arrive.');
}

// The child process can reach only fixture pages through its application browser.
function bootstrap() {
  return `
    import { readFile, appendFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { browserLibrary } from ${JSON.stringify(new URL('../browser.mjs', import.meta.url).href)};
    const home = process.env.JOB_APPLY_DATA;
    const posting = ${JSON.stringify(posting)};
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://boards-api.greenhouse.io/')) {
        const active = (await readFile(join(home, 'listing'), 'utf8')) === 'open';
        return Response.json({ jobs: active ? [{ id: 1234, title: 'Java Software Developer', absolute_url: posting, location: { name: 'Paris, France' }, content: ${JSON.stringify(description)} }] : [] });
      }
      if (String(url) === 'https://api.openai.com/v1/responses') {
        if (options.headers.Authorization !== 'Bearer sk-fixture-accepted1234') return Response.json({}, { status: 401 });
        return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ criteria: [{ category: 'required', tag: 'java', quote: 'Java is required.' }], sponsorshipQuote: 'We offer visa sponsorship.', englishQuote: '', localOptionalQuote: '', wording: [] }) }] }] });
      }
      throw Error('External traffic is disabled in this test.');
    };
    const { chromium } = browserLibrary();
    const launch = chromium.launchPersistentContext.bind(chromium);
    chromium.launchPersistentContext = async (directory, options) => {
      const context = await launch(directory, { ...options, headless: true });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin + url.pathname !== posting) return route.abort();
        const step = url.searchParams.get('step');
        if (step === 'receipt') {
          if (route.request().method() !== 'POST') return route.abort();
          await appendFile(join(home, 'submissions'), '1\\n');
          return route.fulfill({ contentType: 'text/html', body: '<h1>Thank you for applying</h1>' });
        }
        const body = step === 'resume'
          ? '<form method="post" action="?step=receipt" enctype="multipart/form-data"><label>Resume<input type="file" name="resume" required></label><button>Submit application</button></form>'
          : '<form><label>Full name<input name="name" required></label><label>Email<input name="email" type="email" required></label><button>Next</button></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();location.search="step=resume"}</script>';
        return route.fulfill({ contentType: 'text/html', body });
      });
      return context;
    };
  `;
}

test('a new watched posting compiles, advances in Chrome, sends once and survives restart', { skip: !process.env.TEST_BROWSER, timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'job-apply-workflow-'));
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let output = '';
  try {
    await mkdir(join(home, 'template', 'assets'), { recursive: true });
    await writeFile(join(home, 'template', 'main.tex'), '\\documentclass{article}\n\\begin{document}\nCandidate CV\n\\end{document}\n');
    await writeFile(join(home, 'profile.json'), JSON.stringify({ identity: { name: 'Test Candidate', email: 'candidate@example.test' }, text: { fr: {} }, focus: [{ label: 'Software', tags: ['java'], text: { fr: {} } }], experience: [{ slots: [], items: [{ tags: ['java'], text: { en: 'Built Java software.' } }] }] }));
    await writeFile(join(home, 'mock.mjs'), bootstrap());
    await writeFile(join(home, 'listing'), 'empty');
    const get = async () => (await fetch(`${origin}/api/jobs`)).json();
    async function start() {
      child = spawn(process.execPath, ['--import', join(home, 'mock.mjs'), 'server.mjs'], {
        cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), JOB_APPLY_DATA: home, OPENAI_API_KEY: '', JOB_APPLY_MODEL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      return until(get, state => Boolean(state.token));
    }
    async function stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, 'exit');
      child.kill('SIGINT');
      await exit;
    }
    let state = await start();
    const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-local-token': state.token }, body: JSON.stringify(body) });
    assert.equal((await post('/api/sources', { url: posting })).status, 201);
    assert.equal((await post('/api/monitor', { auto: true })).status, 400);
    assert.equal((await post('/api/ai', { key: 'sk-fixture-rejected1234', model: 'fixture' })).status, 400);
    assert.equal((await get()).aiConfigured, false);
    const saved = await post('/api/ai', { key: 'sk-fixture-accepted1234', model: 'fixture' });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { aiConfigured: true });
    assert.equal((await get()).monitor.auto, false);
    assert.equal((await post('/api/monitor', { auto: true })).status, 200);
    await writeFile(join(home, 'listing'), 'open');
    assert.equal((await post('/api/scan', {})).status, 202);
    state = await until(get, data => data.jobs[0]?.state === 'submitted' || data.jobs[0]?.state === 'error' || data.jobs[0]?.state === 'needs_input');
    const job = state.jobs[0];
    assert.equal(job.state, 'submitted', JSON.stringify(job));
    assert.equal(job.applicationScreen, 2);
    assert.equal(state.automaticToday, 1);
    const savedForm = JSON.parse(await readFile(join(home, 'runs', job.id, 'form.json'), 'utf8'));
    assert.equal(savedForm.steps[0].fields.find(field => field.name === 'email').value, 'candidate@example.test');
    assert.equal(savedForm.fields.find(field => field.name === 'resume').value[0], 'cv.pdf');
    assert.equal((await fetch(`${origin}/receipt/${job.id}`)).headers.get('content-type'), 'image/png');
    const { chromium } = browserLibrary();
    const dashboard = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
    try {
      const page = await dashboard.newPage();
      await page.goto(origin);
      await page.getByRole('heading', { name: 'Fuentes vigiladas' }).waitFor({ timeout: 5000 });
      await page.getByRole('link', { name: 'Ver comprobante' }).waitFor({ timeout: 5000 });
      assert.equal(await page.getByText('1 de 10 intentos automáticos hoy').count(), 1);
    } finally { await dashboard.close(); }
    await stop();
    state = await start();
    assert.equal(state.jobs[0].state, 'submitted');
    assert.equal(state.aiConfigured, true);
    assert.ok(!JSON.stringify(state).includes('sk-fixture-accepted1234'));
    assert.equal(state.automaticToday, 1);
    assert.equal((await post('/api/advance', { id: job.id, submit: true })).status, 400);
    assert.equal(await readFile(join(home, 'submissions'), 'utf8'), '1\n');
    await stop();
  } catch (error) {
    throw new Error(`${error.message}\n${output}`, { cause: error });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGINT');
      await exit;
    }
    await rm(home, { recursive: true, force: true });
  }
});
