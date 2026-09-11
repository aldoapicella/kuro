import type { DesktopBridge } from '../bridge.js';
import type { DesktopInfo, DesktopScenario, EvidenceView, Passage, PassageReference, Result, ReviewView, StateView, SummaryView } from '@kuro/contracts';

declare global { interface Window { kuro: DesktopBridge } }

const { app, host } = window.kuro;
const root = document.querySelector<HTMLDivElement>('#app')!;

function el(tag: string, text = '', className = ''): HTMLElement { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function hidden(tag: string, text: string, className = ''): HTMLElement { const node = el(tag, text, className); node.setAttribute('aria-hidden', 'true'); return node; }
/** The accessible name stays exactly `label` so decorative icons and counts never rename an action. */
function button(label: string, className: string, action: () => Promise<void>, ...content: (HTMLElement | string)[]): HTMLButtonElement {
 const b = document.createElement('button');
 b.className = className;
 b.setAttribute('aria-label', label);
 if (content.length) b.append(...content); else b.textContent = label;
 b.onclick = () => { b.disabled = true; void action().catch(showError).finally(() => { b.disabled = false; }); };
 return b;
}
function unwrap<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const short = (id: string): string => id.slice(0, 8);
const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const notice = el('div', '', 'notice hidden'); notice.setAttribute('role', 'status');
function showError(error: unknown): void {
 notice.className = 'notice error';
 notice.replaceChildren(el('span', error instanceof Error ? error.message : 'Operation unavailable'));
 notice.append(button('Dismiss', 'button quiet', async () => { notice.className = 'notice hidden'; }));
}
function showNotice(text: string, tone: 'info' | 'success' | 'error' = 'info'): void {
 notice.className = `notice ${tone}`;
 notice.replaceChildren(el('span', text));
 notice.append(button('Dismiss', 'button quiet', async () => { notice.className = 'notice hidden'; }));
}

const PAGES = ['Overview', 'Import', 'Ask', 'Reviews', 'Evidence', 'Summaries'] as const;
type Page = (typeof PAGES)[number];
const PAGE_ICON: Record<Page, string> = { Overview: '◈', Import: '↓', Ask: '✦', Reviews: '◎', Evidence: '❝', Summaries: '≡' };
const PAGE_BLURB: Record<Page, string> = {
 Overview: 'Everything this device holds, and every request waiting on a decision.',
 Import: 'Snapshots stay on this device. Sharing always needs an explicit document rule.',
 Ask: 'Send a question to a custodian. They decide what, if anything, comes back.',
 Reviews: 'Read the exact passages before approving. Nothing leaves until you approve it.',
 Evidence: 'Passages a custodian approved for you, with their origin references intact.',
 Summaries: 'Local drafts built from received evidence. They always need your semantic review.',
};
const PROTECTED_PAGES: readonly string[] = ['Reviews', 'Evidence', 'Summaries'];

let page: Page = 'Overview', selectedSpace = '', revision = 0, protectedRevision = 0, askQuery = '';
type ProtectedSession = {
 token: number; page: string; panel: HTMLElement; kind: 'review' | 'evidence' | 'summary';
 load: () => Promise<unknown>; display: (value: unknown, token: number) => void; expiresAtOf: (value: unknown) => number | undefined; fingerprint?: string; expiresAtMs?: number;
};
type ReviewEdits = { selectedSpanIds: string[]; allowLocalSummary: boolean };
let protectedSession: ProtectedSession | undefined;
const reviewEdits = new Map<string, ReviewEdits>();

const layout = el('div', '', 'layout');
const sidebar = el('aside', '', 'sidebar');
const workspace = el('div', '', 'workspace');
const topbar = el('header', '', 'topbar');
const content = el('main', '', 'main');
const nav = el('nav', '', 'nav');
const navButtons = new Map<Page, { button: HTMLButtonElement; count: HTMLElement }>();
const deviceBlock = el('div', '', 'device');

const brand = el('div', '', 'brand');
brand.append(hidden('span', 'K', 'brand-mark'), el('span', 'KURO'));
sidebar.append(brand, el('p', 'Private knowledge, shared carefully', 'brand-subtitle'), el('div', 'Workspace', 'section-label'));
for (const name of PAGES) {
 const count = hidden('span', '', 'count hidden');
 // Navigating away retires the notice: it reports the last action on the page that caused it.
 const b = button(name, 'nav-button', async () => { page = name; notice.className = 'notice hidden'; await render(); }, hidden('span', PAGE_ICON[name], 'nav-icon'), el('span', name), count);
 navButtons.set(name, { button: b, count });
 nav.append(b);
}
const sidebarNote = el('div', '', 'sidebar-note');
sidebarNote.append(el('strong', 'Source custody'), el('p', 'Original documents and indexes never leave this device. Only passages a reviewer approves are sent.'));
sidebar.append(nav, sidebarNote, deviceBlock);
workspace.append(topbar, content);
layout.append(sidebar, workspace);
root.replaceChildren(layout);

function invalidateProtected(): void {
 const session = protectedSession;
 protectedRevision++; protectedSession = undefined;
 if (session) session.panel.replaceChildren(el('p', 'Protected view cleared. Reopen it to authorize the current state.', 'notice error'));
}
window.addEventListener('kuro:lifecycle-invalidated', () => {
 revision++;
 invalidateProtected();
 reviewEdits.clear();
 content.replaceChildren(el('p', 'Protected content paused. Reopen a view after access is restored.', 'notice'));
});
function protectedCurrent(token: number, expectedPage: string): boolean { return token === protectedRevision && page === expectedPage; }
function reviewKey(review: ReviewView): string { return `${review.draftId}:${review.revision}:${review.viewDigest}`; }
function closeProtected(panel: HTMLElement, error: unknown): void {
 panel.replaceChildren(el('p', 'This protected view is no longer available. Reopen it after authorization is restored.', 'notice error'));
 showError(error);
}
async function authorizeProtected(session: ProtectedSession): Promise<void> {
 session.panel.replaceChildren(el('p', 'Authorizing protected view…', 'helper'));
 try {
  const value = await session.load();
  if (protectedSession !== session || !protectedCurrent(session.token, session.page)) return;
  const expiresAt = session.expiresAtOf(value);
  if (expiresAt === undefined) delete session.expiresAtMs; else session.expiresAtMs = expiresAt;
  session.fingerprint = JSON.stringify(value);
  session.display(value, session.token);
 } catch (error) {
  if (protectedSession !== session || !protectedCurrent(session.token, session.page)) return;
  protectedSession = undefined;
  closeProtected(session.panel, error);
 }
}
async function openProtected<T>(kind: ProtectedSession['kind'], panel: HTMLElement, load: () => Promise<T>, display: (value: T, token: number) => void, expiresAtMs?: (value: T) => number): Promise<void> {
 const session: ProtectedSession = { token: ++protectedRevision, page, panel, kind, load, display: (value, token) => display(value as T, token), expiresAtOf: value => expiresAtMs?.(value as T) };
 protectedSession = session;
 await authorizeProtected(session);
}
async function validateProtected(session: ProtectedSession): Promise<void> {
 try {
  const value = await session.load();
  if (protectedSession !== session || !protectedCurrent(session.token, session.page)) return;
  const fingerprint = JSON.stringify(value);
  if (fingerprint === session.fingerprint) return;
  const updated: ProtectedSession = { ...session, token: ++protectedRevision, fingerprint };
  const expiresAt = updated.expiresAtOf(value);
  if (expiresAt === undefined) delete updated.expiresAtMs; else updated.expiresAtMs = expiresAt;
  protectedSession = updated;
  updated.panel.replaceChildren(el('p', 'Protected view changed. Authorizing the current revision…', 'helper'));
  updated.display(value, updated.token);
 } catch (error) {
  if (protectedSession !== session || !protectedCurrent(session.token, session.page)) return;
  protectedRevision++; protectedSession = undefined;
  closeProtected(session.panel, error);
 }
}
async function reauthorizeProtected(): Promise<void> {
 const previous = protectedSession;
 if (!previous) return;
 const session: ProtectedSession = { ...previous, token: ++protectedRevision };
 protectedSession = session;
 await authorizeProtected(session);
}

function badge(text: string, tone = ''): HTMLElement { return el('span', text, `badge ${tone}`.trim()); }
const SYNC_TONE: Record<string, string> = { CURRENT: 'good', SYNCING: '', OFFLINE_VALID: 'warn', STALE: 'warn', EXPIRED: 'bad', DENIED: 'bad', UNPAIRED: '' };
const STATE_TONE: Record<string, string> = { COMPLETE: 'good', APPROVED: 'good', EVIDENCE_READY: 'good', ACKED: 'good', DRAFT: 'purple', REVIEW: 'warn', QUEUED: 'warn', RUNNING: 'warn', RETRIEVING: 'warn', SUMMARY_PENDING: 'warn', PARTIAL: 'warn', FAILED: 'bad', EXPIRED: 'bad', CANCELLED: 'bad' };

function empty(title: string, body: string): HTMLElement {
 const box = el('div', '', 'empty');
 box.append(el('strong', title), el('p', body));
 return box;
}
function panelHeader(title: string, ...trailing: HTMLElement[]): HTMLElement {
 const header = el('div', '', 'panel-header');
 header.append(el('h2', title), ...trailing);
 return header;
}
function metric(label: string, value: number | string, foot: string, icon: string): HTMLElement {
 const box = el('div', '', 'metric');
 box.append(hidden('span', icon, 'metric-icon'), el('div', label, 'metric-label'), el('div', String(value), 'metric-value'), el('div', foot, 'metric-foot'));
 return box;
}
/** Full origin, version and byte span stay available without crowding the passage itself. */
function reference(ref: PassageReference): HTMLElement {
 const box = document.createElement('details');
 box.className = 'reference';
 const head = document.createElement('summary');
 head.textContent = `Origin reference · span ${short(ref.spanId)} · bytes ${ref.startByte}–${ref.endByte}`;
 const list = document.createElement('dl');
 for (const [term, value] of [['Origin', ref.originKey], ['Document', ref.documentId], ['Version', ref.versionId], ['Span', ref.spanId]] as const) {
  const dt = document.createElement('dt'); dt.textContent = term;
  const dd = document.createElement('dd'); dd.append(el('code', value, 'code-full'));
  list.append(dt, dd);
 }
 box.append(head, list);
 return box;
}
function passageBlock(passage: Passage, ...leading: HTMLElement[]): HTMLElement {
 const box = el('div', '', 'source');
 const quote = document.createElement('blockquote');
 quote.className = 'quote';
 quote.textContent = passage.text;
 box.append(...leading, quote, reference(passage.ref));
 return box;
}
function conditionsBlock(conditions: { allowLocalSummary: boolean; forwarding: string; validForSeconds: number; notAfterMs: number | null }): HTMLElement {
 const box = el('div', '', 'review-summary');
 const row = el('div', '', 'row');
 row.append(
  badge(conditions.allowLocalSummary ? 'Local summary permitted' : 'No local summary', conditions.allowLocalSummary ? 'purple' : ''),
  badge(`Forwarding ${conditions.forwarding}`, 'good'),
  badge(`Valid ${Math.round(conditions.validForSeconds / 60)} min`),
 );
 box.append(el('div', 'Processing conditions', 'eyebrow'), row);
 if (conditions.notAfterMs !== null) box.append(el('p', `Not readable after ${when(conditions.notAfterMs)}.`, 'helper mt'));
 return box;
}

function renderSidebar(state: StateView, info: DesktopInfo): void {
 const counts: Record<Page, number> = {
  Overview: state.requests.filter(r => ['REVIEW', 'QUEUED', 'RETRIEVING'].includes(r.state)).length,
  Import: state.documents.filter(d => d.spaceId === selectedSpace).length,
  Ask: 0,
  Reviews: state.requests.filter(r => r.state === 'REVIEW').length,
  Evidence: state.evidenceIds.length,
  Summaries: state.summaries.length,
 };
 for (const [name, entry] of navButtons) {
  entry.button.classList.toggle('active', name === page);
  entry.count.textContent = String(counts[name]);
  entry.count.className = counts[name] > 0 ? 'count' : 'count hidden';
 }
 deviceBlock.replaceChildren(
  hidden('div', `D${info.profile}`, 'avatar'),
  (() => { const box = el('div'); box.append(el('div', `Device ${info.profile}`, 'device-name'), el('div', `Member ${short(info.memberId)}`, 'small')); return box; })(),
 );
}

function renderTopbar(state: StateView, info: DesktopInfo): void {
 const left = el('div', '', 'topbar-left');
 const select = document.createElement('select');
 select.className = 'space-select';
 select.setAttribute('aria-label', 'Shared space');
 for (const space of state.spaces) {
  const option = document.createElement('option');
  option.value = space.spaceId;
  option.textContent = `${space.isOwner ? 'Owner' : 'Participant'} · ${short(space.spaceId)} · ${space.syncState}`;
  select.append(option);
 }
 select.value = selectedSpace;
 select.onchange = () => { selectedSpace = select.value; void render().catch(showError); };
 left.append(select);
 if (!state.spaces.length) left.append(el('span', 'No shared space yet', 'helper'));
 // Kept as one exact string so a profile is identifiable in a two-window session.
 left.append(el('span', `${info.mode} · Device ${info.profile}`));

 const right = el('div', '', 'topbar-right');
 const peers = el('span', `${plural(info.peers.length, 'verified peer')}`, 'helper');
 const sync = el('span', '', 'helper');
 const space = state.spaces.find(s => s.spaceId === selectedSpace);
 // The green dot means current authority only; a stale or expired space must not wear it.
 if (space?.syncState === 'CURRENT') sync.append(hidden('span', '', 'status-dot'));
 sync.append(document.createTextNode(space ? space.syncState.replace(/_/g, ' ').toLowerCase() : 'not paired'));
 const label = info.mode === 'real' ? 'Real QVAC · real transport'
  : info.mode === 'core-simulated' ? `Real core · ${info.aiProvider === 'qvac' ? 'real QVAC' : 'simulated AI'} · simulated network`
  : 'Scripted demo data';
 right.append(peers, sync, el('span', label, `mode${info.aiProvider === 'qvac' ? ' real' : ''}`));
 if (info.mode === 'demo') {
  const scenarios = document.createElement('select');
  scenarios.className = 'scenario';
  scenarios.setAttribute('aria-label', 'Simulation scenario');
  for (const scenario of ['ready', 'waiting', 'offline', 'expired', 'stale-review', 'model-unavailable', 'capacity', 'error']) {
   const option = document.createElement('option'); option.value = scenario; option.textContent = scenario; scenarios.append(option);
  }
  scenarios.value = info.scenario ?? 'ready';
  scenarios.onchange = () => { void host.setScenario({ scenario: scenarios.value as DesktopScenario }).then(unwrap).then(render).catch(showError); };
  right.append(scenarios);
 }
 topbar.replaceChildren(left, right);
}

function heading(state: StateView): HTMLElement {
 const header = el('div', '', 'page-heading');
 const left = el('div');
 left.append(el('div', 'KURO workspace', 'eyebrow'), el('h1', page), el('p', PAGE_BLURB[page], 'subtitle'));
 header.append(left);
 if (page === 'Overview') {
  header.append(button('Refresh shared space', 'button secondary', async () => {
   unwrap(await app.refreshSpace({ spaceId: selectedSpace }));
   showNotice('Requested the current shared-space state from the authority.', 'success');
   await render();
  }));
 }
 const awaiting = state.requests.filter(r => r.state === 'REVIEW').length;
 if (page === 'Reviews' && awaiting > 0) header.append(badge(`${plural(awaiting, 'request')} awaiting review`, 'warn'));
 return header;
}

function overviewHero(state: StateView, info: DesktopInfo): HTMLElement {
 const hero = el('div', '', 'hero');
 const left = el('div');
 left.append(
  el('h2', info.mode === 'real' ? 'Local inference, explicit disclosure' : 'Ask a peer without handing over the source'),
  el('p', 'A custodian retrieves passages on their own device, reviews exactly what would be disclosed, and sends only what they approve. Nothing is indexed centrally.'),
 );
 const actions = el('div', '', 'row');
 actions.append(
  button('Ask a custodian', 'button accent', async () => { page = 'Ask'; await render(); }),
  button('Import a snapshot', 'button secondary', async () => { page = 'Import'; await render(); }),
 );
 left.append(actions);
 const visual = el('div', '', 'custody-visual');
 const paper = (lines: number): HTMLElement => { const p = el('div', '', 'paper'); for (let i = 0; i < lines; i++) p.append(el('div')); return p; };
 visual.append(paper(5), hidden('span', '→', 'transfer-symbol'), paper(3));
 visual.setAttribute('aria-hidden', 'true');
 hero.append(left, visual);
 return hero;
}

function overview(state: StateView, info: DesktopInfo): HTMLElement[] {
 const documents = state.documents.filter(d => d.spaceId === selectedSpace);
 const nodes: HTMLElement[] = [overviewHero(state, info)];
 const metrics = el('div', '', 'metrics');
 metrics.append(
  metric('Local documents', documents.length, 'In the selected space', '▤'),
  metric('Open requests', state.requests.length, 'Sent and received', '↗'),
  metric('Evidence bundles', state.evidenceIds.length, 'Approved and delivered', '❝'),
  metric('Summary drafts', state.summaries.length, 'Awaiting semantic review', '≡'),
 );
 nodes.push(metrics);
 // One exact sentence so the whole local footprint reads at a glance.
 nodes.push(el('p', `${plural(documents.length, 'document')} · ${plural(state.requests.length, 'request')} · ${plural(state.evidenceIds.length, 'evidence bundle')}`, 'subtitle mb'));

 const grid = el('div', '', 'grid-two');
 const requests = el('section', '', 'panel');
 requests.append(panelHeader('Requests', badge(plural(state.requests.length, 'total'))));
 if (!state.requests.length) requests.append(empty('No requests yet', 'Ask a custodian a question, or wait for one of your peers to send you theirs.'));
 else {
  const wrap = el('div', '', 'table-wrap');
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const column of ['Request', 'Space', 'State']) { const th = document.createElement('th'); th.textContent = column; head.append(th); }
  table.append(head);
  for (const request of state.requests) {
   const row = document.createElement('tr');
   const id = document.createElement('td'); id.append(el('code', short(request.requestId)));
   const space = document.createElement('td'); space.append(el('code', short(request.spaceId)));
   const state_ = document.createElement('td'); state_.append(badge(request.state, STATE_TONE[request.state] ?? ''));
   row.append(id, space, state_);
   table.append(row);
  }
  wrap.append(table);
  requests.append(wrap);
 }

 const side = el('section', '', 'panel');
 side.append(panelHeader('Local jobs'));
 if (!state.jobs.length) side.append(el('p', 'No embedding, retrieval or generation job is running on this device.', 'helper'));
 for (const job of state.jobs) {
  const row = el('div', '', 'row spread mb');
  row.append(el('code', short(job.jobId)), badge(job.state, STATE_TONE[job.state] ?? ''));
  if (['QUEUED', 'RUNNING'].includes(job.state)) row.append(button('Cancel job', 'button danger', async () => { unwrap(await app.cancelJob({ jobId: job.jobId })); await render(); }));
  side.append(row);
 }
 side.append(el('hr', '', 'divider'));
 side.append(el('div', 'How a disclosure happens', 'eyebrow'));
 const steps = el('div', '', 'steps');
 const flow: [string, string][] = [
  ['You ask', 'The question travels to one custodian you have verified.'],
  ['They retrieve locally', 'Access checks run first; only permitted passages are ranked.'],
  ['A person approves', 'The custodian reads the exact passages before anything is sent.'],
  ['You receive evidence', 'Passages arrive with their origin references. Summaries stay optional.'],
 ];
 flow.forEach(([title, body], index) => {
  const step = el('div', '', 'step');
  step.append(hidden('div', String(index + 1), 'step-number'));
  const text = el('div');
  text.append(el('strong', title), el('p', body));
  step.append(text);
  steps.append(step);
 });
 side.append(steps);

 grid.append(requests, side);
 nodes.push(grid);
 return nodes;
}

