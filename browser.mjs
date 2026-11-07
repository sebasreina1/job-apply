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
    return {
      title: String(posting?.title || document.querySelector('h1, .posting-headline h2, .app-title')?.innerText || document.title).trim(),
      company: String(posting?.hiringOrganization?.name || ''),
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
  return { title: info.title.slice(0, 200), company: info.company.slice(0, 120), description, target };
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

export async function inspectForm(page, target, profile, pdf, fill = true) {
  if (provider(page.url())?.key !== target.key) return { missing: ['La página cambió o pide iniciar sesión. Abre el formulario de la vacante en el navegador.'] };
  const forms = page.locator('form').filter({ has: page.locator('input[type="file"]') });
  if (await forms.count() !== 1) return { missing: ['No se encontró un único formulario con carga de CV. Revisa la pestaña de la vacante.'] };
  const form = forms.first();
  const fields = form.locator('input, textarea, select, [role="combobox"], [contenteditable="true"]');
  const missing = [];
  const filled = [];
  const identity = profile.identity;
  let cv = false;
  const known = new Set();
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
        group, required: Boolean(el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(label || group || nearby)),
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
      if (isCv && !cv) {
        if (fill && !field.value) {
          try { await input.setInputFiles(pdf, { timeout: 6000 }); filled.push(label); }
          catch { missing.push('Carga del CV'); continue; }
        }
        cv = Boolean(field.value || (await input.evaluate(el => el.files?.length)));
      } else if (field.required && !field.value) missing.push(label);
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
      if ((await input.inputValue()).trim()) known.add(key);
    } else if (field.required && (!field.valid || !field.value.trim())) missing.push(label);
  }
  if (!known.has('email') || !(known.has('name') || (known.has('firstName') && known.has('lastName')))) missing.push('Identidad y correo en campos reconocidos');
  if (!cv) missing.push('CV adjunto reconocido');
  if (!(await form.evaluate(el => el.checkValidity()))) missing.push('El portal marca campos inválidos o incompletos');
  const button = form.getByRole('button', { name: /^(submit( application)?|send application|apply now|apply for this job|envoyer( ma candidature)?|postuler|soumettre( la candidature)?|enviar( solicitud| candidatura)?)$/i });
  if (await button.count() !== 1 || !(await button.isEnabled()) || !(await button.isVisible())) missing.push('Botón de envío inequívoco');
  return { missing: [...new Set(missing)], filled, button };
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
