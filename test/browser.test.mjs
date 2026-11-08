import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceApplication, browserLibrary, inspectForm, provider, readJob, visibleReceipts, waitForReceipt } from '../browser.mjs';

const sample = { identity: { name: 'Test Candidate', email: 'candidate@example.test', phone: '5550100' } };
const fixture = `<main><h1>Java Backend Engineer</h1><p>We build customer software using Java, Spring Boot, PostgreSQL, Kubernetes, REST APIs and CI/CD tooling.</p><form>
<label>Full name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
<label>Phone<input name="phone" type="tel"></label><label>Resume<input name="resume" type="file" required></label>
<label>Are you authorized to work in France?<select required><option value="">Choose</option><option>Yes</option><option>No</option></select></label>
<button type="submit">Submit application</button></form></main><script>document.querySelector('form').onsubmit = event => {event.preventDefault();document.querySelector('main').innerHTML = '<h1>Thank you for applying</h1>'}</script>`;

test('browser reads the posting, uploads the CV, pauses for authorization and recognizes a receipt', { skip: !process.env.TEST_BROWSER }, async () => {
  const { chromium } = browserLibrary();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  const directory = await mkdtemp(join(tmpdir(), 'job-apply-fixture-'));
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.lever.co/example/12345678-abcd-1234-abcd-123456789012/apply';
    await page.route('**/*', route => route.request().url() === url ? route.fulfill({ contentType: 'text/html', body: fixture }) : route.abort());
    const job = await readJob(page, url, '');
    assert.equal(job.title, 'Java Backend Engineer');
    assert.equal(job.target.key, provider(url).key);
    const file = join(directory, 'cv.pdf');
    await writeFile(file, '%PDF-1.4 fixture');
    const blocked = await inspectForm(page, job.target, sample, file);
    assert.ok(blocked.missing.some(value => /authorized/.test(value)));
    assert.equal(await page.getByLabel('Full name').inputValue(), 'Test Candidate');
    assert.equal(await page.locator('input[type=file]').evaluate(el => el.files[0].name), 'cv.pdf');
    await page.getByLabel('Are you authorized to work in France?').selectOption({ label: 'Yes' });
    const unattended = await advanceApplication(page, job.target, sample, file, { unattended: true });
    assert.ok(unattended.missing.some(value => /authorized/.test(value)));
    const complete = await inspectForm(page, job.target, sample, file);
    assert.deepEqual(complete.missing, []);
    await complete.button.click();
    assert.match(await waitForReceipt(page), /Thank you for applying/);
    const previous = await visibleReceipts(page);
    await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<p>Server error</p>'));
    assert.equal(await waitForReceipt(page, { previous, timeout: 100 }), null);
    await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<p>Your application has been received.</p>'));
    assert.match(await waitForReceipt(page, { previous }), /application has been received/);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('multi-screen application fills identity before the resume step and reaches a single receipt', { skip: !process.env.TEST_BROWSER }, async () => {
  const { chromium } = browserLibrary();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  const directory = await mkdtemp(join(tmpdir(), 'job-apply-steps-'));
  try {
    const page = await browser.newPage();
    const url = 'https://job-boards.greenhouse.io/example/jobs/1234';
    const file = join(directory, 'cv.pdf');
    await writeFile(file, '%PDF-1.4 fixture');
    const received = [];
    await page.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (target.origin + target.pathname !== url) return route.abort();
      if (target.searchParams.get('step') === 'receipt') {
        received.push(route.request().postData());
        return route.fulfill({ contentType: 'text/html', body: '<h1>Thank you for applying</h1>' });
      }
      const body = target.searchParams.get('step') === 'resume'
        ? '<form method="post" action="?step=receipt"><label>Resume<input type="file" name="resume" required></label><button>Submit application</button></form>'
        : '<form><label>First name<input name="first_name" required></label><label>Last name<input name="last_name" required></label><label>Email<input type="email" name="email" required></label><button>Next</button></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();location.search="step=resume"}</script>';
      return route.fulfill({ contentType: 'text/html', body });
    });
    await page.goto(url);
    const candidate = { identity: { ...sample.identity, firstName: 'Test', lastName: 'Candidate' } };
    const final = await advanceApplication(page, provider(url), candidate, file);
    assert.equal(final.progress.steps.length, 1);
    assert.equal(final.progress.steps[0].fields.find(field => field.name === 'first_name').value, 'Test');
    assert.deepEqual(final.missing, []);
    assert.equal(final.kind, 'submit');
    await final.button.click();
    assert.match(await waitForReceipt(page), /Thank you for applying/);
    assert.equal(received.length, 1);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