function importPage(state: StateView, info: DesktopInfo): HTMLElement[] {
 const documents = state.documents.filter(d => d.spaceId === selectedSpace);
 const grid = el('div', '', 'grid-two');
 const picker = el('section', '', 'panel');
 picker.append(panelHeader('Import a UTF-8 text snapshot'));
 const drop = el('div', '', 'file-picker');
 drop.append(hidden('div', '↓', 'metric-value'), el('p', 'New documents are private to this device member. Sharing requires an explicit document rule naming each member and action.'));
 drop.append(button('Choose text file and import', 'button', async () => {
  const file = unwrap(await host.selectText({}));
  if (!file) return;
  unwrap(await app.importText({ spaceId: selectedSpace, selectionId: file.selectionId, replaceDocumentId: null, expectedRevision: null, rules: [{ memberId: info.memberId, actions: ['read', 'share'], validUntilMs: null }] }));
  showNotice(`Imported ${file.displayName}. It is readable and shareable by this member only.`, 'success');
  await render();
 }));
 picker.append(drop);
 picker.append(el('p', 'Text is segmented and embedded locally. The original file is never copied to a peer.', 'helper mt'));

 const list = el('section', '', 'panel');
 list.append(panelHeader('Documents in this space', badge(plural(documents.length, 'document'))));
 if (!documents.length) list.append(empty('Nothing imported yet', 'Import a .txt snapshot to make it answerable by a custodian query on this device.'));
 for (const document_ of documents) {
  const row = el('div', '', 'row spread mb');
  const left = el('div');
  left.append(el('div', short(document_.documentId), 'list-title'), el('div', `Revision ${document_.revision}`, 'list-detail'));
  row.append(left, badge(document_.ingestionState, STATE_TONE[document_.ingestionState] ?? ''));
  list.append(row);
 }
 grid.append(picker, list);
 return [grid];
}

