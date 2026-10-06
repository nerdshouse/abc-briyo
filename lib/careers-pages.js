/**
 * careers.briyo.xyz pages, rendered on the server: crawlers and people get the
 * same HTML, with or without JavaScript. Only public job fields are used
 * (publicJobView + sections) — never ids, counts, actors or candidate data.
 *
 * Text written by HR is plain text with "- " bullets; it is escaped here and
 * never interpreted as HTML.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { careersBaseUrl, publicJobView, SECTION_KEYS, CONSENT_TEXT, HR_RETENTION_MONTHS, UPLOAD_TOKEN_MINUTES } from './hr.js';

// Asset URLs carry a hash of the file, so a deploy is never served a stale script.
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'careers');
const versions = new Map();
export function asset(name) {
  if (!versions.has(name)) {
    let v = 'x';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(ASSET_DIR, name))).digest('hex').slice(0, 10); } catch { /* missing file: 404 later */ }
    versions.set(name, v);
  }
  return `/assets/${name}?v=${versions.get(name)}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The brand, in one place. Swap the text for the SVG logo when it arrives:
 * return `<a class="brand" href="/" aria-label="Briyo careers"><svg …/></a>`.
 */
export const BRAND_NAME = 'Briyo';
const brand = () => `<a class="brand" href="/" aria-label="${BRAND_NAME} careers home"><span class="brand-word">${BRAND_NAME}</span><span class="brand-sub">Careers</span></a>`;

const EMPLOYMENT = { full_time: 'Full-time', part_time: 'Part-time', internship: 'Internship', contract: 'Contract', freelance: 'Freelance' };
const MODE = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
const PERIOD = { year: 'per year', month: 'per month', hour: 'per hour' };
const SECTION = {
  about: 'About the role', responsibilities: 'What you will do', requirements: 'What we are looking for', nice_to_have: 'Nice to have',
  benefits: 'What we offer', hiring_process: 'Hiring process', additional: 'Additional information',
};
// schema.org employmentType values.
const LD_EMPLOYMENT = { full_time: 'FULL_TIME', part_time: 'PART_TIME', internship: 'INTERN', contract: 'CONTRACTOR', freelance: 'CONTRACTOR' };
const LD_PERIOD = { year: 'YEAR', month: 'MONTH', hour: 'HOUR' };

const facts = (j) => [j.department, j.work_mode === 'remote' ? null : j.location, MODE[j.work_mode], EMPLOYMENT[j.employment_type]].filter(Boolean);
function experienceText(e) {
  if (!e) return null;
  if (e.max === null) return `${e.min}+ years`;
  if (e.min === null) return `Up to ${e.max} years`;
  return e.min === e.max ? `${e.min} years` : `${e.min}–${e.max} years`;
}
function salaryText(s) {
  if (!s) return null;
  const f = new Intl.NumberFormat('en-IN', { style: 'currency', currency: s.currency || 'INR', maximumFractionDigits: 0 });
  return `${f.format(s.min)} – ${f.format(s.max)}${s.period ? ` ${PERIOD[s.period]}` : ''}`;
}

/** Plain text → paragraphs and lists. Every character is escaped. */
export function richText(src) {
  const out = []; let list = []; let para = [];
  const flushList = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`); list = []; };
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(esc).join('<br>')}</p>`); para = []; };
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s+/.test(line)) { flushPara(); list.push(line.replace(/^-\s+/, '')); } else if (!line) { flushPara(); flushList(); } else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

/** JSON inside <script>: no way to close the tag or open a comment. */
const ldJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function page({ title, description, canonical, noindex = false, body, ld = null, scripts = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND_NAME} Careers">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#ffffff">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${asset('careers.css')}">
${ld ? `<script type="application/ld+json">${ldJson(ld)}</script>` : ''}
${scripts.map((s) => `<script src="${esc(s)}" defer></script>`).join('\n')}
</head>
<body>
<header class="site-head"><div class="wrap">${brand()}</div></header>
<main id="main">${body}</main>
<footer class="site-foot"><div class="wrap"><span>© ${new Date().getFullYear()} ${BRAND_NAME}</span><a href="/">All open roles</a></div></footer>
</body>
</html>`;
}

function jobCard(v) {
  return `<li class="job-card"><a href="/${esc(v.slug)}/apply">
    <span class="job-card-title">${esc(v.title)}</span>
    <span class="job-card-facts">${facts(v).map(esc).join('<span class="dot" aria-hidden="true">·</span>')}</span>
    ${v.summary ? `<span class="job-card-summary">${esc(v.summary)}</span>` : ''}
    <span class="job-card-cta" aria-hidden="true">View role →</span></a></li>`;
}

