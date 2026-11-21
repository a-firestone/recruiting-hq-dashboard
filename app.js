// Recruiting HQ dashboard.
// Reads data/tracker.json (yours, edited here) and data/postings.json (written by the daily checker)
// from your private GitHub repo, using a personal access token kept only in this browser.

const CFG_KEY = 'rhq.config.v1';
const TRACKER = 'data/tracker.json';
const POSTINGS = 'data/postings.json';

// ?local = preview with the files in ../data, nothing is saved (for testing on this computer).
const LOCAL = new URLSearchParams(location.search).has('local');

const state = {
  cfg: LOCAL ? { repo: 'local files', branch: 'local', local: true } : loadCfg(),
  tracker: null,
  sha: null,
  postings: null,
  pending: [],
  saving: false,
  saveTimer: null,
  saveStatus: '',
  loadError: null,
};

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const pretty = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const daysUntil = (iso) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00`) - Date.parse(`${todayISO()}T00:00:00`)) / 86400000);
const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid('co');
const unknown = (v, text = 'Unknown') => (v ? esc(v) : `<span class="unknown">${esc(text)}</span>`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function relTime(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
}
function saveCfg(cfg) {
  state.cfg = cfg;
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* private mode: lasts this visit only */ }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------- GitHub storage

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${state.cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(`GitHub said ${res.status}${detail.message ? `: ${detail.message}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function readRepoFile(path) {
  if (state.cfg.local) {
    const res = await fetch(`../${path}`, { cache: 'no-store' });
    return { data: res.ok ? await res.json() : null, sha: 'local' };
  }
  try {
    const j = await gh(`/repos/${state.cfg.repo}/contents/${path}?ref=${encodeURIComponent(state.cfg.branch)}`);
    const text = j.content ? b64ToText(j.content) : await (await fetch(j.download_url, { cache: 'no-store' })).text();
    return { data: JSON.parse(text), sha: j.sha };
  } catch (err) {
    if (err.status === 404) return { data: null, sha: null };
    throw err;
  }
}

async function writeTracker(message) {
  if (state.cfg.local) return; // preview mode: changes live in memory only
  const j = await gh(`/repos/${state.cfg.repo}/contents/${TRACKER}`, {
    method: 'PUT',
    body: { message, branch: state.cfg.branch, sha: state.sha, content: textToB64(`${JSON.stringify(state.tracker, null, 2)}\n`) },
  });
  state.sha = j.content.sha;
}

async function loadAll() {
  state.loadError = null;
  try {
    const [t, p] = await Promise.all([readRepoFile(TRACKER), readRepoFile(POSTINGS)]);
    if (!t.data) throw new Error(`Couldn't find ${TRACKER} in ${state.cfg.repo}.`);
    state.tracker = normalize(t.data);
    state.sha = t.sha;
    state.postings = p.data || { lastRun: null, companies: {}, postings: {} };
  } catch (err) {
    state.loadError = err;
  }
  render();
}

function normalize(t) {
  for (const k of ['companies', 'contacts', 'applications', 'events', 'suggestions']) t[k] ||= [];
  t.postingDecisions ||= {};
  t.settings ||= {};
  return t;
}

/** Apply a change locally, re-render, and save to GitHub shortly after. Mutators must be safe to re-run. */
function update(mutator, message = 'Update from dashboard') {
  mutator(state.tracker);
  state.pending.push({ mutator, message });
  setSaveStatus('Saving…');
  render();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flush, 700);
}

async function flush() {
  if (state.saving || !state.pending.length) return;
  state.saving = true;
  const batch = state.pending.splice(0);
  const message = batch.length === 1 ? batch[0].message : `Dashboard: ${batch.length} updates`;
  try {
    try {
      await writeTracker(message);
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) throw err;
      // Someone else (another device) saved first: take theirs and replay our changes on top.
      const fresh = await readRepoFile(TRACKER);
      const t = normalize(fresh.data);
      batch.forEach((b) => b.mutator(t));
      state.tracker = t;
      state.sha = fresh.sha;
      await writeTracker(message);
      render();
    }
    setSaveStatus(state.cfg.local ? 'Preview mode: changes are not saved' : 'All changes saved');
  } catch (err) {
    state.pending.unshift(...batch);
    setSaveStatus(`Not saved yet (${err.message}). Retrying…`);
    setTimeout(flush, 6000);
  } finally {
    state.saving = false;
    if (state.pending.length) setTimeout(flush, 300);
  }
}

function setSaveStatus(text) {
  state.saveStatus = text;
  const el = document.getElementById('save-status');
  if (el) el.textContent = text;
}

window.addEventListener('beforeunload', (e) => {
  if (state.pending.length || state.saving) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- lookups

const KINDS = {
  exploring: ['Exploring', ''],
  networking: ['Networking', 'purple'],
  waiting: ['Waiting for postings', ''],
  open: ['Postings open', 'blue'],
  applied: ['Applied', 'blue'],
  interviewing: ['Interviewing', 'orange'],
  offer: ['Offer', 'green'],
};
const APP_STATUSES = [
  ['Unknown', 'Unknown', ''],
  ['Saved', 'Saved', ''],
  ['In discussion', 'In discussion', 'purple'],
  ['Applied', 'Applied', 'blue'],
  ['OA', 'Online assessment', 'purple'],
  ['Interview', 'Interview', 'orange'],
  ['Offer', 'Offer', 'green'],
  ['Rejected', 'Rejected', 'red'],
  ['Withdrawn', 'Withdrawn', ''],
];
const appStatus = (s) => APP_STATUSES.find((x) => x[0] === s) || APP_STATUSES[0];
const SUBMITTED = ['Applied', 'OA', 'Interview', 'Offer', 'Rejected'];
const HEARD_BACK = ['OA', 'Interview', 'Offer', 'Rejected'];
const PASS_REASONS = ['Wrong location', 'Not my role family', 'Not a summer role', 'Too senior', 'Hours or culture concerns'];
const REMOVE_REASONS = ['Office location doesn’t work for full-time', 'No MBA internships in my role families', 'Hours or culture concerns', 'Learned more and it’s not a fit'];

const T = () => state.tracker;
const companyById = (id) => T().companies.find((c) => c.id === id);
const companyName = (id, fallback = '') => companyById(id)?.name || fallback;
const activeCompanies = () => T().companies.filter((c) => !c.removed);
const removedCompanies = () => T().companies.filter((c) => c.removed);
const contactsAt = (id) => T().contacts.filter((c) => c.companyId === id);
const appsAt = (id) => T().applications.filter((a) => a.companyId === id);
const checkInfo = (id) => state.postings?.companies?.[id];
const allPostings = () => Object.values(state.postings?.postings || {});
const decision = (key) => T().postingDecisions[key];
const openMatches = () => allPostings().filter((p) => p.open && !decision(p.key) && !companyById(p.companyId)?.removed).sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));

