import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardURL, fetchBoard } from '../boards.mjs';
import { automaticAttempts, evaluateMatch, orderMatches, wordingFor } from '../matching.mjs';
import { createMonitor, writeRecord } from '../monitor.mjs';

const java = { tags: ['java'], text: { en: 'Built Java applications.' } };
const react = { tags: ['react'], text: { en: 'Built React applications.' } };
const profile = { experience: [{ items: [java, react] }] };
const base = { title: 'Software Developer', location: 'Paris, France', target: { name: 'Lever' } };
const visa = 'We offer visa sponsorship.';
const quote = 'Java is required.';
const missing = Array.from({ length: 19 }, (_, index) => ({ category: 'responsibility', quote: `Distinct responsibility ${index}.`, tag: '' }));
function fixture({ location = base.location, extra = '', sponsorship = visa, responsibility = 'React interfaces.' } = {}) {
  const criteria = [
    { category: 'required', quote, tag: 'java' },
    { category: 'preferred', quote: 'React is a plus.', tag: 'react' },
    ...missing,
    { category: 'responsibility', quote: responsibility, tag: 'react-ui' },
  ];
  const description = [sponsorship, extra, ...criteria.map(item => item.quote)].join('\n');
  return [{ ...base, location, description }, { sponsorshipQuote: sponsorship, englishQuote: 'Our working language is English.', localOptionalQuote: 'German is not required.', criteria }];
}

test('strict 80/81 boundary and explicit eligibility gates', () => {
  const expanded = { experience: [{ items: [java, react, { tags: ['react-ui'], text: { en: 'Built React UI.' } }] }] };
  const [job, extraction] = fixture({ responsibility: 'Build react-ui features.' });
  const pass = evaluateMatch(job, expanded, extraction);
  assert.equal(pass.score, 81);
  assert.equal(pass.eligible, true);
  const exact = evaluateMatch(job, profile, extraction);
  assert.equal(exact.score, 80);
  assert.equal(exact.eligible, false);
  const [german, germanExtraction] = fixture({ location: 'Berlin, Germany', extra: 'Our working language is English. German is mandatory.' });
  assert.equal(evaluateMatch(german, expanded, germanExtraction).eligible, false);
  const [noVisa, noVisaExtraction] = fixture({ sponsorship: '' });
  assert.equal(evaluateMatch(noVisa, expanded, noVisaExtraction).eligible, false);
  assert.equal(evaluateMatch({ ...job, description: `${job.description}\nA master degree is required.` }, expanded, extraction).eligible, false);
  assert.equal(evaluateMatch({ ...job, description: `${job.description}\nVisa sponsorship is not available.` }, expanded, extraction).eligible, false);
});

test('metrics and tools can only be rendered from their own evidence card', () => {
  const card = { text: 'Used Kubernetes on Grantify.', facts: { action: 'Deployed', solution: 'Grantify', technologies: ['Kubernetes', 'CI/CD'], metrics: [] } };
  assert.equal(wordingFor(card, { style: 'action', technologies: ['Kubernetes'], result: '650+ employees, 54%' }, 'en'), 'Deployed Grantify with Kubernetes.');
  assert.equal(wordingFor(card, { style: 'action', technologies: ['GeminiCLI'] }, 'en'), card.text);
});

test('source baseline, changes, offline backoff, recovery and reopen are durable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-monitor-'));
  try {
    const path = join(directory, 'monitor.json');
    let payload = { jobs: [{ id: 1, title: 'Software Developer', absolute_url: 'https://boards.greenhouse.io/demo/jobs/1', location: { name: 'Paris' }, content: '&lt;p&gt;Develop Java APIs&lt;/p&gt;' }] };
    let offline = false;
    let time = Date.parse('2026-11-07T18:00:00Z');
    const events = [];
    const dependencies = { now: () => new Date(time), afterScan: async () => {}, onPosting: async (post, flags) => events.push([post.key, flags]), request: async () => {
      if (offline) throw new Error('offline');
      return Response.json(payload);
    } };
    let monitor = await createMonitor(path, dependencies);
    await monitor.add('https://boards.greenhouse.io/demo');
    assert.equal(events[0][1].baseline, true);
    assert.equal(monitor.enabled(), false);
    assert.equal((await fetchBoard(boardURL('https://boards.greenhouse.io/demo'), dependencies.request))[0].description, 'Develop Java APIs');
    monitor = await createMonitor(path, dependencies);
    await monitor.scan(true);
    assert.equal(events.length, 1);
    offline = true;
    await monitor.scan(true);
    assert.equal(monitor.snapshot().sources[0].error, 'offline');
    assert.equal(monitor.snapshot().sources[0].count, 1);
    offline = false;
    payload.jobs[0].content = 'Develop Java and React APIs';
    time += 300000;
    await monitor.scan(true);
    assert.equal(events[1][1].baseline, false);
    payload = { jobs: [] };
    await monitor.scan(true);
    assert.equal(events[2][1].closed, true);
    assert.equal(monitor.snapshot().sources[0].count, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('automatic attempts count after a restart using the Toronto date', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-application-'));
  try {
    const path = join(directory, 'record.json');
    const attemptedAt = '2026-11-08T02:00:00Z';
    const records = Array.from({ length: 10 }, () => ({ automaticAttempt: true, attemptedAt, state: 'sending' }));
    await writeRecord(path, [...records, { automaticAttempt: false, attemptedAt }]);
    const restarted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(automaticAttempts(restarted, new Date('2026-11-08T04:59:59Z')), 10);
    assert.equal(automaticAttempts(restarted, new Date('2026-11-08T05:00:00Z')), 0);
    assert.deepEqual(orderMatches([
      { id: 'de', match: { inFrance: false, score: 98 }, createdAt: '2026-11-07' },
      { id: 'fr', match: { inFrance: true, score: 85 }, createdAt: '2026-11-06' },
    ]).map(job => job.id), ['fr', 'de']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Lever and Ashby feeds produce canonical jobs and only Lever provides a submit target', async () => {
  const id = '85926d47-f351-412a-bb7c-e2fb01495064';
  const lever = await fetchBoard(boardURL('https://jobs.eu.lever.co/demo'), async url => {
    assert.match(url, /^https:\/\/api\.eu\.lever\.co\/v0\/postings\/demo\?/);
    return Response.json([{ id, text: 'Java Developer', hostedUrl: `https://jobs.eu.lever.co/demo/${id}`, categories: { location: 'Paris, France' }, descriptionPlain: 'Develop Java software.' }]);
  });
  assert.equal(lever[0].target.key, `lever/demo/${id}`);
  const ashby = await fetchBoard(boardURL('https://jobs.ashbyhq.com/demo'), async url => {
    assert.match(url, /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/demo$/);
    return Response.json({ jobs: [{ id, title: 'AI Engineer', jobUrl: `https://jobs.ashbyhq.com/demo/${id}`, location: 'France', descriptionPlain: 'Build AI software.' }] });
  });
  assert.equal(ashby[0].target, null);
  assert.equal(ashby[0].location, 'France');
  assert.throws(() => boardURL('https://jobs.lever.co.evil.example/demo'));
});