function askPage(info: DesktopInfo): HTMLElement[] {
 const panel = el('section', '', 'panel narrow');
 panel.append(panelHeader('Ask a custodian'));
 const form = el('div', '', 'form');
 const peerLabel = el('label', 'Custodian');
 const peer = document.createElement('select');
 peer.setAttribute('aria-label', 'Custodian');
 for (const entry of info.peers) {
  const option = document.createElement('option');
  option.value = entry.publicKey;
  option.textContent = entry.memberId ? `Member ${short(entry.memberId)} · key ${short(entry.publicKey)}` : `Key ${short(entry.publicKey)}`;
  peer.append(option);
 }
 peerLabel.append(peer);
 if (!info.peers.length) peerLabel.append(el('span', 'No peer is verified on this device yet. Pair one before asking.', 'helper'));

 const queryLabel = el('label', 'Question');
 const query = document.createElement('textarea');
 query.placeholder = 'What evidence do you need?';
 query.setAttribute('aria-label', 'Question');
 query.value = askQuery;
 query.oninput = () => { askQuery = query.value; };
 queryLabel.append(query, el('span', 'The custodian sees this question and decides which passages, if any, answer it.', 'helper'));

 const send = button('Send question', 'button', async () => {
  unwrap(await app.submitQuestion({ spaceId: selectedSpace, custodianKey: peer.value, query: query.value.trim(), ttlSeconds: 3600 }));
  askQuery = '';
  showNotice('Question sent. It stays pending until the custodian reviews and approves a disclosure.', 'success');
  page = 'Overview';
  await render();
 });
 send.disabled = !info.peers.length;
 const actions = el('div', '', 'row spread');
 actions.append(el('span', 'Valid for 1 hour', 'helper'), send);
 form.append(peerLabel, queryLabel, actions);
 panel.append(form);
 return [panel];
}