function companyPill(c) {
  if (c.removed) return '<span class="pill red">Off the table</span>';
  const [label, color] = KINDS[c.statusKind] || KINDS.exploring;
  return `<span class="pill ${color}">${esc(c.status || label)}</span>`;
}

function checkerLine(c) {
  if (c.removed) return 'Not being checked while it’s off the table.';
  if (!c.source) return 'Careers site not connected yet. Ask Claude to connect it.';
  if (c.source.type === 'none') return 'No careers site to watch for this company.';
  const info = checkInfo(c.id);
  if (!info) return 'Not checked yet. It will be included in the next check.';
  if (!info.ok) return `Last check failed (${relTime(info.checkedAt)}): ${info.error}`;
  return `Checked ${relTime(info.checkedAt)}: scanned ${info.scanned} jobs, ${plural(info.matches, 'match')}.`;
}

/** Everything with a due date (or an undated to-do): application deadlines, follow-ups, reminders. */
function dueItems() {
  const t = T();
  const items = [];
  for (const a of t.applications) {
    if (a.deadline && !['Rejected', 'Offer', 'Withdrawn'].includes(a.status)) {
      items.push({ date: a.deadline, title: a.deadlineNote || 'Application deadline', sub: `${companyName(a.companyId)} · ${a.role}`, kind: 'app', id: a.id });
    }
  }
  for (const c of t.contacts) {
    if (c.followUp && !c.followUp.done && (c.followUp.date || c.followUp.note)) {
      items.push({ date: c.followUp.date, title: `Follow up with ${c.name}`, sub: [companyName(c.companyId, c.companyText), c.followUp.note].filter(Boolean).join(' · '), kind: 'follow', id: c.id });
    }
  }
  for (const e of t.events) {
    if (!e.done) items.push({ date: e.date, title: e.title, sub: companyName(e.companyId), kind: 'event', id: e.id });
  }
  return items;
}

function dueBadge(date) {
  if (!date) return '<span class="pill">No date</span>';
  const d = daysUntil(date);
  if (d < 0) return `<span class="pill red">Overdue by ${plural(-d, 'day')}</span>`;
  if (d === 0) return '<span class="pill orange">Today</span>';
  if (d <= (T().settings.reminderDays ?? 3)) return `<span class="pill orange">In ${plural(d, 'day')}</span>`;
  return `<span class="pill">In ${plural(d, 'day')}</span>`;
}

// ---------------------------------------------------------------- routing + render

