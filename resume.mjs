import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cardsFor, wordingFor } from './matching.mjs';

const run = promisify(execFile);
export const languages = ['en', 'fr', 'es'];
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function hasTerm(description, term) {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(description);
}

export function tailor(profile, job, language, wording = []) {
  if (!languages.includes(language)) throw new Error('Selecciona inglés, francés o español.');
  const description = normalize(`${job.title} ${job.description}`);
  const title = normalize(job.title);
  const score = item => item.tags.reduce((total, tag) => total + Number(hasTerm(description, tag)) + 3 * Number(hasTerm(title, tag)), 0);
  const focus = [...profile.focus].sort((a, b) => score(b) - score(a))[0];
  const slots = { ...profile.text[language], ...focus.text[language] };
  const selected = [];
  const fallbacks = {};
  const cards = new Map(cardsFor(profile, language).map(card => [card.id, card]));
  const choices = new Map(wording.map(choice => [choice.id, choice]));
  for (const [groupIndex, group] of profile.experience.entries()) {
    const ranked = [...group.items].sort((a, b) => score(b) - score(a)).slice(0, group.slots.length);
    for (const [index, item] of ranked.entries()) {
      const placement = group.slots[index];
      const id = `g${groupIndex}-${group.items.indexOf(item)}`;
      fallbacks[placement] = item.text[language];
      slots[placement] = wordingFor(cards.get(id), choices.get(id), language) || item.text[language];
      selected.push(item);
    }
  }
  const terms = [...new Set([...focus.tags, ...selected.flatMap(item => item.tags)])].filter(tag => hasTerm(description, tag));
  return { language, slots, fallbacks, terms, focus: focus.label, evidence: selected.map(item => item.text[language].replaceAll('**', '')) };
}

function escapeTex(text) {
  const map = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
  return text.split('**').map((part, index) => {
    const safe = part.replace(/[\\{}#$%&_^~]/g, char => map[char]);
    return index % 2 ? `\\textbf{${safe}}` : safe;
  }).join('').replaceAll('\n', '\\\\ ');
}

export function renderTemplate(template, slots) {
  for (const [id, value] of Object.entries(slots)) {
    const [x, y] = id.split(':');
    const blocks = [...template.matchAll(/^\\place\{([\d.]+)\}\{([\d.]+)\}[^\n]*(?:\n(?!\\place|\\end\{document\})[^\n]*)*/gm)];
    const block = blocks.find(match => Number(match[1]) === Number(x) && Number(match[2]) === Number(y));
    if (!block) throw new Error(`Falta una posición del diseño: ${id}`);
    const marker = /(?:\\textbullet\}|\\centering |\\raggedright )/g;
    const last = [...block[0].matchAll(marker)].at(-1);
    if (!last || !block[0].trimEnd().endsWith('\\par}')) throw new Error(`Posición incompatible: ${id}`);
    const begin = block.index + last.index + last[0].length;
    const end = block.index + block[0].lastIndexOf('\\par}');
    template = template.slice(0, begin) + escapeTex(value) + template.slice(end);
  }
  return template;
}

export async function createResume({ templateDir, outputDir, result }) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const template = await readFile(join(templateDir, 'main.tex'), 'utf8');
  await cp(join(templateDir, 'assets'), join(outputDir, 'assets'), { recursive: true });
  const localized = result.language === 'es' ? template.replace('\\textbf{Certification}', '\\textbf{Certificación}') : template;
  const compile = async slots => {
    const rendered = checkLayout(renderTemplate(localized, slots), Object.keys(slots));
    await writeFile(join(outputDir, 'cv.tex'), rendered, { mode: 0o600 });
    await run(process.env.TECTONIC_BIN || 'tectonic', ['--untrusted', 'cv.tex'], { cwd: outputDir, timeout: 45000 });
  };
  try {
    try { await compile(result.slots); }
    catch (error) {
      if (!String(error.stderr).includes('CV SLOT OVERFLOW') || !result.fallbacks) throw error;
      await compile({ ...result.slots, ...result.fallbacks });
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Tectonic no está instalado o no se encuentra en PATH.');
    if (String(error.stderr).includes('CV SLOT OVERFLOW')) throw new Error('El texto supera el espacio de la plantilla. Revisa la versión breve del perfil.');
    throw new Error(`No se pudo compilar el CV. ${String(error.stderr || error.message).split('\n').find(line => /error/i.test(line)) || ''}`);
  }
  return join(outputDir, 'cv.pdf');
}

function checkLayout(template, ids) {
  const slots = new Set(ids.map(id => id.split(':').map(Number).join(':')));
  const blocks = [...template.matchAll(/^\\place\{([\d.]+)\}\{([\d.]+)\}\{([\d.]+)\}\{([^\n]*(?:\n(?!\\place|\\end\{document\})[^\n]*)*)/gm)];
  for (const match of blocks.reverse()) {
    const [, x, y, width, raw] = match;
    if (!slots.has(`${Number(x)}:${Number(y)}`)) continue;
    const next = Math.min(842.25, ...blocks.filter(block => Number(block[1]) === Number(x) && Number(block[2]) > Number(y)).map(block => Number(block[2])));
    const height = next - Number(y);
    const contents = raw.trimEnd().slice(0, -1);
    const test = `\\begingroup\\setbox0=\\vbox{\\hsize=${width}bp ${contents}}` +
      `\\ifdim\\dimexpr\\ht0+\\dp0\\relax>${height.toFixed(3)}bp\\errmessage{CV SLOT OVERFLOW ${x}:${y}}\\fi\\endgroup\n`;
    template = template.slice(0, match.index) + test + template.slice(match.index);
  }
  return template;
}