function detailPanel(kind: string): HTMLElement {
 const panel = el('section', '', kind === 'summary' ? 'panel summary-panel' : 'panel');
 panel.append(empty(kind === 'review' ? 'Select a request to review' : kind === 'evidence' ? 'Select an evidence bundle' : 'Select a summary draft', 'Protected content is authorized only while it is open, and is cleared as soon as the host closes access.'));
 return panel;
}
/** With nothing to open, the empty detail pane would only repeat the list's own empty state. */
function browser(list: HTMLElement, detail: HTMLElement, populated: boolean): HTMLElement {
 if (!populated) return list;
 const grid = el('div', '', 'grid-two');
 grid.append(list, detail);
 return grid;
}
/** Marks the open item so the list shows which protected view is authorized. */
function selectItem(items: HTMLElement, chosen: HTMLElement): void {
 for (const node of items.querySelectorAll('.list-item')) node.classList.remove('active');
 chosen.classList.add('active');
}

async function reviewsPage(): Promise<HTMLElement[]> {
 const detail = detailPanel('review');
 const list = el('section', '', 'panel');
 const reviews = unwrap(await app.listReviews({ spaceId: selectedSpace }));
 list.append(panelHeader('Waiting for you', badge(plural(reviews.length, 'draft'), reviews.length ? 'warn' : '')));
 if (!reviews.length) list.append(empty('No reviews waiting', 'When a peer asks a question that your documents can answer, the proposed disclosure appears here first.'));
 const items = el('div', '', 'list');
 for (const review of reviews) {
  const body = el('div');
  body.append(el('div', review.question, 'list-title'), el('div', `${plural(review.passages.length, 'passage')} · coverage ${review.coverage.toLowerCase()} · expires ${when(review.expiresAtMs)}`, 'list-detail'));
  const item: HTMLButtonElement = button(review.question, 'list-item', async () => {
   selectItem(items, item);
   await openProtected('review', detail, async () => unwrap(await app.getReview({ draftId: review.draftId })), (current, readToken) => showReview(current, detail, readToken), current => current.expiresAtMs);
  }, body);
  items.append(item);
 }
 list.append(items);
 return [browser(list, detail, reviews.length > 0)];
}

