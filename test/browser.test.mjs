import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserLibrary, inspectForm, provider, readJob, waitForReceipt } from '../browser.mjs';

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
    const complete = await inspectForm(page, job.target, sample, file);
    assert.deepEqual(complete.missing, []);
    await complete.button.click();
    assert.match(await waitForReceipt(page), /Thank you for applying/);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
