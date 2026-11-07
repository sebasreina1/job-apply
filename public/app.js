const statuses = {
  detected: 'Detectada', review: 'Requiere revisión', queued: 'En cola', closed: 'Cerrada',
  reading: 'Leyendo oferta', generating: 'Generando CV', ready: 'CV listo', filling: 'Rellenando', filled: 'Formulario listo',
  needs_input: 'Requiere datos', sending: 'Enviando', submitted: 'Enviado', unconfirmed: 'Sin confirmación',
  duplicate: 'Ya registrado', interrupted: 'Interrumpido', error: 'Error',
};
const form = document.querySelector('#new-job');
const jobsContainer = document.querySelector('#jobs');
const errorLabel = document.querySelector('#error');
let token;
let previous;
let current;
const selection = new Set();
const filter = document.querySelector('#filter');
const autoToggle = document.querySelector('#auto-toggle');
const sourceForm = document.querySelector('#source-form');

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
  card.append(head, element('p', [job.company, job.location, job.focus, job.language?.toUpperCase(), job.target?.name].filter(Boolean).join(' · '), 'meta'));
  if (!job.closed && ['detected', 'review', 'ready', 'filled', 'needs_input', 'error', 'interrupted'].includes(job.state)) {
    const label = element('label', null, 'pick');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selection.has(job.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selection.add(job.id);
      else selection.delete(job.id);
      updateSelection();
    });
    label.append(checkbox, 'Seleccionar');
    card.append(label);
  }
  if (job.match) {
    const details = element('details');
    const score = Math.abs(job.match.score - Math.round(job.match.score)) < 1e-9 ? job.match.score.toFixed(0) : job.match.score.toFixed(2);
    details.append(element('summary', `${score} % de encaje`));
    const list = element('ul', null, 'missing');
    for (const item of job.match.criteria) list.append(element('li', `${item.matched ? 'Coincide' : 'Por verificar'} · ${item.quote}${item.evidence ? ` → ${item.evidence.text.replaceAll('**', '')}` : ''}`));
    for (const blocker of job.match.blockers) list.append(element('li', blocker));
    details.append(list);
    card.append(details);
  }
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
  if (job.state === 'submitted') actions.append(link('Ver comprobante', `/receipt/${job.id}`));
  if (job.receiptUrl) actions.append(link('Abrir confirmación del portal', job.receiptUrl));
  if (job.pdf && job.target && ['ready', 'review', 'filled', 'needs_input'].includes(job.state)) {
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
function updateSelection() {
  document.querySelector('#selection').textContent = selection.size ? `${selection.size} vacantes seleccionadas.` : 'También puedes seleccionar vacantes del panel.';
}
function renderDashboard(state) {
  const visible = state.jobs.filter(job => !filter.value || job.state === filter.value || (filter.value === 'review' && job.state === 'needs_input'));
  const available = new Set(state.jobs.filter(job => !job.closed && ['detected', 'review', 'ready', 'filled', 'needs_input', 'error', 'interrupted'].includes(job.state)).map(job => job.id));
  for (const id of selection) if (!available.has(id)) selection.delete(id);
  updateSelection();
  document.querySelector('#count').textContent = `${visible.length} de ${state.jobs.length}`;
  jobsContainer.replaceChildren(...(visible.length ? visible.map(render) : [element('div', 'No hay candidaturas en esta vista.', 'empty')]));
  autoToggle.textContent = state.monitor.auto ? 'Pausar envío automático' : 'Activar envío automático';
  autoToggle.setAttribute('aria-pressed', String(state.monitor.auto));
  autoToggle.disabled = !state.monitor.auto && (!state.aiConfigured || !state.monitor.sources.some(source => source.enabled && source.lastSuccess));
  document.querySelector('#monitor-status').textContent = `${state.automaticToday} de 10 intentos automáticos hoy`;
  document.querySelector('#monitor-help').textContent = state.aiConfigured ? 'Consulta cada cinco minutos. La primera lectura de cada fuente queda para revisión.' : 'La puntuación local y los borradores están disponibles. Configura la IA en el archivo local para activar el envío automático.';
  document.querySelector('#sources').replaceChildren(...state.monitor.sources.map(source => {
    const row = element('div', null, 'source-row');
    const info = element('div');
    info.append(link(source.token, source.url), element('p', `${source.type} · ${source.count} abiertas${source.error ? ` · ${source.error}` : ''}${source.lastSuccess ? ` · ${new Date(source.lastSuccess).toLocaleString('es')}` : ''}`, 'meta'));
    const button = element('button', source.enabled ? 'Pausar fuente' : 'Reanudar fuente');
    button.addEventListener('click', () => perform('/api/monitor', { id: source.id, enabled: !source.enabled }, button));
    row.append(info, button);
    return row;
  }));
}
async function refresh() {
  const response = await fetch('/api/jobs');
  if (!response.ok) throw new Error('El servidor local no responde.');
  const state = await response.json();
  token = state.token;
  current = state;
  const key = JSON.stringify(state);
  if (key === previous) return;
  previous = key;
  renderDashboard(state);
}
async function perform(path, values, button) {
  button.disabled = true;
  showError('');
  try { if (!token) await refresh(); await post(path, values); await refresh(); return true; }
  catch (error) { showError(error.message); return false; }
  finally { button.disabled = false; }
}
filter.addEventListener('change', () => { if (current) renderDashboard(current); });
sourceForm.addEventListener('submit', async event => {
  event.preventDefault();
  const url = new FormData(sourceForm).get('url');
  if (await perform('/api/sources', { url }, sourceForm.querySelector('button'))) sourceForm.reset();
});
autoToggle.addEventListener('click', () => perform('/api/monitor', { auto: !current.monitor.auto }, autoToggle));
const scan = document.querySelector('#scan');
scan.addEventListener('click', () => perform('/api/scan', {}, scan));
form.addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  showError('');
  try {
    if (!token) await refresh();
    await post('/api/batch', { ...values, urls: values.urls.split(/\s+/).filter(Boolean), ids: [...selection], auto: event.submitter?.value === 'auto' });
    selection.clear();
    updateSelection();
    await refresh();
  } catch (error) { showError(error.message); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
});
async function poll() {
  try { await refresh(); } catch (error) { showError(error.message); }
  setTimeout(poll, 1200);
}
void poll();
