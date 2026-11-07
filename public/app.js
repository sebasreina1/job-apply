const statuses = {
  reading: 'Leyendo oferta', generating: 'Generando CV', ready: 'CV listo', filling: 'Rellenando', filled: 'Formulario listo',
  needs_input: 'Requiere datos', sending: 'Enviando', submitted: 'Enviado', unconfirmed: 'Sin confirmación',
  duplicate: 'Ya registrado', interrupted: 'Interrumpido', error: 'Error',
};
const form = document.querySelector('#new-job');
const jobsContainer = document.querySelector('#jobs');
const errorLabel = document.querySelector('#error');
let token;
let previous;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(label, url) {
  const node = element('a', label, 'button');
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}
function showError(message) {
  errorLabel.textContent = message;
  errorLabel.hidden = !message;
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function render(job) {
  const card = element('article', null, 'card job');
  const head = element('div', null, 'job-head');
  head.append(element('h3', job.title || new URL(job.url).hostname), element('span', statuses[job.state] || job.state, `status ${job.state}`));
  card.append(head, element('p', [job.company, job.focus, job.language.toUpperCase(), job.target?.name].filter(Boolean).join(' · '), 'meta'));
  if (job.target?.apply) card.append(element('p', `Portal de envío: ${new URL(job.target.apply).hostname}`, 'meta'));
  if (job.message || job.receipt) card.append(element('p', job.message || job.receipt, 'meta'));
  if (job.pdf && !job.target) card.append(element('p', 'Este portal requiere que adjuntes el CV manualmente.', 'meta'));
  if (job.terms?.length) {
    const terms = element('div', null, 'terms');
    for (const term of job.terms) terms.append(element('span', term, 'term'));
    card.append(terms);
  }
  if (job.missing?.length) {
    const list = element('ul', null, 'missing');
    for (const item of job.missing) list.append(element('li', item));
    card.append(list);
  }
  const actions = element('div', null, 'actions');
  if (job.pdf) actions.append(link('Ver CV', `/pdf/${job.id}`));
  actions.append(link('Abrir vacante', job.url));
  if (job.target && ['ready', 'filled', 'needs_input'].includes(job.state)) {
    for (const [label, submit] of [['Rellenar en Chrome', false], ['Rellenar y enviar', true]]) {
      const button = element('button', label, submit ? 'primary' : '');
      button.addEventListener('click', async () => {
        button.disabled = true;
        showError('');
        try { await post('/api/advance', { id: job.id, submit }); await refresh(); }
        catch (error) { showError(error.message); button.disabled = false; }
      });
      actions.append(button);
    }
  }
  card.append(actions);
  return card;
}
async function refresh() {
  const response = await fetch('/api/jobs');
  if (!response.ok) throw new Error('El servidor local no responde.');
  const state = await response.json();
  token = state.token;
  const key = JSON.stringify(state.jobs);
  if (key === previous) return;
  previous = key;
  document.querySelector('#count').textContent = `${state.jobs.length} en el historial`;
  jobsContainer.replaceChildren(...(state.jobs.length ? state.jobs.map(render) : [element('div', 'Las candidaturas que prepares aparecerán aquí.', 'empty')]));
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  showError('');
  try {
    if (!token) await refresh();
    await post('/api/start', { ...values, auto: event.submitter?.value === 'auto' });
    await refresh();
  } catch (error) { showError(error.message); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
});
async function poll() {
  try { await refresh(); } catch (error) { showError(error.message); }
  setTimeout(poll, 1200);
}
void poll();