function evidencePage(state: StateView): HTMLElement[] {
 const detail = detailPanel('evidence');
 const list = el('section', '', 'panel');
 list.append(panelHeader('Received evidence', badge(plural(state.evidenceIds.length, 'bundle'))));
 if (!state.evidenceIds.length) list.append(empty('No evidence yet', 'Approved passages from a custodian appear here, together with the conditions they attached.'));
 const items = el('div', '', 'list');
 for (const responseId of state.evidenceIds) {
  const body = el('div');
  body.append(el('div', `Evidence ${short(responseId)}`, 'list-title'), el('div', 'Open to authorize and read', 'list-detail'));
  const item: HTMLButtonElement = button(`Open evidence ${short(responseId)}`, 'list-item', async () => {
   selectItem(items, item);
   await openProtected('evidence', detail, async () => unwrap(await app.getEvidence({ responseId })), (evidence, readToken) => showEvidence(evidence, detail, readToken), current => current.expiresAtMs);
  }, body);
  items.append(item);
 }
 list.append(items);
 return [browser(list, detail, state.evidenceIds.length > 0)];
}

function summariesPage(state: StateView): HTMLElement[] {
 const detail = detailPanel('summary');
 const list = el('section', '', 'panel');
 list.append(panelHeader('Local summary drafts', badge(plural(state.summaries.length, 'draft'), 'purple')));
 list.append(el('p', 'Private drafts require semantic review. Evidence remains independently readable.', 'helper mb'));
 if (!state.summaries.length) list.append(empty('No drafts yet', 'Open an evidence bundle whose conditions permit a local summary, then request one.'));
 const items = el('div', '', 'list');
 for (const entry of state.summaries) {
  const body = el('div');
  body.append(el('div', `Draft ${short(entry.summaryId)}`, 'list-title'), el('div', entry.state, 'list-detail'));
  const item: HTMLButtonElement = button(`${short(entry.summaryId)} · ${entry.state}`, 'list-item', async () => {
   selectItem(items, item);
   await openProtected('summary', detail, async () => unwrap(await app.getSummary({ summaryId: entry.summaryId })), (summary, readToken) => showSummary(summary, detail, readToken));
  }, body);
  items.append(item);
 }
 list.append(items);
 return [browser(list, detail, state.summaries.length > 0)];
}