function route() {
  const [tab = 'postings', id] = location.hash.replace(/^#\/?/, '').split('/');
  return { tab, id: id ? decodeURIComponent(id) : null };
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

const TABS = [
  ['postings', 'New postings'],
  ['applications', 'Applications'],
  ['companies', 'Companies'],
  ['contacts', 'Contacts'],
  ['deadlines', 'Deadlines'],
  ['passed', 'Passed on'],
  ['stats', 'Stats'],
  ['settings', 'Settings'],
];

function render() {
  const app = document.getElementById('app');
  if (!state.cfg) { app.innerHTML = setupView(); return; }
  if (state.loadError) { app.innerHTML = errorView(); return; }
  if (!state.tracker) { app.innerHTML = '<p class="muted">Loading your data…</p>'; return; }
  const r = route();
  const counts = {
    postings: openMatches().length,
    applications: T().applications.length,
    companies: activeCompanies().length,
    contacts: T().contacts.length,
    deadlines: dueItems().filter((i) => i.date && daysUntil(i.date) <= (T().settings.reminderDays ?? 3)).length,
    passed: removedCompanies().length + Object.values(T().postingDecisions).filter((d) => d.status === 'passed').length,
  };
  const views = { postings: postingsView, applications: applicationsView, companies: r.id ? companyView : companiesView, contacts: contactsView, deadlines: deadlinesView, passed: passedView, stats: statsView, settings: settingsView };
  const view = views[r.tab] || postingsView;
  app.innerHTML = `
    ${headerView()}
    ${statsStrip()}
    <nav class="tabs" aria-label="Sections">
      ${TABS.map(([id, label]) => `<a href="#/${id}" ${r.tab === id ? 'aria-current="page"' : ''}>${label}${counts[id] ? ` (${counts[id]})` : ''}</a>`).join('')}
    </nav>
    <section class="stack">${view(r.id)}</section>`;
}

function headerView() {
  const watched = activeCompanies().filter((c) => c.source && c.source.type !== 'none').length;
  return `
  <header class="top">
    <div class="stack" style="gap:4px">
      <h1 class="display">Recruiting HQ</h1>
      <p class="muted small">Last checked ${esc(relTime(state.postings?.lastRun))} · ${plural(watched, 'careers site')} watched · checks daily around 8 AM Eastern</p>
      <p class="muted small" id="save-status" role="status">${esc(state.saveStatus)}</p>
    </div>
    <div class="row">
      <button class="btn" data-act="reload">Refresh</button>
      <button class="btn primary" data-act="runCheck">Run check now</button>
    </div>
  </header>`;
}

function statsStrip() {
  const apps = T().applications;
  const submitted = apps.filter((a) => SUBMITTED.includes(a.status)).length;
  const heard = apps.filter((a) => HEARD_BACK.includes(a.status)).length;
  const active = apps.filter((a) => ['In discussion', 'OA', 'Interview'].includes(a.status)).length;
  const offers = apps.filter((a) => a.status === 'Offer').length;
  const dueSoon = dueItems().filter((i) => i.date && daysUntil(i.date) <= (T().settings.reminderDays ?? 3)).length;
  const stat = (label, value, sub) => `<div class="stat"><span class="small muted">${label}</span><b>${value}</b><span class="small muted">${sub}</span></div>`;
  return `<section class="stats" aria-label="Summary">
    ${stat('New matches', openMatches().length, 'waiting for a decision')}
    ${stat('Applied', submitted, `${apps.filter((a) => a.status === 'Saved').length} saved to apply`)}
    ${stat('In process', active, 'discussions, OAs, interviews')}
    ${stat('Offers', offers, 'so far')}
    ${stat('Response rate', submitted ? `${Math.round((heard / submitted) * 100)}%` : '—', 'heard back / applied')}
    ${stat('Due soon', dueSoon, 'deadlines and follow-ups')}
  </section>`;
}

// ---------------------------------------------------------------- views

function postingsView() {
  const list = openMatches();
  const broken = activeCompanies().filter((c) => checkInfo(c.id)?.ok === false);
  const unconnected = activeCompanies().filter((c) => !c.source);
  const s = T().settings;
  return `
    <div class="row between">
      <p class="muted small">MBA internships at your companies that match a role family (${esc((s.roleTitleTerms || []).slice(0, 6).join(', '))}…). <a href="#/settings">Edit keywords</a></p>
    </div>
    ${broken.length ? `<div class="banner orange"><span>${plural(broken.length, 'careers site')} couldn’t be checked last time: ${broken.map((c) => `<a href="#/companies/${esc(c.id)}">${esc(c.name)}</a>`).join(', ')}.</span></div>` : ''}
    ${unconnected.length ? `<p class="muted small">Not connected to the checker yet: ${unconnected.map((c) => esc(c.name)).join(', ')}.</p>` : ''}
    ${!state.postings?.lastRun ? '<div class="card dashed">The checker hasn’t run yet. Press <b>Run check now</b>, then Refresh in a few minutes.</div>' : ''}
    ${state.postings?.lastRun && !list.length ? '<div class="card dashed">You’re all caught up. New matches show up here after each check.</div>' : ''}
    ${list.map((p) => `
      <article class="card posting">
        <div class="info">
          <span class="small muted"><a href="#/companies/${esc(p.companyId)}"><b>${esc(p.company)}</b></a> · found ${esc(pretty(p.firstSeen))}</span>
          <h3>${esc(p.title)}</h3>
          <span class="small muted">${unknown(p.location, 'Location not listed')}</span>
          <div class="row" style="gap:6px">${(p.terms || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        </div>
        <div class="row">
          <a class="btn link" href="${esc(p.url)}" target="_blank" rel="noopener">View posting</a>
          <button class="btn" data-act="passPosting" data-key="${esc(p.key)}">Pass on this</button>
          <button class="btn" data-act="savePosting" data-key="${esc(p.key)}">Save for later</button>
          <button class="btn dark" data-act="applyPosting" data-key="${esc(p.key)}">Mark applied</button>
        </div>
      </article>`).join('')}`;
}

function statusSelect(a) {
  const [, , color] = appStatus(a.status);
  return `<select class="status pill ${color}" data-change="appStatus" data-id="${esc(a.id)}" aria-label="Status for ${esc(companyName(a.companyId))} ${esc(a.role)}">
    ${APP_STATUSES.map(([v, label]) => `<option value="${v}" ${a.status === v ? 'selected' : ''}>${label}</option>`).join('')}
  </select>`;
}

function referrerFor(appId) {
  return T().contacts.filter((c) => c.referredApplicationId === appId).map((c) => c.name).join(', ');
}

function applicationsView() {
  const order = Object.fromEntries(APP_STATUSES.map(([v], i) => [v, i]));
  const apps = [...T().applications].sort((a, b) => order[b.status] - order[a.status] || (b.applied || '').localeCompare(a.applied || ''));
  return `
    <div class="row between">
      <p class="muted small">Change a status from its dropdown. Jobs you mark applied on New postings land here.</p>
      <button class="btn" data-act="addApp">+ Add application</button>
    </div>
    ${apps.length ? `<div class="table-box"><table>
      <thead><tr><th>Company</th><th>Role</th><th>Status</th><th>Applied</th><th>Deadline</th><th>Referral</th><th>Next step</th><th><span class="sr">Edit</span></th></tr></thead>
      <tbody>${apps.map((a) => `<tr>
        <td><a href="#/companies/${esc(a.companyId)}"><b>${esc(companyName(a.companyId, 'Unknown company'))}</b></a></td>
        <td>${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.role)}</a>` : esc(a.role)}</td>
        <td>${statusSelect(a)}</td>
        <td class="muted">${a.applied ? esc(pretty(a.applied)) : '—'}</td>
        <td class="muted">${a.deadline ? `${esc(pretty(a.deadline))}${a.deadlineNote ? ` · ${esc(a.deadlineNote)}` : ''}` : '—'}</td>
        <td>${esc(referrerFor(a.id)) || '—'}</td>
        <td>${a.next ? esc(a.next) : '—'}</td>
        <td><button class="btn small" data-act="editApp" data-id="${esc(a.id)}">Edit</button></td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="card dashed">No applications yet.</div>'}`;
}

function companyCard(c) {
  const n = contactsAt(c.id).length;
  const m = openMatches().filter((p) => p.companyId === c.id).length;
  const info = checkInfo(c.id);
  const check = !c.source ? 'not connected' : info?.ok === false ? 'checker needs a fix' : info ? 'checker OK' : 'not checked yet';
  return `<button class="card company-card" data-act="openCompany" data-id="${esc(c.id)}" aria-label="Open ${esc(c.name)}">
    <span class="row between" style="width:100%"><span class="name">${esc(c.name)}</span>${companyPill(c)}</span>
    <span class="small muted">${unknown(c.location, 'Location not noted')}</span>
    <span class="small">${c.why ? esc(c.why) : '<span class="unknown">Why you’re interested: not written yet</span>'}</span>
    <span class="small muted divider" style="width:100%">${plural(n, 'contact')} · ${plural(m, 'new match', 'es')} · ${check}</span>
  </button>`;
}

function companiesView() {
  const active = activeCompanies().sort((a, b) => a.name.localeCompare(b.name));
  const removed = removedCompanies();
  const sugg = T().suggestions.filter((s) => !s.status);
  return `
    <div class="row between">
      <p class="muted small">Every company you’re considering, and why. Open one for its full profile.</p>
      <button class="btn" data-act="addCompany">+ Add company</button>
    </div>
    <div class="grid-cards">${active.map(companyCard).join('')}</div>
    ${removed.length ? `<p class="small muted">${plural(removed.length, 'company', 'ies')} taken off the table. <a href="#/passed">See why</a></p>` : ''}
    <div class="stack" style="margin-top:12px">
      <h2 style="font-size:18px">Suggested for you</h2>
      ${sugg.length ? `<div class="grid-cards">${sugg.map((s) => `
        <article class="card">
          <div class="row between"><h3 style="font-size:16px">${esc(s.name)}</h3><span class="small muted">suggested ${esc(pretty(s.date))}</span></div>
          ${s.location ? `<span class="small muted">${esc(s.location)}</span>` : ''}
          <p class="small">${esc(s.why)}</p>
          ${s.openRoles?.length ? `<div class="small"><span class="label">Open MBA roles</span><ul style="margin:4px 0 0;padding-left:18px">${s.openRoles.map((r) => `<li>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</li>`).join('')}</ul></div>` : ''}
          <div class="row divider"><button class="btn small" data-act="acceptSuggestion" data-id="${esc(s.id)}">Add to my list</button><button class="btn small" data-act="passSuggestion" data-id="${esc(s.id)}">Not for me</button></div>
        </article>`).join('')}</div>` : '<div class="card dashed">Ask Claude to “suggest some companies” and they’ll show up here, each with why it fits you.</div>'}
    </div>`;
}

function companyView(id) {
  const c = companyById(id);
  if (!c) return '<div class="card dashed">That company isn’t in your list. <a href="#/companies">Back to companies</a></div>';
  const contacts = contactsAt(c.id);
  const apps = appsAt(c.id);
  const matches = openMatches().filter((p) => p.companyId === c.id);
  const section = (label, value, empty, note) => `<div class="stack" style="gap:4px"><span class="label">${label}</span><p>${value ? esc(value) : `<span class="unknown">${empty}</span>`}</p>${note || ''}</div>`;
  return `
    <a class="btn link" href="#/companies" style="align-self:flex-start">← All companies</a>
    <div class="row between" style="align-items:flex-start">
      <div class="stack" style="gap:4px">
        <h2 class="display" style="font-size:26px">${esc(c.name)}</h2>
        <span class="small muted">${unknown(c.location, 'Location not noted')}${c.careersUrl ? ` · <a href="${esc(c.careersUrl)}" target="_blank" rel="noopener">Careers page</a>` : ''}</span>
      </div>
      <div class="row">${companyPill(c)}
        <button class="btn" data-act="editCompany" data-id="${esc(c.id)}">Edit</button>
        ${c.removed ? '' : `<button class="btn" data-act="removeCompany" data-id="${esc(c.id)}">Take off the table</button>`}
      </div>
    </div>
    ${c.removed ? `<div class="banner red"><div class="stack" style="gap:4px;flex:999 1 400px"><b>You took ${esc(c.name)} off the table${c.removed.date ? ` on ${esc(pretty(c.removed.date))}` : ''}</b><span>Why: ${esc(c.removed.reason || 'No reason noted')}</span><span class="small">The checker isn’t watching it right now.</span></div><button class="btn" data-act="restoreCompany" data-id="${esc(c.id)}">Put back on my list</button></div>` : ''}
    <div class="grid-2">
      <div class="stack">
        <div class="card">
          ${section('Why I’m interested', c.why, 'Not written yet')}
          ${section('Why it’s relevant', c.relevance, 'Not written yet')}
          ${section('East Coast / remote full-time path', c.fullTimePath, 'Unknown. Worth asking your contacts.', c.fullTimePathByClaude ? '<span class="claude-note">Claude’s note from general knowledge. Verify.</span>' : '')}
          ${section('My connection', c.connection, 'None noted yet')}
          ${c.notes ? section('Notes', c.notes) : ''}
        </div>
        <div class="card">
          <span class="label">Past internships here</span>
          ${(c.pastInternships || []).length ? c.pastInternships.map((p) => `<div class="row small"><b style="min-width:100px">${esc(p.when)}</b><span>${esc(p.role)}</span></div>`).join('') : '<span class="unknown small">None recorded yet. Sloan CDO or LinkedIn can tell you.</span>'}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="row between"><span class="label">Contacts</span><button class="btn small" data-act="addContact" data-company="${esc(c.id)}">+ Add</button></div>
          ${contacts.length ? contacts.map((p) => {
            const lastChat = (p.chats || []).filter((x) => x.date).map((x) => x.date).sort().pop();
            const chatLabel = (p.chats || []).length ? `Coffee chat done${lastChat ? ` · ${pretty(lastChat)}` : ''}` : 'No coffee chat yet';
            return `<div class="card" style="padding:12px;gap:6px">
              <span><b>${esc(p.name)}</b>${p.role ? ` <span class="small muted">· ${esc(p.role)}</span>` : ''}</span>
              <span><span class="pill ${(p.chats || []).length ? 'green' : ''}">${esc(chatLabel)}</span></span>
              <span class="row small">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '<span class="unknown">No email</span>'}${p.linkedin ? `<a href="${esc(p.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</span>
              <span class="row"><button class="btn small" data-act="logChat" data-id="${esc(p.id)}">Log coffee chat</button><button class="btn small" data-act="editContact" data-id="${esc(p.id)}">Edit</button></span>
            </div>`;
          }).join('') : '<span class="unknown small">No contacts here yet.</span>'}
        </div>
        <div class="card">
          <div class="row between"><span class="label">Applications and open matches</span><button class="btn small" data-act="addApp" data-company="${esc(c.id)}">+ Add</button></div>
          ${apps.map((a) => `<div class="row between small"><span>${esc(a.role)}</span>${statusSelect(a)}</div>`).join('')}
          ${matches.map((p) => `<div class="row between small"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><span class="pill dark">New match</span></div>`).join('')}
          ${!apps.length && !matches.length ? '<span class="unknown small">Nothing yet. You’ll get an alert when a matching internship is posted.</span>' : ''}
          <span class="small muted divider">${esc(checkerLine(c))}</span>
        </div>
      </div>
    </div>`;
}

function contactsView() {
  const contacts = [...T().contacts].sort((a, b) => companyName(a.companyId, a.companyText || '').localeCompare(companyName(b.companyId, b.companyText || '')));
  return `
    <div class="row between">
      <p class="muted small">Everyone you’ve met, your coffee chats, and when to follow up.</p>
      <button class="btn" data-act="addContact">+ Add contact</button>
    </div>
    <div class="grid-cards">${contacts.map((c) => {
      const ref = c.referredApplicationId && T().applications.find((a) => a.id === c.referredApplicationId);
      const fu = c.followUp && !c.followUp.done && (c.followUp.date || c.followUp.note) ? c.followUp : null;
      return `<article class="card">
        <div class="stack" style="gap:2px">
          <h3 style="font-size:16px">${esc(c.name)}</h3>
          <span class="small muted">${[c.role, c.companyId ? `<a href="#/companies/${esc(c.companyId)}">${esc(companyName(c.companyId))}</a>` : esc(c.companyText || '')].filter(Boolean).join(' at ')}</span>
          <span class="small muted">Met: ${unknown(c.met)}</span>
          <span class="row small">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.linkedin ? `<a href="${esc(c.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</span>
        </div>
        ${ref ? `<span><span class="pill green">Referral · ${esc(ref.role)}</span></span>` : ''}
        <div class="stack" style="gap:6px">
          <span class="label">Coffee chats</span>
          ${(c.chats || []).length ? c.chats.map((ch) => `<div class="row small" style="align-items:flex-start;flex-wrap:nowrap"><b style="min-width:52px">${ch.date ? esc(pretty(ch.date)) : '—'}</b><span>${esc(ch.note || '')}</span></div>`).join('') : '<span class="unknown small">None yet</span>'}
        </div>
        ${c.notes ? `<p class="small muted">${esc(c.notes)}</p>` : ''}
        <div class="row between divider">
          <span class="stack" style="gap:4px">${fu ? `${dueBadge(fu.date)}<span class="small">${esc(fu.note || 'Follow up')}</span>` : '<span class="small muted">No follow-up planned</span>'}</span>
          <span class="row">
            ${fu ? `<button class="btn small" data-act="followDone" data-id="${esc(c.id)}">Follow-up done</button>` : ''}
            <button class="btn small" data-act="logChat" data-id="${esc(c.id)}">Log chat</button>
            <button class="btn small" data-act="editContact" data-id="${esc(c.id)}">Edit</button>
          </span>
        </div>
      </article>`;
    }).join('')}</div>`;
}

function deadlinesView() {
  const items = dueItems();
  const dated = items.filter((i) => i.date).sort((a, b) => a.date.localeCompare(b.date));
  const undated = items.filter((i) => !i.date);
  const row = (i) => {
    const d = i.date ? new Date(`${i.date}T12:00:00`) : null;
    const doneBtn = i.kind === 'follow' ? `<button class="btn small" data-act="followDone" data-id="${esc(i.id)}">Done</button>`
      : i.kind === 'event' ? `<button class="btn small" data-act="eventDone" data-id="${esc(i.id)}">Done</button>`
      : `<button class="btn small" data-act="editApp" data-id="${esc(i.id)}">Edit</button>`;
    return `<div class="list-row">
      <div class="date-box">${d ? `<span>${d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</span><b>${d.getDate()}</b>` : '<span>NO</span><b>—</b>'}</div>
      <div class="grow"><b>${esc(i.title)}</b><span class="small muted">${esc(i.sub)}</span></div>
      ${dueBadge(i.date)} ${doneBtn}
    </div>`;
  };
  return `
    <div class="row between">
      <p class="muted small">Anything due within ${T().settings.reminderDays ?? 3} days, or overdue, is also in that day’s GitHub alert.</p>
      <button class="btn" data-act="addEvent">+ Add reminder</button>
    </div>
    ${dated.length ? `<div class="card" style="padding:0;gap:0">${dated.map(row).join('')}</div>` : '<div class="card dashed">Nothing with a date yet.</div>'}
    ${undated.length ? `<h2 style="font-size:16px;margin-top:8px">To-dos without a date</h2><div class="card" style="padding:0;gap:0">${undated.map(row).join('')}</div>` : ''}`;
}

function passedView() {
  const removed = removedCompanies();
  const passed = Object.entries(T().postingDecisions).filter(([, d]) => d.status === 'passed').map(([key, d]) => ({ key, ...d, p: state.postings?.postings?.[key] || d.posting || {} }));
  return `
    <div class="stack" style="gap:4px">
      <h2 style="font-size:18px">Companies I took off the table</h2>
      <p class="muted small">Why each one looked good at first, and what changed your mind.</p>
    </div>
    ${removed.length ? `<div class="grid-cards">${removed.map((c) => `
      <article class="card">
        <div class="row between"><h3 style="font-size:16px">${esc(c.name)}</h3><span class="small muted">${c.removed.date ? `since ${esc(pretty(c.removed.date))}` : ''}</span></div>
        <div class="stack" style="gap:4px"><span class="label">Why I considered it</span><p class="small">${unknown(c.why, 'Not written')}</p></div>
        <div class="stack" style="gap:4px"><span class="label" style="color:var(--red-fg)">Why I took it off</span><p class="small">${unknown(c.removed.reason, 'No reason noted')}</p></div>
        <div class="row divider"><a class="btn small" href="#/companies/${esc(c.id)}">View profile</a><button class="btn small" data-act="restoreCompany" data-id="${esc(c.id)}">Put back on my list</button></div>
      </article>`).join('')}</div>` : '<div class="card dashed">No companies taken off the table.</div>'}
    <div class="stack" style="gap:4px;margin-top:12px">
      <h2 style="font-size:18px">Jobs I passed on</h2>
      <p class="muted small">Single postings you skipped. You won’t be alerted about them again.</p>
    </div>
    ${passed.length ? `<div class="table-box"><table style="min-width:700px">
      <thead><tr><th>Company</th><th>Role</th><th>Passed</th><th>Why</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>${passed.map((x) => `<tr><td><b>${esc(x.p.company || '')}</b></td><td>${x.p.url ? `<a href="${esc(x.p.url)}" target="_blank" rel="noopener">${esc(x.p.title)}</a>` : esc(x.p.title || x.key)}</td><td class="muted">${esc(pretty(x.date))}</td><td>${esc(x.reason || '')}</td><td><button class="btn small" data-act="reconsider" data-key="${esc(x.key)}">Reconsider</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="card dashed">No jobs passed on yet.</div>'}`;
}

function statsView() {
  const apps = T().applications;
  const counts = Object.fromEntries(APP_STATUSES.map(([v]) => [v, apps.filter((a) => a.status === v).length]));
  const max = Math.max(1, ...Object.values(counts));
  const submitted = apps.filter((a) => SUBMITTED.includes(a.status)).length;
  const heard = apps.filter((a) => HEARD_BACK.includes(a.status)).length;
  const referred = new Set(T().contacts.map((c) => c.referredApplicationId).filter(Boolean)).size;
  const chats = T().contacts.reduce((n, c) => n + (c.chats || []).length, 0);
  const colorVar = { '': 'var(--muted)', blue: 'var(--blue-fg)', purple: 'var(--purple-fg)', orange: 'var(--orange-fg)', green: 'var(--green-fg)', red: 'var(--red-fg)' };
  return `<div class="grid-2">
    <div class="card"><h2 style="font-size:16px">Applications by stage</h2>
      ${APP_STATUSES.map(([v, label, color]) => `<div class="row" style="flex-wrap:nowrap"><span class="small" style="width:140px">${label}</span><div class="bar"><div style="width:${Math.round((counts[v] / max) * 100)}%;background:${colorVar[color]}"></div></div><b style="width:24px;text-align:right">${counts[v]}</b></div>`).join('')}
    </div>
    <div class="card"><h2 style="font-size:16px">Response rate</h2>
      <b class="display" style="font-size:42px">${submitted ? `${Math.round((heard / submitted) * 100)}%` : '—'}</b>
      <p class="small muted">${heard} of ${submitted} submitted applications got a reply (assessment, interview, offer or rejection).</p>
      <p class="small muted">${plural(referred, 'application')} with a referral · ${plural(T().contacts.length, 'contact')} · ${plural(chats, 'coffee chat')} logged.</p>
      <p class="small muted">${plural(activeCompanies().length, 'company', 'ies')} on your list, ${removedCompanies().length} off the table, ${Object.values(T().postingDecisions).filter((d) => d.status === 'passed').length} jobs passed on.</p>
    </div>
  </div>`;
}

function settingsView() {
  const s = T().settings;
  const health = T().companies.filter((c) => !c.removed).map((c) => ({ c, info: checkInfo(c.id) }));
  return `
    <div class="card">
      <h2 style="font-size:16px">Job filter</h2>
      <p class="small muted">A posting matches when its <b>title</b> has an internship word, it mentions an <b>MBA</b> word, and a <b>role family</b> shows up (a role word in the title, or a role phrase anywhere). One term per line. Changes apply from the next check.</p>
      <div class="grid-2">
        ${[['internTitleTerms', 'Internship words (title)'], ['mbaTerms', 'MBA words (anywhere)'], ['roleTitleTerms', 'Role words (title)'], ['roleTextTerms', 'Role phrases (anywhere)'], ['excludeTitleTerms', 'Skip if the title has']].map(([k, label]) => `
          <div class="field"><label for="set-${k}">${label}</label><textarea id="set-${k}" data-setting="${k}" rows="6">${esc((s[k] || []).join('\n'))}</textarea></div>`).join('')}
        <div class="field"><label for="set-reminderDays">Remind me this many days ahead</label><input id="set-reminderDays" type="text" inputmode="numeric" data-setting="reminderDays" value="${esc(s.reminderDays ?? 3)}"></div>
      </div>
      <div class="row"><button class="btn dark" data-act="saveSettings">Save filter</button></div>
    </div>
    <div class="card">
      <h2 style="font-size:16px">Careers-site health</h2>
      <div class="table-box" style="border:none"><table style="min-width:640px">
        <thead><tr><th>Company</th><th>Site</th><th>Last checked</th><th>Jobs scanned</th><th>Matches</th><th>Status</th></tr></thead>
        <tbody>${health.map(({ c, info }) => `<tr>
          <td><a href="#/companies/${esc(c.id)}">${esc(c.name)}</a></td>
          <td class="muted">${esc(c.source?.type || 'not connected')}</td>
          <td class="muted">${info ? esc(relTime(info.checkedAt)) : '—'}</td>
          <td>${info?.scanned ?? '—'}</td><td>${info?.matches ?? '—'}</td>
          <td>${!c.source ? '<span class="pill">Not connected</span>' : !info ? '<span class="pill">Waiting</span>' : info.ok ? '<span class="pill green">OK</span>' : `<span class="pill red" title="${esc(info.error)}">Needs a fix</span>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2 style="font-size:16px">This device</h2>
      <p class="small muted">Connected to <b>${esc(state.cfg.repo)}</b> (${esc(state.cfg.branch)}). Your access token is stored only in this browser.</p>
      <div class="row"><button class="btn" data-act="signOut">Disconnect this browser</button></div>
    </div>`;
}

function setupView() {
  return `
    <header class="top"><h1 class="display">Recruiting HQ</h1></header>
    <form class="card" id="setup" style="max-width:640px">
      <h2 style="font-size:18px">Connect to your data</h2>
      <p class="small muted">Your applications, contacts and notes live in your private GitHub repo. This page reads and saves them with a personal access token that stays in this browser only.</p>
      <ol class="small" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px">
        <li>On GitHub, open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Settings › Developer settings › Fine-grained tokens › Generate new token</a>.</li>
        <li>Repository access: <b>Only select repositories</b> → your data repo.</li>
        <li>Permissions: <b>Contents: Read and write</b> and <b>Actions: Read and write</b> (for “Run check now”).</li>
        <li>Pick an expiration you’re comfortable with, generate it, and paste it below.</li>
      </ol>
      <div class="field"><label for="setup-repo">Data repo (owner/name)</label><input id="setup-repo" type="text" required placeholder="your-username/recruiting-data" value="${esc(new URLSearchParams(location.search).get('repo') || '')}"></div>
      <div class="field"><label for="setup-token">Access token</label><input id="setup-token" type="password" required autocomplete="off" placeholder="github_pat_…"></div>
      <p class="small" id="setup-msg" role="status"></p>
      <div class="row"><button class="btn dark" type="submit">Connect</button></div>
    </form>`;
}

function errorView() {
  return `
    <header class="top"><h1 class="display">Recruiting HQ</h1></header>
    <div class="card"><b>Couldn’t load your data.</b><p class="small">${esc(state.loadError.message)}</p>
      <p class="small muted">If the token expired, or doesn’t include this repo, disconnect and set it up again.</p>
      <div class="row"><button class="btn dark" data-act="reload">Try again</button><button class="btn" data-act="signOut">Disconnect</button></div></div>`;
}

// ---------------------------------------------------------------- forms

function fieldHtml(f) {
  const id = `f-${f.name}`;
  const v = f.value ?? '';
  const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
  const quick = f.quick ? `<div class="row" style="gap:6px">${f.quick.map((q) => `<button type="button" class="btn small" data-fill="${esc(q)}" data-target="${f.name}">${esc(q)}</button>`).join('')}</div>` : '';
  if (f.type === 'checkbox') return `<div class="field check"><input id="${id}" name="${f.name}" type="checkbox" ${v ? 'checked' : ''}><label for="${id}">${esc(f.label)}</label></div>`;
  if (f.type === 'textarea') return `<div class="field"><label for="${id}">${esc(f.label)}</label>${hint}${quick}<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea></div>`;
  if (f.type === 'select') return `<div class="field"><label for="${id}">${esc(f.label)}</label>${hint}<select id="${id}" name="${f.name}">${f.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select></div>`;
  return `<div class="field"><label for="${id}">${esc(f.label)}</label>${hint}${quick}<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}"></div>`;
}

function openForm({ title, intro, fields, submitLabel = 'Save', onSubmit }) {
  const dlg = document.getElementById('modal');
  dlg.innerHTML = `<form method="dialog">
    <h2 style="font-size:18px">${esc(title)}</h2>
    ${intro ? `<p class="small muted">${esc(intro)}</p>` : ''}
    ${fields.map(fieldHtml).join('')}
    <div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn dark" value="ok">${esc(submitLabel)}</button></div>
  </form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('click', (e) => {
    const q = e.target.closest('[data-fill]');
    if (q) { e.preventDefault(); form.elements[q.dataset.target].value = q.dataset.fill; form.elements[q.dataset.target].focus(); }
  });
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const vals = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      vals[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
    }
    dlg.close();
    onSubmit(vals);
  });
  dlg.showModal();
}

const companyOptions = (withNone = true) => [...(withNone ? [['', 'None / other']] : []), ...[...T().companies].sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.id, c.name])];
const orNull = (v) => (v === '' ? null : v);

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) list.unshift(item); else list[i] = { ...list[i], ...item };
}

function applicationForm(app, presetCompany) {
  const a = app || { id: uid('app'), companyId: presetCompany || '', status: 'Saved' };
  openForm({
    title: app ? 'Edit application' : 'Add application',
    fields: [
      { name: 'companyId', label: 'Company', type: 'select', options: companyOptions(false), value: a.companyId },
      { name: 'role', label: 'Role', required: true, value: a.role },
      { name: 'status', label: 'Status', type: 'select', options: APP_STATUSES.map(([v, l]) => [v, l]), value: a.status },
      { name: 'applied', label: 'Date applied', type: 'date', value: a.applied },
      { name: 'deadline', label: 'Deadline', type: 'date', value: a.deadline },
      { name: 'deadlineNote', label: 'What’s due', value: a.deadlineNote, placeholder: 'e.g. Application closes, OA due' },
      { name: 'next', label: 'Next step', value: a.next },
      { name: 'link', label: 'Posting link', type: 'url', value: a.link },
      { name: 'notes', label: 'Notes', type: 'textarea', value: a.notes },
    ],
    onSubmit: (v) => update((t) => upsert(t.applications, { ...a, ...v, applied: orNull(v.applied), deadline: orNull(v.deadline), deadlineNote: orNull(v.deadlineNote), next: orNull(v.next), link: orNull(v.link), notes: orNull(v.notes) }), `${app ? 'Edit' : 'Add'} application: ${v.role}`),
  });
}

function companyForm(company) {
  const c = company || { id: null, statusKind: 'exploring', pastInternships: [], source: null, removed: null };
  openForm({
    title: company ? `Edit ${company.name}` : 'Add company',
    intro: company ? null : 'After you add it, ask Claude to connect its careers site so the daily check covers it.',
    fields: [
      { name: 'name', label: 'Company', required: true, value: c.name },
      { name: 'location', label: 'Location / relevant office', value: c.location },
      { name: 'careersUrl', label: 'Careers page link', type: 'url', value: c.careersUrl },
      { name: 'statusKind', label: 'Stage', type: 'select', options: Object.entries(KINDS).map(([k, [l]]) => [k, l]), value: c.statusKind },
      { name: 'status', label: 'Status detail (optional)', value: c.status, placeholder: 'e.g. Waiting for internships to be posted' },
      { name: 'why', label: 'Why I’m interested', type: 'textarea', value: c.why },
      { name: 'relevance', label: 'Why it’s relevant', type: 'textarea', value: c.relevance, placeholder: 'e.g. Has a strategy team in NYC' },
      { name: 'fullTimePath', label: 'East Coast / remote full-time path', type: 'textarea', value: c.fullTimePath },
      { name: 'connection', label: 'My connection to the business', type: 'textarea', value: c.connection },
      { name: 'pastInternships', label: 'Past internships', type: 'textarea', hint: 'One per line: when | role and location', value: (c.pastInternships || []).map((p) => `${p.when} | ${p.role}`).join('\n'), placeholder: 'Summer 2026 | Strategy MBA Intern, New York' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: c.notes },
    ],
    onSubmit: (v) => {
      const id = c.id || (companyById(slugify(v.name)) ? uid(slugify(v.name)) : slugify(v.name));
      const past = v.pastInternships.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [when, ...rest] = l.split('|'); return { when: when.trim(), role: rest.join('|').trim() }; });
      const fields = { name: v.name, location: orNull(v.location), careersUrl: orNull(v.careersUrl), statusKind: v.statusKind, status: orNull(v.status), why: orNull(v.why), relevance: orNull(v.relevance), fullTimePath: orNull(v.fullTimePath), connection: orNull(v.connection), pastInternships: past, notes: orNull(v.notes) };
      if (company && v.fullTimePath !== (company.fullTimePath || '')) fields.fullTimePathByClaude = false;
      update((t) => { const existing = t.companies.find((x) => x.id === id); if (existing) Object.assign(existing, fields); else t.companies.push({ ...c, id, ...fields }); }, `${company ? 'Edit' : 'Add'} company: ${v.name}`);
      if (!company) location.hash = `#/companies/${id}`;
    },
  });
}

function contactForm(contact, presetCompany) {
  const c = contact || { id: uid('contact'), companyId: presetCompany || '', chats: [], followUp: null };
  openForm({
    title: contact ? `Edit ${contact.name}` : 'Add contact',
    fields: [
      { name: 'name', label: 'Name', required: true, value: c.name },
      { name: 'companyId', label: 'Company', type: 'select', options: companyOptions(), value: c.companyId || '' },
      { name: 'companyText', label: 'Company (if not in your list)', value: c.companyText },
      { name: 'role', label: 'Their role', value: c.role },
      { name: 'email', label: 'Email', type: 'email', value: c.email },
      { name: 'linkedin', label: 'LinkedIn URL', type: 'url', value: c.linkedin },
      { name: 'met', label: 'How you met', value: c.met },
      { name: 'referredApplicationId', label: 'Referred me for', type: 'select', options: [['', 'No referral'], ...T().applications.map((a) => [a.id, `${companyName(a.companyId)}: ${a.role}`])], value: c.referredApplicationId || '' },
      { name: 'followDate', label: 'Follow up by', type: 'date', value: c.followUp?.date },
      { name: 'followNote', label: 'Follow-up note', value: c.followUp?.note, placeholder: 'e.g. Send thank-you, ask about referral' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: c.notes },
    ],
    onSubmit: (v) => update((t) => upsert(t.contacts, {
      ...c, name: v.name, companyId: orNull(v.companyId), companyText: orNull(v.companyText), role: orNull(v.role), email: orNull(v.email), linkedin: orNull(v.linkedin), met: orNull(v.met), referredApplicationId: orNull(v.referredApplicationId), notes: orNull(v.notes),
      followUp: v.followDate || v.followNote ? { date: orNull(v.followDate), note: orNull(v.followNote), done: false } : null,
    }), `${contact ? 'Edit' : 'Add'} contact: ${v.name}`),
  });
}

// ---------------------------------------------------------------- actions

const actions = {
  reload: () => { state.tracker = null; render(); loadAll(); },
  async runCheck() {
    if (state.cfg.local) { toast('Preview mode: run “npm run check” in the project folder instead.'); return; }
    try {
      await gh(`/repos/${state.cfg.repo}/actions/workflows/check.yml/dispatches`, { method: 'POST', body: { ref: state.cfg.branch } });
      toast('Check started. Press Refresh in about 3 minutes to see results.');
    } catch (err) {
      toast(err.status === 403 || err.status === 404 ? 'Couldn’t start the check. Your token needs “Actions: Read and write”.' : `Couldn’t start the check: ${err.message}`);
    }
  },
  openCompany: ({ id }) => { location.hash = `#/companies/${id}`; },
  passPosting({ key }) {
    const p = state.postings.postings[key];
    openForm({
      title: 'Pass on this job', intro: `${p.company}: ${p.title}`, submitLabel: 'Move to Passed on',
      fields: [{ name: 'reason', label: 'Why are you passing?', type: 'textarea', quick: PASS_REASONS, placeholder: 'e.g. Marketing role, not my focus' }],
      onSubmit: (v) => update((t) => { t.postingDecisions[key] = { status: 'passed', date: todayISO(), reason: v.reason || 'No reason noted', posting: { company: p.company, title: p.title, url: p.url } }; }, `Pass on ${p.company}: ${p.title}`),
    });
  },
  savePosting({ key }) {
    const p = state.postings.postings[key];
    const id = `app-${key.replace(/[^a-z0-9]+/gi, '-')}`;
    update((t) => {
      t.postingDecisions[key] = { status: 'saved', date: todayISO() };
      if (!t.applications.some((a) => a.id === id)) t.applications.unshift({ id, companyId: p.companyId, role: p.title, status: 'Saved', applied: null, deadline: null, deadlineNote: null, next: 'Apply', link: p.url, notes: null });
    }, `Save ${p.company}: ${p.title}`);
    toast('Saved to Applications.');
  },
  applyPosting({ key }) {
    const p = state.postings.postings[key];
    const id = `app-${key.replace(/[^a-z0-9]+/gi, '-')}`;
    update((t) => {
      t.postingDecisions[key] = { status: 'applied', date: todayISO() };
      if (!t.applications.some((a) => a.id === id)) t.applications.unshift({ id, companyId: p.companyId, role: p.title, status: 'Applied', applied: todayISO(), deadline: null, deadlineNote: null, next: 'Wait for a response', link: p.url, notes: null });
    }, `Applied: ${p.company}: ${p.title}`);
    toast('Added to Applications as Applied.');
  },
  reconsider: ({ key }) => update((t) => { delete t.postingDecisions[key]; }, 'Reconsider a passed job'),
  appStatus({ id }, el) {
    const status = el.value;
    update((t) => { const a = t.applications.find((x) => x.id === id); if (a) { a.status = status; if (SUBMITTED.includes(status) && !a.applied) a.applied = todayISO(); } }, `Status → ${status}`);
  },
  addApp: ({ company }) => applicationForm(null, company),
  editApp: ({ id }) => applicationForm(T().applications.find((a) => a.id === id)),
  addCompany: () => companyForm(null),
  editCompany: ({ id }) => companyForm(companyById(id)),
  removeCompany({ id }) {
    const c = companyById(id);
    openForm({
      title: `Take ${c.name} off the table`, intro: 'Your notes on why you considered it stay with the company, so you can look back later.', submitLabel: 'Take off the table',
      fields: [{ name: 'reason', label: `Why are you taking ${c.name} off the table?`, type: 'textarea', quick: REMOVE_REASONS, placeholder: 'e.g. Their only East Coast office is sales; engineering roles are all in California' }],
      onSubmit: (v) => update((t) => { const x = t.companies.find((y) => y.id === id); if (x) x.removed = { date: todayISO(), reason: v.reason || 'No reason noted' }; }, `Off the table: ${c.name}`),
    });
  },
  restoreCompany: ({ id }) => update((t) => { const x = t.companies.find((y) => y.id === id); if (x) x.removed = null; }, `Back on the list: ${companyName(id)}`),
  addContact: ({ company }) => contactForm(null, company),
  editContact: ({ id }) => contactForm(T().contacts.find((c) => c.id === id)),
  logChat({ id }) {
    const c = T().contacts.find((x) => x.id === id);
    openForm({
      title: `Log a coffee chat with ${c.name}`,
      fields: [
        { name: 'date', label: 'Date', type: 'date', value: todayISO() },
        { name: 'note', label: 'What you talked about', type: 'textarea' },
        { name: 'followDate', label: 'Follow up by (optional)', type: 'date' },
        { name: 'followNote', label: 'Follow-up note', placeholder: 'e.g. Send thank-you note', value: 'Send thank-you note' },
      ],
      onSubmit: (v) => update((t) => {
        const x = t.contacts.find((y) => y.id === id);
        if (!x) return;
        x.chats ||= [];
        if (!x.chats.some((ch) => ch.date === orNull(v.date) && ch.note === v.note)) x.chats.push({ date: orNull(v.date), note: v.note });
        if (v.followDate) x.followUp = { date: v.followDate, note: orNull(v.followNote), done: false };
      }, `Coffee chat with ${c.name}`),
    });
  },
  followDone: ({ id }) => update((t) => { const x = t.contacts.find((y) => y.id === id); if (x?.followUp) x.followUp.done = true; }, 'Follow-up done'),
  addEvent() {
    openForm({
      title: 'Add a reminder',
      fields: [
        { name: 'title', label: 'What', required: true, placeholder: 'e.g. Jane Street application closes' },
        { name: 'date', label: 'Date', type: 'date' },
        { name: 'companyId', label: 'Company', type: 'select', options: companyOptions() },
      ],
      onSubmit: (v) => { const id = uid('event'); update((t) => upsert(t.events, { id, title: v.title, date: orNull(v.date), companyId: orNull(v.companyId), done: false }), `Reminder: ${v.title}`); },
    });
  },
  eventDone: ({ id }) => update((t) => { const e = t.events.find((x) => x.id === id); if (e) e.done = true; }, 'Reminder done'),
  acceptSuggestion({ id }) {
    const s = T().suggestions.find((x) => x.id === id);
    const cid = companyById(slugify(s.name)) ? uid(slugify(s.name)) : slugify(s.name);
    update((t) => {
      const x = t.suggestions.find((y) => y.id === id);
      if (!x || x.status) return;
      x.status = 'added';
      t.companies.push({ id: cid, name: s.name, location: s.location || null, status: null, statusKind: 'exploring', why: s.why, relevance: s.relevance || null, fullTimePath: s.fullTimePath || null, fullTimePathByClaude: !!s.fullTimePath, connection: null, pastInternships: [], careersUrl: s.careersUrl || null, source: s.source || null, removed: null, notes: 'Suggested by Claude.' });
    }, `Add suggested company: ${s.name}`);
    location.hash = `#/companies/${cid}`;
  },
  passSuggestion({ id }) {
    const s = T().suggestions.find((x) => x.id === id);
    openForm({
      title: `Not for me: ${s.name}`, submitLabel: 'Dismiss',
      fields: [{ name: 'reason', label: 'Why not? (helps Claude suggest better)', type: 'textarea', quick: REMOVE_REASONS }],
      onSubmit: (v) => update((t) => { const x = t.suggestions.find((y) => y.id === id); if (x) { x.status = 'passed'; x.reason = v.reason || null; } }, `Dismiss suggestion: ${s.name}`),
    });
  },
  saveSettings() {
    const vals = {};
    document.querySelectorAll('[data-setting]').forEach((el) => {
      vals[el.dataset.setting] = el.dataset.setting === 'reminderDays' ? Math.max(0, parseInt(el.value, 10) || 3) : el.value.split('\n').map((x) => x.trim()).filter(Boolean);
    });
    update((t) => Object.assign(t.settings, vals), 'Update job filter');
    toast('Filter saved. It applies from the next check.');
  },
  signOut() {
    try { localStorage.removeItem(CFG_KEY); } catch { /* ignore */ }
    Object.assign(state, { cfg: null, tracker: null, postings: null, sha: null, loadError: null });
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  actions[el.dataset.act](el.dataset, el);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && actions[el.dataset.change]) actions[el.dataset.change](el.dataset, el);
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'setup') return;
  e.preventDefault();
  const repo = document.getElementById('setup-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  const token = document.getElementById('setup-token').value.trim();
  const msg = document.getElementById('setup-msg');
  msg.textContent = 'Checking…';
  state.cfg = { repo, token, branch: 'main' };
  try {
    const info = await gh(`/repos/${repo}`);
    saveCfg({ repo, token, branch: info.default_branch || 'main' });
    loadAll();
  } catch (err) {
    state.cfg = null;
    msg.textContent = `That didn’t work: ${err.message}. Check the repo name and that the token can access it.`;
  }
});

render();
if (state.cfg) loadAll();