export function homePage(jobs) {
  const base = careersBaseUrl();
  const body = `
  <section class="hero"><div class="wrap">
    <h1>Open roles at ${BRAND_NAME}</h1>
    <p class="lead">Explore our current opportunities and apply online.</p>
  </div></section>
  <section class="wrap jobs">
    <h2 class="section-title">Current roles <span class="count">${jobs.length}</span></h2>
    ${jobs.length ? `<ul class="job-list">${jobs.map(jobCard).join('')}</ul>`
      : '<div class="empty"><p><b>No open roles right now.</b></p><p>New roles are posted here first. Please check back soon.</p></div>'}
  </section>`;
  return page({
    title: `Careers at ${BRAND_NAME}`,
    description: jobs.length ? `${jobs.length} open role${jobs.length === 1 ? '' : 's'} at ${BRAND_NAME}. See the roles and apply online.` : `Careers at ${BRAND_NAME}. See open roles and apply online.`,
    canonical: `${base}/`, body,
  });
}

/** JobPosting structured data — only for a published job. */
export function jobPostingLd(job) {
  const v = publicJobView(job);
  const description = [v.summary ? `<p>${esc(v.summary)}</p>` : '', ...SECTION_KEYS.filter((k) => job.sections?.[k]).map((k) => `<h3>${esc(SECTION[k])}</h3>${richText(job.sections[k])}`)].join('');
  const ld = {
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title: v.title, description: description || esc(v.title),
    identifier: { '@type': 'PropertyValue', name: BRAND_NAME, value: v.public_id },
    datePosted: v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : undefined,
    hiringOrganization: { '@type': 'Organization', name: BRAND_NAME },
    directApply: true,
    url: v.public_url,
  };
  if (LD_EMPLOYMENT[v.employment_type]) ld.employmentType = LD_EMPLOYMENT[v.employment_type];
  if (v.work_mode === 'remote') ld.jobLocationType = 'TELECOMMUTE';
  if (v.location) ld.jobLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: v.location } };
  if (v.salary) {
    ld.baseSalary = { '@type': 'MonetaryAmount', currency: v.salary.currency,
      value: { '@type': 'QuantitativeValue', minValue: v.salary.min, maxValue: v.salary.max, ...(v.salary.period ? { unitText: LD_PERIOD[v.salary.period] } : {}) } };
  }
  if (job.experience_min !== null) ld.experienceRequirements = { '@type': 'OccupationalExperienceRequirements', monthsOfExperience: Math.round(job.experience_min * 12) };
  return ld;
}

function field({ name, label, type = 'text', required = false, help = '', autocomplete = '', max = 200, textarea = false, rows = 4, inputmode = '' }) {
  const id = `f-${name}`;
  const attrs = `id="${id}" name="${name}"${required ? ' required aria-required="true"' : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''} maxlength="${max}" aria-describedby="${id}-err${help ? ` ${id}-help` : ''}"`;
  return `<div class="field" data-field="${name}">
    <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ' <span class="opt">(optional)</span>'}</label>
    ${textarea ? `<textarea ${attrs} rows="${rows}"></textarea>` : `<input ${attrs} type="${type}"${inputmode ? ` inputmode="${inputmode}"` : ''}>`}
    ${help ? `<p class="help" id="${id}-help">${esc(help)}</p>` : ''}
    <p class="err" id="${id}-err" role="alert"></p>
  </div>`;
}