function showEvidence(evidence: EvidenceView, panel: HTMLElement, token: number): void {
 if (!protectedCurrent(token, 'Evidence')) return;
 panel.replaceChildren(panelHeader(evidence.question, badge(`Expires ${when(evidence.expiresAtMs)}`, 'warn')));
 panel.append(el('p', `Sent by ${short(evidence.senderKey)} · received ${when(evidence.receivedAtMs)} · ${plural(evidence.passages.length, 'passage')}`, 'helper mb'));
 for (const passage of evidence.passages) panel.append(passageBlock(passage));
 panel.append(conditionsBlock(evidence.conditions));
 if (evidence.conditions.allowLocalSummary) {
  const actions = el('div', '', 'approval');
  actions.append(el('p', 'A local summary runs on this device only. It is a draft, never a substitute for the evidence above.', 'helper'));
  actions.append(button('Request optional local summary', 'button accent', async () => {
   unwrap(await app.requestLocalSummary({ responseId: evidence.responseId }));
   page = 'Summaries';
   await render();
  }));
  panel.append(actions);
 } else panel.append(el('p', 'The custodian did not permit a local summary of this evidence.', 'helper mt'));
}

function showSummary(summary: SummaryView, panel: HTMLElement, token: number): void {
 if (!protectedCurrent(token, 'Summaries')) return;
 panel.replaceChildren(el('div', 'Local draft · not evidence', 'summary-label'), el('h2', 'Summary draft — review required'));
 panel.append(el('p', `State ${summary.state} · ${plural(summary.claims.length, 'claim')} · every claim must be checked against its quote.`, 'helper mb'));
 if (!summary.claims.length) panel.append(empty('No claims drafted', 'The model reported that the approved evidence does not answer the question.'));
 for (const claim of summary.claims) {
  const box = el('div', '', 'summary-claim');
  box.append(el('p', claim.text));
  for (const quote of claim.quotes) box.append(passageBlock(quote));
  panel.append(box);
 }
}

