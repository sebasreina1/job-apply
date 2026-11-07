import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldKey, jobURL, provider } from '../browser.mjs';
import { renderTemplate, tailor } from '../resume.mjs';

const profile = {
  text: { en: { '15:432': 'CONTACT' }, fr: { '15:432': 'COORDONNÉES' } },
  focus: [{ label: 'Software', tags: ['java'], text: { en: {}, fr: {} } }, { label: 'AI', tags: ['ai'], text: { en: {}, fr: {} } }],
  experience: [{ slots: ['244:724'], items: [
    { tags: ['gemini'], text: { en: 'Integrated Gemini.', fr: 'Intégré Gemini.' } },
    { tags: ['kubernetes', 'ci/cd'], text: { en: 'Used Kubernetes and CI/CD on Grantify.', fr: 'Utilisé Kubernetes et CI/CD sur Grantify.' } },
  ] }],
};

test('matches documented technologies, keeps them with their project and honors language', () => {
  const result = tailor(profile, { title: 'Java backend', description: 'JavaScript, RabbitMQ, Kubernetes and CI/CD' }, 'fr');
  assert.equal(result.focus, 'Software');
  assert.deepEqual(result.terms, ['java', 'kubernetes', 'ci/cd']);
  assert.match(result.slots['244:724'], /Utilisé.*Grantify/);
  assert.doesNotMatch(JSON.stringify(result), /RabbitMQ/);
  assert.equal(tailor(profile, { title: 'AI engineer', description: 'Gemini' }, 'en').slots['244:724'], 'Integrated Gemini.');
});

test('preserves placement and escapes data in LaTeX', () => {
  const input = '\\place{244.000}{724.000}{337.5}{\\fontsize{9bp}{11bp}\\raggedright Original\\par}\n\\end{document}';
  assert.equal(renderTemplate(input, { '244:724': 'A & **50%**' }), '\\place{244.000}{724.000}{337.5}{\\fontsize{9bp}{11bp}\\raggedright A \\& \\textbf{50\\%}\\par}\n\\end{document}');
});

test('uses canonical ATS job identity and rejects lookalikes and private URLs', () => {
  const lever = 'https://jobs.lever.co/example/12345678-abcd-1234-abcd-123456789012';
  assert.equal(provider(lever).key, provider(`${lever}/apply?source=test`).key);
  assert.equal(provider('https://job-boards.greenhouse.io/demo/jobs/123').key, 'greenhouse/demo/123');
  assert.equal(provider('https://jobs.lever.co.example.com/demo/jobs/123'), null);
  assert.throws(() => jobURL('http://localhost:8000/'));
  assert.throws(() => jobURL('https://127.0.0.1/'));
  assert.equal(fieldKey({ label: 'Work authorization?', name: 'email', autocomplete: 'email' }), undefined);
});