function applicationForm(job, { formToken, siteKey }) {
  const v = publicJobView(job);
  const unavailable = !siteKey;
  return `<section class="apply" id="apply" aria-labelledby="apply-title">
    <h2 id="apply-title">Apply for this role</h2>
    ${unavailable ? '<div class="notice warn" role="status">Online applications are briefly unavailable. Please check back shortly.</div>' : ''}
    <noscript><div class="notice warn">The application form needs JavaScript. Please enable it to apply.</div></noscript>
    <form id="applyForm" class="form" method="post" novalidate data-public-id="${esc(v.public_id)}" data-form-token="${esc(formToken)}"${unavailable ? ' data-disabled="1"' : ''}>
      <div class="form-error" id="formError" role="alert" hidden></div>
      <fieldset><legend>About you</legend>
        ${field({ name: 'full_name', label: 'Full name', required: true, autocomplete: 'name', max: 120 })}
        <div class="row2">
          ${field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'email', max: 254 })}
          ${field({ name: 'phone', label: 'Phone', type: 'tel', required: true, autocomplete: 'tel', max: 32, help: 'With country code, e.g. +91 98765 43210 or +44 20 7946 0958.' })}
        </div>
        ${field({ name: 'location', label: 'Current location', required: true, autocomplete: 'address-level2', max: 120 })}
        <div class="row2">
          ${field({ name: 'linkedin_url', label: 'LinkedIn', type: 'url', max: 300, inputmode: 'url' })}
          ${field({ name: 'portfolio_url', label: 'Portfolio or website', type: 'url', max: 300, inputmode: 'url' })}
        </div>
      </fieldset>
      <fieldset><legend>The role</legend>
        ${field({ name: 'relevant_experience', label: 'Relevant experience', required: true, textarea: true, max: 3000, help: 'A few lines on the work you have done that fits this role.' })}
        <div class="row2">
          ${field({ name: 'notice_period', label: 'Notice period / availability', required: true, max: 200 })}
          ${field({ name: 'expected_compensation', label: 'Expected compensation', max: 200 })}
        </div>
        ${field({ name: 'work_authorization', label: 'Work authorization / eligibility', required: true, max: 300, help: 'For example: Indian citizen, or the visa you hold.' })}
        ${field({ name: 'cover_letter', label: 'Cover letter', textarea: true, rows: 5, max: 5000 })}
      </fieldset>
      <fieldset><legend>Resume</legend>
        <div class="field" data-field="resume">
          <label for="f-resume">Resume <span class="req" aria-hidden="true">*</span></label>
          <input id="f-resume" name="resume" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required aria-required="true" aria-describedby="f-resume-help f-resume-err">
          <p class="help" id="f-resume-help">PDF or Word (.docx), up to 10 MB.</p>
          <p class="err" id="f-resume-err" role="alert"></p>
        </div>
      </fieldset>
      <div class="hp" aria-hidden="true"><label for="f-website">Website</label><input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
      <div class="field consent" data-field="consent">
        <label class="check"><input type="checkbox" id="f-consent" name="consent" required aria-describedby="f-consent-err"> <span>${esc(CONSENT_TEXT)}</span></label>
        <p class="help">If your application is unsuccessful, we keep it for ${HR_RETENTION_MONTHS} months in case another role fits, then remove it.</p>
        <p class="err" id="f-consent-err" role="alert"></p>
      </div>
      ${siteKey ? `<div class="field" data-field="turnstile"><div class="ts-widget" id="tsWidget" data-sitekey="${esc(siteKey)}"></div><p class="err" id="f-turnstile-err" role="alert"></p></div>` : ''}
      <button class="submit" type="submit" id="submitBtn" disabled>Submit application</button>
      <p class="fineprint">Your resume upload link is valid for ${UPLOAD_TOKEN_MINUTES} minutes after you submit.</p>
    </form>
    <div class="done" id="done" hidden tabindex="-1">
      <h2>Application received</h2>
      <p>Thank you for applying for <b>${esc(v.title)}</b>. We have your details and resume.</p>
      <p>We read every application. If your experience fits, we will contact you by email or phone.</p>
      <p><a href="/">See other open roles</a></p>
    </div>
  </section>`;
}

export function jobPage(job, { formToken, siteKey }) {
  const v = publicJobView(job);
  const open = job.status === 'published';
  const exp = experienceText(v.experience);
  const sal = salaryText(v.salary);
  const secs = SECTION_KEYS.filter((k) => job.sections?.[k]);
  const body = `
  <article class="wrap job">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">All roles</a></nav>
    <header class="job-head">
      <h1>${esc(v.title)}</h1>
      <p class="job-facts">${facts(v).map(esc).join('<span class="dot" aria-hidden="true">·</span>')}</p>
      ${exp || sal || v.openings > 1 ? `<dl class="job-meta">${exp ? `<div><dt>Experience</dt><dd>${esc(exp)}</dd></div>` : ''}${sal ? `<div><dt>Salary</dt><dd>${esc(sal)}</dd></div>` : ''}${v.openings > 1 ? `<div><dt>Openings</dt><dd>${v.openings}</dd></div>` : ''}</dl>` : ''}
      ${open ? '<a class="cta" href="#apply">Apply now</a>' : '<div class="notice closed" role="status"><b>Applications for this role are closed.</b> We are no longer accepting applications. <a href="/">See open roles</a>.</div>'}
    </header>
    <div class="job-body">
      ${v.summary ? `<p class="summary">${esc(v.summary)}</p>` : ''}
      ${secs.map((k) => `<section><h2>${esc(SECTION[k])}</h2>${richText(job.sections[k])}</section>`).join('')}
    </div>
    ${open ? applicationForm(job, { formToken, siteKey }) : ''}
  </article>`;
  const desc = (v.summary || `${v.title} at ${BRAND_NAME}.`).slice(0, 300);
  return page({
    title: `${v.title}${open ? '' : ' (closed)'} — Careers at ${BRAND_NAME}`,
    description: desc,
    canonical: v.public_url,
    noindex: !open,
    ld: open ? jobPostingLd(job) : null,
    scripts: open && siteKey ? [asset('careers.js'), 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=briyoTurnstileReady'] : [],
    body,
  });
}

export function notFoundPage() {
  return page({
    title: `Page not found — Careers at ${BRAND_NAME}`, description: 'This page is not available.', canonical: `${careersBaseUrl()}/`, noindex: true,
    body: `<section class="wrap empty-page"><h1>This page is not available</h1><p>The role may have been filled or the link may be mistyped.</p><p><a class="cta" href="/">See open roles</a></p></section>`,
  });
}

export function sitemap(jobs) {
  const base = careersBaseUrl();
  const urls = [`${base}/`, ...jobs.map((j) => j.public_url)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