function showReview(review: ReviewView, panel: HTMLElement, token: number): void {
 if (!protectedCurrent(token, 'Reviews')) return;
 panel.replaceChildren(panelHeader(review.question, badge(review.coverage, STATE_TONE[review.coverage] ?? '')));
 const meta = el('div', '', 'row mb');
 meta.append(badge(`Recipient ${short(review.recipientKey)}`), badge(`Expires ${when(review.expiresAtMs)}`, 'warn'), badge(`Revision ${review.revision}`));
 panel.append(meta);
 const keyBox = el('div', '', 'key-box');
 keyBox.append(el('div', 'Recipient device key', 'eyebrow'), el('code', review.recipientKey, 'code-full'));
 panel.append(keyBox);
 panel.append(el('p', 'Tick only the passages this recipient may read. The approval below commits exactly what is shown here.', 'helper mt mb'));

 const saved = reviewEdits.get(reviewKey(review));
 const selected = new Set(saved?.selectedSpanIds ?? review.selectedSpanIds);
 const allowSummary = document.createElement('input');
 allowSummary.type = 'checkbox';
 allowSummary.setAttribute('aria-label', 'Allow requester-local summary');
 allowSummary.checked = saved?.allowLocalSummary ?? review.conditions.allowLocalSummary;

 const approval = button('Approve exact reviewed evidence', 'button accent', async () => {
  if (!protectedCurrent(token, 'Reviews')) return;
  try {
   unwrap(await app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
   showNotice('Approved. The selected passages were committed to the outbox for this recipient.', 'success');
   await render();
  } catch (error) { if (protectedCurrent(token, 'Reviews')) { invalidateProtected(); closeProtected(panel, error); } }
 });
 const pendingEdits = el('p', 'Unsaved changes. Save the selection and conditions before approving.', 'helper');
 const syncApproval = (): void => {
  const unchanged = selected.size === review.selectedSpanIds.length && !review.selectedSpanIds.some(id => !selected.has(id)) && allowSummary.checked === review.conditions.allowLocalSummary;
  approval.disabled = !unchanged;
  pendingEdits.className = unchanged ? 'helper hidden' : 'helper';
 };
 const persistEdits = () => reviewEdits.set(reviewKey(review), { selectedSpanIds: [...selected], allowLocalSummary: allowSummary.checked });
 const markChanged = () => { persistEdits(); approval.disabled = true; pendingEdits.className = 'helper'; };

 for (const passage of review.passages) {
  const label = el('label', '', 'check');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(passage.ref.spanId);
  checkbox.setAttribute('aria-label', `Disclose passage ${short(passage.ref.spanId)}`);
  checkbox.onchange = () => { if (checkbox.checked) selected.add(passage.ref.spanId); else selected.delete(passage.ref.spanId); markChanged(); };
  label.append(checkbox, el('span', 'Include this passage in the disclosure'));
  panel.append(passageBlock(passage, label));
 }

 const approvalBox = el('div', '', 'approval');
 const conditionsLabel = el('label', '', 'check');
 allowSummary.onchange = markChanged;
 conditionsLabel.append(allowSummary, el('span', 'Permit the requester to make a local summary from this approved evidence.'));
 approvalBox.append(el('div', 'Processing conditions', 'eyebrow'), conditionsLabel);
 approvalBox.append(conditionsBlock({ ...review.conditions, allowLocalSummary: allowSummary.checked }));
 const actions = el('div', '', 'row spread');
 actions.append(
  button('Save passage selection and conditions', 'button secondary', async () => {
   if (!protectedCurrent(token, 'Reviews')) return;
   persistEdits();
   try {
    const updated = unwrap(await app.reviseDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest, selectedSpanIds: [...selected], conditions: { ...review.conditions, allowLocalSummary: allowSummary.checked } }));
    reviewEdits.delete(reviewKey(review));
    if (protectedCurrent(token, 'Reviews')) showReview(updated, panel, token);
   } catch (error) { if (protectedCurrent(token, 'Reviews')) { invalidateProtected(); closeProtected(panel, error); } }
  }),
  approval,
 );
 approvalBox.append(pendingEdits, actions);
 panel.append(approvalBox);
 syncApproval();
}

