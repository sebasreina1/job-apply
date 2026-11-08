import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';

const require = createRequire(import.meta.url);
const lever = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);
const greenhouse = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io']);

export function jobURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Pega una URL completa de la vacante.'); }
  const host = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host) || !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost')) {
    throw new Error('Usa una URL HTTPS pública de la vacante.');
  }
  url.hash = '';
  return url;
}

export function provider(value) {
  const url = jobURL(value);
  const path = url.pathname.split('/').filter(Boolean);
  if (lever.has(url.hostname) && /^[\w-]+$/.test(path[0] || '') && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(path[1] || '') && (path.length === 2 || (path.length === 3 && path[2] === 'apply'))) {
    return { name: 'Lever', key: `lever/${path[0]}/${path[1].toLowerCase()}`, apply: `${url.origin}/${path[0]}/${path[1]}/apply${url.search}` };
  }
  if (greenhouse.has(url.hostname) && /^[\w-]+$/.test(path[0] || '') && path[1] === 'jobs' && /^\d+$/.test(path[2] || '') && path.length === 3) {
    return { name: 'Greenhouse', key: `greenhouse/${path[0]}/${path[2]}`, apply: url.href };
  }
  return null;
}

export function browserLibrary() {
  try { return require('playwright-core'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
    try { return require(bundled); } catch { throw new Error('Instala la dependencia del navegador con npm install.'); }
  }
}

export async function openBrowser(directory) {
  const { chromium } = browserLibrary();
  return chromium.launchPersistentContext(directory, { channel: 'chrome', headless: false, chromiumSandbox: true, acceptDownloads: false, timeout: 20000 });
}

export function manualPortal(url) {
  const host = jobURL(url).hostname;
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

export async function readJob(page, inputURL, pastedDescription) {
  try {
    await page.goto(inputURL, { waitUntil: 'domcontentloaded', timeout: 22000 });
    jobURL(page.url());
  } catch (error) {
    if (!pastedDescription) throw error;
    return { title: new URL(inputURL).hostname, company: '', description: pastedDescription.slice(0, 30000), target: null };
  }
  const info = await page.evaluate(() => {
    const queue = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(node => {
      try { return [JSON.parse(node.textContent)]; } catch { return []; }
    });
    let posting;
    while (queue.length && !posting) {
      const item = queue.shift();
      if (Array.isArray(item)) queue.push(...item);
      else if (item && typeof item === 'object') {
        if ([item['@type']].flat().includes('JobPosting')) posting = item;
        else if (item['@graph']) queue.push(item['@graph']);
      }
    }
    const description = new DOMParser().parseFromString(typeof posting?.description === 'string' ? posting.description : '', 'text/html').body.textContent;
    const main = document.querySelector('main, [role="main"], #content, .posting-page') || document.body;
    const locations = [posting?.jobLocation].flat().map(place => place?.address).filter(Boolean).flatMap(address =>
      typeof address === 'string' ? [address] : [address.addressLocality, address.addressRegion, address.addressCountry?.name || address.addressCountry]);
    const location = locations.filter(value => typeof value === 'string').join(', ') || document.querySelector('.posting-categories .location, .location, [itemprop="jobLocation"]')?.innerText || '';
    return {
      title: String(posting?.title || document.querySelector('h1, .posting-headline h2, .app-title')?.innerText || document.title).trim(),
      company: String(posting?.hiringOrganization?.name || ''),
      location: location.trim().slice(0, 300),
      description: description.trim() || main.innerText.trim(),
      applyLinks: [...document.querySelectorAll('a[href], iframe[src]')].filter(node => node.tagName === 'IFRAME' || /apply|postuler|candidature|aplicar/i.test(node.textContent + ' ' + node.getAttribute('aria-label'))).map(node => node.href || node.src),
    };
  });
  const possible = new Map();
  for (const link of info.applyLinks) {
    try { const match = provider(link); if (match) possible.set(match.key, match); } catch { /* Non-job link */ }
  }
  const target = provider(page.url()) || (possible.size === 1 ? possible.values().next().value : null);
  const description = (pastedDescription || info.description).slice(0, 30000);
  if (description.length < 80 || (!pastedDescription && /^(sign in|just a moment|access denied|page not found|verify you are human)/i.test(info.title))) {
    throw new Error('No pude leer una descripción completa. Pega el texto de la oferta en la opción manual.');
  }
  return { title: info.title.slice(0, 200), company: info.company.slice(0, 120), location: info.location, description, target };
}

const fieldNames = {
  firstName: /^(first name|given name|prenom|nombre)$/, lastName: /^(last name|family name|surname|nom|apellido|apellidos)$/,
  name: /^(full name|name|nom complet|nombre completo)$/, email: /^(email|email address|e mail|courriel|correo electronico)$/,
  phone: /^(phone|phone number|mobile phone|telephone|numero de telephone|telefono)$/,
  linkedin: /^(linkedin( profile)?( url)?|profil linkedin)$/, github: /^(github( profile)?( url)?|profil github)$/,
  location: /^(current location|location|localisation actuelle|ubicacion actual)$/,
  country: /^(current country|country of residence|pays de residence|pais de residencia)$/,
  city: /^(current city|ville actuelle|ciudad actual)$/,
  currentCompany: /^(current company|current employer|employeur actuel|empresa actual)$/,
};
const autoComplete = { 'given-name': 'firstName', 'family-name': 'lastName', name: 'name', email: 'email', tel: 'phone' };
const safeNames = { first_name: 'firstName', last_name: 'lastName', name: 'name', email: 'email', phone: 'phone', org: 'currentCompany', 'urls[LinkedIn]': 'linkedin', 'urls[GitHub]': 'github' };
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export function fieldKey(field) {
  const label = normalize(field.label).replace(/^your /, '');
  const direct = Object.entries(fieldNames).find(([, pattern]) => pattern.test(label))?.[0];
  if (label) return direct;
  return Object.hasOwn(safeNames, field.name) ? safeNames[field.name] : autoComplete[field.autocomplete];
}

const finishLabel = /^(submit( application)?|send application|apply now|apply for this job|envoyer( ma candidature)?|postuler|soumettre( la candidature)?|enviar( solicitud| candidatura)?)$/i;
const nextLabel = /^(next( step)?|continue( to (review|application|next step))?|review application|suivant(e)?|continuer|siguiente|continuar|revisar (solicitud|candidatura))$/i;

export function onApplication(pageUrl, target) {
  try {
    const url = jobURL(pageUrl);
    if (url.origin !== new URL(target.apply).origin) return false;
    if (provider(url.href)?.key === target.key) return true;
    // Some portals encode an intermediate step in the path rather than in the query.
    const path = url.pathname.replace(/\/(?:apply|application)(?:\/(?:step\/)?(?:review|resume|questions|contact|\d+))?\/?$/i, '');
    return path !== url.pathname && provider(`${url.origin}${path}`)?.key === target.key;
  } catch { return false; }
}

function sameDestination(value, target) {
  const url = new URL(value);
  if (url.origin !== new URL(target.apply).origin || url.username || url.password) return false;
  const recognized = provider(url.href);
  return !recognized || recognized.key === target.key;
}

export async function inspectForm(page, target, profile, pdf, fill = true, replaceCv = false, progress = { identity: [], cv: false }, unattended = false) {
  if (!onApplication(page.url(), target)) return { missing: ['La página cambió o pide iniciar sesión. Revisa la pestaña de la vacante.'] };
  const actionable = page.getByRole('button', { name: new RegExp(`${finishLabel.source}|${nextLabel.source}`, 'i') }).filter({ visible: true });
  const forms = page.locator('form, [role="form"]').filter({ visible: true, has: actionable });
  if (await forms.count() === 0) await forms.first().waitFor({ state: 'visible', timeout: 3500 }).catch(() => {});
  if (await forms.count() !== 1) return { missing: ['No se encontró un único formulario de candidatura. Revisa la pestaña de la vacante.'] };
  const form = forms.first();
  const destination = await form.evaluate(el => el.getAttribute('action') ? new URL(el.getAttribute('action'), location.href).href : location.href);
  if (!sameDestination(destination, target)) return { missing: ['El formulario apunta a otro sitio.'] };
  const submit = form.getByRole('button', { name: finishLabel }).filter({ visible: true });
  const next = form.getByRole('button', { name: nextLabel }).filter({ visible: true });
  const [submits, nexts] = await Promise.all([submit.count(), next.count()]);
  if (submits + nexts !== 1) return { missing: ['No se encontró un único botón para avanzar o enviar.'] };
  const kind = nexts ? 'next' : 'submit';
  const button = nexts ? next : submit;
  const action = await button.evaluate(el => el.getAttribute('formaction') ? new URL(el.getAttribute('formaction'), location.href).href : location.href);
  if (!sameDestination(action, target)) return { missing: ['El botón apunta a otro sitio.'] };
  const fields = form.locator('input, textarea, select, [role="combobox"], [contenteditable="true"]');
  const missing = [];
  const filled = [];
  const identity = profile.identity;
  let cv = progress.cv;
  let cvField = false;
  const known = new Set(progress.identity);
  const count = await fields.count();
  for (let i = 0; i < count; i++) {
    const input = fields.nth(i);
    if (!(await input.isEnabled())) continue;
    const field = await input.evaluate(el => {
      const label = [...(el.labels || [])].map(item => item.innerText).join(' ') || el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      const group = el.closest('fieldset')?.querySelector('legend')?.innerText || '';
      const nearby = el.closest('.application-question, .field, .form-field, .file-upload')?.querySelector('label, legend')?.innerText || '';
      return {
        type: el.type || el.getAttribute('role') || el.tagName.toLowerCase(), name: el.name || '',
        label: label || group || nearby || '', autocomplete: el.autocomplete || '',
        group, required: Boolean(el.required || el.getAttribute('aria-required') === 'true' || /[*✱＊]/.test(label || group || nearby)),
        valid: el.validity?.valid !== false, value: el.type === 'file' ? el.files?.[0]?.name || '' : el.value || el.textContent || '',
        checked: el.checked, tag: el.tagName,
      };
    });
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(field.type)) continue;
    if (field.type !== 'file' && !(await input.isVisible())) continue;
    if (field.type === 'password') { missing.push('Inicio de sesión'); continue; }
    const label = field.label || field.name || 'Campo sin etiqueta';
    if (field.type === 'file') {
      const isCv = /résumé|resume|curriculum|\bcv\b/i.test(label) || field.name === 'resume';
      if (isCv && !cvField) {
        cvField = true;
        if (fill && (!field.value || replaceCv)) {
          try { await input.setInputFiles(pdf, { timeout: 6000 }); filled.push(label); }
          catch { missing.push('Carga del CV'); continue; }
        }
        cv = Boolean(field.value || (await input.evaluate(el => el.files?.length)));
      } else if (field.required && !field.value) missing.push(label);
      continue;
    }
    if (unattended && field.required && /authori[sz]|sponsorship|work permit|right to work|citizenship|visa|consent|agree|privacy|certif|declar|autoriza|permis de travail|traitement des donnees|accepte/.test(normalize(label))) {
      missing.push(label);
      continue;
    }
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (field.required && (!field.valid || (field.type === 'checkbox' && !field.checked))) missing.push(field.group || label);
      continue;
    }
    const key = fieldKey(field);
    const relocation = /^(are you willing to relocate to france|willing to relocate to france|etes vous pret a demenager en france|estas dispuesto a mudarte a francia)$/.test(normalize(field.label));
    if (fill && field.tag === 'SELECT' && (key === 'country' || relocation) && !field.value.trim()) {
      const options = await input.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
      const answer = relocation && identity.relocateToFrance === true ? /^(yes|oui|si)$/ : key === 'country' && identity.country ? new RegExp(`^${normalize(identity.country)}$`) : null;
      const matched = options.filter(option => option.value && answer?.test(normalize(option.label)));
      if (matched.length === 1) {
        await input.selectOption(matched[0].value, { timeout: 4000 });
        filled.push(label);
        continue;
      }
    }
    if (key && ['text', 'email', 'tel', 'url', 'search'].includes(field.type) && identity[key]) {
      if (fill && !field.value.trim()) {
        try { await input.fill(identity[key], { timeout: 4000 }); filled.push(label); }
        catch { missing.push(label); continue; }
      }
      if ((await input.inputValue()).trim() && await input.evaluate(el => el.validity?.valid !== false)) known.add(key);
      else if (field.required) missing.push(label);
    } else if (field.required && (!field.valid || !field.value.trim())) missing.push(label);
  }
  if (kind === 'submit') {
    if (!known.has('email') || !(known.has('name') || (known.has('firstName') && known.has('lastName')))) missing.push('Identidad y correo en campos reconocidos');
    if (!cv) missing.push('CV adjunto reconocido');
    if (!(await form.evaluate(el => !el.checkValidity || el.checkValidity()))) missing.push('El portal marca campos inválidos o incompletos');
  }
  if (!(await button.isEnabled())) missing.push('El botón para continuar todavía no está disponible');
  return { missing: [...new Set(missing)], filled, button, form, kind, progress: { identity: [...known], cv } };
}

