import type { DesktopBridge } from '../bridge.js';
import type { DesktopScenario, Result, ReviewView } from '@kuro/contracts';

declare global { interface Window { kuro: DesktopBridge } }

const { app, host } = window.kuro;
const root = document.querySelector<HTMLDivElement>('#app')!;
function el(tag: string, text = '', className = ''): HTMLElement { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function button(text: string, action: () => Promise<void>): HTMLButtonElement { const b = document.createElement('button'); b.textContent = text; b.className = 'list-item'; b.onclick = () => { b.disabled = true; void action().catch(showError).finally(() => { b.disabled = false; }); }; return b; }
function unwrap<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const notice = el('div', '', 'notice hidden'); notice.setAttribute('role', 'status');
function showError(error: unknown): void { notice.className = 'notice error'; notice.textContent = error instanceof Error ? error.message : 'Operation unavailable'; }

let page = 'Overview', selectedSpace = '', revision = 0, protectedRevision = 0, askQuery = '';
type ProtectedSession = {
 token: number; page: string; panel: HTMLElement; kind: 'review' | 'evidence' | 'summary';
 load: () => Promise<unknown>; display: (value: unknown, token: number) => void; expiresAtOf: (value: unknown) => number | undefined; fingerprint?: string; expiresAtMs?: number;
};
type ReviewEdits = { selectedSpanIds: string[]; allowLocalSummary: boolean };
let protectedSession: ProtectedSession | undefined;
const reviewEdits = new Map<string, ReviewEdits>();
const layout = el('div', '', 'layout'), sidebar = el('aside', '', 'sidebar'), workspace = el('div', '', 'workspace'), content = el('main', '', 'main');
sidebar.append(el('div', 'KURO', 'brand'), el('p', 'Private knowledge, shared carefully', 'brand-subtitle'));
for (const name of ['Overview', 'Import', 'Ask', 'Reviews', 'Evidence', 'Summaries']) {
 const b = button(name, async () => { page = name; await render(); }); b.className = 'nav-button'; sidebar.append(b);
}
workspace.append(notice, content); layout.append(sidebar, workspace); root.replaceChildren(layout);

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
 session.panel.replaceChildren(el('p', 'Authorizing protected view…'));
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
  updated.panel.replaceChildren(el('p', 'Protected view changed. Authorizing the current revision…'));
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

async function render(): Promise<void> {
 invalidateProtected();
 if (['Reviews', 'Evidence', 'Summaries'].includes(page)) content.replaceChildren(el('p', 'Authorizing protected content…'));
 const token = ++revision;
 const [stateResult, infoResult] = await Promise.all([app.getState({}), host.getInfo({})]);
 const state = unwrap(stateResult), info = unwrap(infoResult);
 if (token !== revision) return;
 if (!state.spaces.some(s => s.spaceId === selectedSpace)) selectedSpace = state.spaces[0]?.spaceId ?? '';
 const header = el('div', '', 'page-heading'); header.append(el('h1', page), el('p', `${info.mode} · Device ${info.profile}`, 'badge'));
 const select = document.createElement('select'); select.setAttribute('aria-label', 'Shared space');
 for (const space of state.spaces) { const o = document.createElement('option'); o.value = space.spaceId; o.textContent = `${space.isOwner ? 'Owner' : 'Participant'} · ${space.spaceId.slice(0, 8)} · ${space.syncState}`; select.append(o); }
 select.value = selectedSpace; select.onchange = () => { selectedSpace = select.value; void render().catch(showError); };
 content.replaceChildren(header, select);
 if (info.mode !== 'real') content.append(el('p', 'Simulation active: AI and network results do not demonstrate real inference or cross-device delivery.', 'notice'));
 if (!state.clockEpochValid) content.append(el('p', 'Protected operations are closed until the host clock and lifecycle are validated.', 'notice error'));
 const panel = el('section', '', 'panel stack'); content.append(panel);
 if (page === 'Overview') {
  panel.append(el('h2', 'Your local workspace'), el('p', `${state.documents.length} documents · ${state.requests.length} requests · ${state.evidenceIds.length} evidence bundles`));
  panel.append(button('Refresh shared space', async () => { unwrap(await app.refreshSpace({ spaceId: selectedSpace })); await render(); }));
  for (const request of state.requests) panel.append(el('p', `${request.requestId} · ${request.state}`));
  for (const job of state.jobs) { panel.append(el('p', `Job ${job.jobId} · ${job.state}`)); if (['QUEUED', 'RUNNING'].includes(job.state)) panel.append(button('Cancel job', async () => { unwrap(await app.cancelJob({ jobId: job.jobId })); await render(); })); }
  if (info.mode === 'demo') { const scenarios = document.createElement('select'); scenarios.setAttribute('aria-label', 'Simulation scenario'); for (const scenario of ['ready','waiting','offline','expired','stale-review','model-unavailable','capacity','error']) { const o = document.createElement('option'); o.value = scenario; o.textContent = scenario; scenarios.append(o); } scenarios.value = info.scenario ?? 'ready'; scenarios.onchange = () => { void host.setScenario({ scenario: scenarios.value as DesktopScenario }).then(unwrap).then(render).catch(showError); }; panel.append(scenarios); }
 }
 if (page === 'Import') {
  panel.append(el('h2', 'Import a private UTF-8 text snapshot'), el('p', 'New documents are private to this device member. Sharing requires explicit document permissions.'));
  panel.append(button('Choose text file and import', async () => { const file = unwrap(await host.selectText({})); if (!file) return; unwrap(await app.importText({ spaceId: selectedSpace, selectionId: file.selectionId, replaceDocumentId: null, expectedRevision: null, rules: [{ memberId: info.memberId, actions: ['read','share'], validUntilMs: null }] })); await render(); }));
  for (const document of state.documents.filter(d => d.spaceId === selectedSpace)) panel.append(el('p', `${document.documentId} · ${document.ingestionState}`));
 }
 if (page === 'Ask') {
  const query = document.createElement('textarea'); query.placeholder = 'What evidence do you need?'; query.setAttribute('aria-label', 'Question'); query.value = askQuery; query.oninput = () => { askQuery = query.value; };
  const peer = document.createElement('select'); peer.setAttribute('aria-label', 'Custodian'); for (const p of info.peers) { const o = document.createElement('option'); o.value = p.publicKey; o.textContent = p.publicKey; peer.append(o); }
  panel.append(el('h2', 'Ask a custodian'), peer, query, button('Send question', async () => { unwrap(await app.submitQuestion({ spaceId: selectedSpace, custodianKey: peer.value, query: query.value.trim(), ttlSeconds: 3600 })); askQuery = ''; page = 'Overview'; await render(); }));
 }
 if (page === 'Reviews') {
  const reviews = unwrap(await app.listReviews({ spaceId: selectedSpace })); if (token !== revision) return;
  if (!reviews.length) panel.append(el('p', 'No reviews waiting.'));
  for (const review of reviews) panel.append(button(review.question, async () => { await openProtected('review', panel, async () => unwrap(await app.getReview({ draftId: review.draftId })), (current, readToken) => showReview(current, panel, readToken), current => current.expiresAtMs); }));
 }
 if (page === 'Evidence') for (const responseId of state.evidenceIds) panel.append(button(`Open evidence ${responseId.slice(0,8)}`, async () => {
  await openProtected('evidence', panel, async () => unwrap(await app.getEvidence({ responseId })), (evidence, readToken) => {
   if (!protectedCurrent(readToken, 'Evidence')) return;
   panel.replaceChildren(el('h2', evidence.question));
   for (const passage of evidence.passages) panel.append(el('blockquote', passage.text, 'quote'), el('code', JSON.stringify(passage.ref)));
   panel.append(el('p', `Conditions: ${JSON.stringify(evidence.conditions)}`));
   if (evidence.conditions.allowLocalSummary) panel.append(button('Request optional local summary', async () => { unwrap(await app.requestLocalSummary({ responseId })); page = 'Summaries'; await render(); }));
  }, current => current.expiresAtMs);
 }));
 if (page === 'Summaries') {
  panel.append(el('p', 'Private drafts require semantic review. Evidence remains independently readable.'));
  for (const item of state.summaries) panel.append(button(`${item.summaryId.slice(0,8)} · ${item.state}`, async () => {
   await openProtected('summary', panel, async () => unwrap(await app.getSummary({ summaryId: item.summaryId })), (summary, readToken) => {
    if (!protectedCurrent(readToken, 'Summaries')) return;
    panel.replaceChildren(el('h2', 'Summary draft — review required'));
    for (const claim of summary.claims) { panel.append(el('p', claim.text)); for (const quote of claim.quotes) panel.append(el('blockquote', quote.text, 'quote'), el('code', JSON.stringify(quote.ref))); }
   });
  }));
 }
}

function showReview(review: ReviewView, panel: HTMLElement, token: number): void {
 if (!protectedCurrent(token, 'Reviews')) return;
 panel.replaceChildren(el('h2', review.question), el('p', `Recipient: ${review.recipientKey}`), el('p', `Coverage: ${review.coverage} · Expires: ${new Date(review.expiresAtMs).toISOString()}`));
 const saved = reviewEdits.get(reviewKey(review));
 const selected = new Set(saved?.selectedSpanIds ?? review.selectedSpanIds);
 const allowSummary = document.createElement('input'); allowSummary.type = 'checkbox'; allowSummary.setAttribute('aria-label', 'Allow requester-local summary'); allowSummary.checked = saved?.allowLocalSummary ?? review.conditions.allowLocalSummary;
 const approval = button('Approve exact reviewed evidence', async () => {
  if (!protectedCurrent(token, 'Reviews')) return;
  try { unwrap(await app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest })); await render(); }
  catch (error) { if (protectedCurrent(token, 'Reviews')) { invalidateProtected(); closeProtected(panel, error); } }
 });
 approval.disabled = selected.size !== review.selectedSpanIds.length || review.selectedSpanIds.some(id => !selected.has(id)) || allowSummary.checked !== review.conditions.allowLocalSummary;
 const persistEdits = () => reviewEdits.set(reviewKey(review), { selectedSpanIds: [...selected], allowLocalSummary: allowSummary.checked });
 const markChanged = () => { persistEdits(); approval.disabled = true; };
 for (const passage of review.passages) {
  const label = el('label', '', 'source'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(passage.ref.spanId);
  checkbox.onchange = () => { if (checkbox.checked) selected.add(passage.ref.spanId); else selected.delete(passage.ref.spanId); markChanged(); };
  label.append(checkbox, el('blockquote', passage.text, 'quote'), el('code', JSON.stringify(passage.ref))); panel.append(label);
 }
 const conditionsLabel = el('label', 'Processing conditions', 'source');
 allowSummary.onchange = markChanged;
 conditionsLabel.append(allowSummary, el('span', 'Permit the requester to make a local summary from this approved evidence.'));
 panel.append(conditionsLabel, el('p', `Conditions: ${JSON.stringify({ ...review.conditions, allowLocalSummary: allowSummary.checked })}`));
 panel.append(button('Save passage selection and conditions', async () => {
  if (!protectedCurrent(token, 'Reviews')) return;
  persistEdits();
  try {
   const updated = unwrap(await app.reviseDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest, selectedSpanIds: [...selected], conditions: { ...review.conditions, allowLocalSummary: allowSummary.checked } }));
   reviewEdits.delete(reviewKey(review));
   if (protectedCurrent(token, 'Reviews')) showReview(updated, panel, token);
  } catch (error) { if (protectedCurrent(token, 'Reviews')) { invalidateProtected(); closeProtected(panel, error); } }
 }));
 panel.append(approval);
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