async function render(): Promise<void> {
 invalidateProtected();
 if (PROTECTED_PAGES.includes(page)) content.replaceChildren(el('p', 'Authorizing protected content…', 'starting'));
 const token = ++revision;
 const [stateResult, infoResult] = await Promise.all([app.getState({}), host.getInfo({})]);
 const state = unwrap(stateResult), info = unwrap(infoResult);
 if (token !== revision) return;
 if (!state.spaces.some(s => s.spaceId === selectedSpace)) selectedSpace = state.spaces[0]?.spaceId ?? '';

 renderSidebar(state, info);
 renderTopbar(state, info);
 const nodes: HTMLElement[] = [notice, heading(state)];
 if (info.mode === 'demo') nodes.push(el('p', 'Simulation active: AI and network results do not demonstrate real inference or cross-device delivery.', 'notice'));
 else if (info.mode === 'core-simulated') nodes.push(el('p', info.aiProvider === 'qvac'
  ? 'Real QVAC models run locally on this host. The network between the two devices is simulated, so this does not demonstrate cross-device delivery.'
  : 'Simulation active: AI and network results do not demonstrate real inference or cross-device delivery.', 'notice'));
 if (!state.clockEpochValid) nodes.push(el('p', 'Protected operations are closed until the host clock and lifecycle are validated.', 'notice error'));

 let body: HTMLElement[];
 if (page === 'Overview') body = overview(state, info);
 else if (page === 'Import') body = importPage(state, info);
 else if (page === 'Ask') body = askPage(info);
 else if (page === 'Evidence') body = evidencePage(state);
 else if (page === 'Summaries') body = summariesPage(state);
 else {
  body = await reviewsPage();
  if (token !== revision) return;
 }
 nodes.push(...body, el('p', 'Original documents and indexes stay with their custodian. KURO never builds a shared global index.', 'footer-note'));
 content.replaceChildren(...nodes);
}

let protectedValidationPending = false;
const unsubscribe = app.subscribe(() => { if (protectedSession) void reauthorizeProtected(); else void render().catch(showError); });
const timer = setInterval(() => {
 const session = protectedSession;
 if (session && Date.now() >= (session.expiresAtMs ?? Number.MAX_SAFE_INTEGER)) {
  if (protectedCurrent(session.token, session.page)) { invalidateProtected(); closeProtected(session.panel, new Error('EXPIRED')); }
  return;
 }
 if (session && !protectedValidationPending) {
  protectedValidationPending = true;
  void validateProtected(session).finally(() => { protectedValidationPending = false; });
 }
}, 1000);
window.addEventListener('beforeunload', () => { unsubscribe(); clearInterval(timer); });
void render().catch(showError);