function pageSignature(previous) {
  const signature = JSON.stringify([location.href, [...document.querySelectorAll('h1, h2, form input, form select, form textarea, form button, [role="form"] input, [role="form"] button')]
    .filter(node => node.getClientRects().length)
    .map(node => [node.tagName, node.id, node.getAttribute('name'), node.getAttribute('type'), node.matches('h1,h2,button') ? node.textContent?.trim() : ''])]);
  return previous === undefined ? signature : signature !== previous;
}

export async function formSnapshot(form) {
  return form.evaluate(element => Array.from(element.elements || element.querySelectorAll('input, select, textarea')).filter(field =>
    field.name && !['hidden', 'password', 'submit', 'button', 'reset'].includes(field.type) && (field.getClientRects().length || field.type === 'file')
  ).map(field => ({ name: field.name, label: field.labels?.[0]?.textContent?.trim(), value: field.type === 'file' ? [...field.files].map(file => file.name) : ['radio', 'checkbox'].includes(field.type) ? { checked: field.checked, value: field.value } : field.value })));
}

export async function advanceApplication(page, target, profile, pdf, { progress, unattended = false, canAdvance = () => true, onStep = async () => {} } = {}) {
  let current = progress || { identity: [], cv: false, steps: [] };
  while (current.steps.length < 8) {
    if (!canAdvance()) return { stopped: true, progress: current };
    const step = await inspectForm(page, target, profile, pdf, true, true, current, unattended);
    if (step.missing.length || step.kind === 'submit') return { ...step, progress: { ...current, ...step.progress } };
    const signature = await page.evaluate(pageSignature);
    const fields = await formSnapshot(step.form);
    if (!canAdvance()) return { stopped: true, progress: current };
    try {
      await step.button.click({ timeout: 8000 });
      await page.waitForFunction(pageSignature, signature, { timeout: 10000 });
    } catch {
      return { missing: ['El portal no confirmó el avance a la pantalla siguiente.'], progress: current };
    }
    if (!onApplication(page.url(), target)) return { missing: ['La pantalla siguiente requiere tu intervención.'], progress: current };
    current = { ...step.progress, steps: [...current.steps, { url: JSON.parse(signature)[0], fields }] };
    await onStep(current.steps.length);
  }
  return { missing: ['Se alcanzó el límite de pantallas de la candidatura.'], progress: current };
}

export async function waitForReceipt(page) {
  // Explicit acceptance wording, never an HTTP success status alone.
  const receipt = /thank you for (?:applying|your application)|your application (?:has been|was|is) (?:submitted|received)|application submitted successfully|merci pour votre candidature|votre candidature a bien été (?:reçue|envoyée)|hemos recibido tu (?:candidatura|solicitud)/i;
  const locator = page.getByText(receipt).filter({ visible: true }).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    return (await locator.innerText()).trim().slice(0, 300);
  } catch { return null; }
}
