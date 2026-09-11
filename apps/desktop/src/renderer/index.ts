import type { DesktopBridge } from '../bridge.js';
import type { Result, ReviewView, DesktopScenario } from '@kuro/contracts';
declare global { interface Window { kuro: DesktopBridge } }
const { app, host } = window.kuro;
const root = document.querySelector<HTMLDivElement>('#app')!;
function el(tag: string, text = '', className = ''): HTMLElement { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function button(text: string, action: () => Promise<void>): HTMLButtonElement { const b = document.createElement('button'); b.textContent = text; b.className = 'list-item'; b.onclick = () => { b.disabled = true; void action().catch(showError).finally(() => { b.disabled = false; }); }; return b; }
function unwrap<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
const notice = el('div', '', 'notice hidden'); notice.setAttribute('role', 'status');
function showError(error: unknown): void { notice.className = 'notice error'; notice.textContent = error instanceof Error ? error.message : 'Operation unavailable'; }
let page = 'Overview', selectedSpace = '', revision = 0;
const layout = el('div', '', 'layout'), sidebar = el('aside', '', 'sidebar'), workspace = el('div', '', 'workspace'), content = el('main', '', 'main');
sidebar.append(el('div', 'KURO', 'brand'), el('p', 'Private knowledge, shared carefully', 'brand-subtitle'));
for (const name of ['Overview', 'Import', 'Ask', 'Reviews', 'Evidence', 'Summaries']) { const b = button(name, async () => { page = name; await render(); }); b.className = 'nav-button'; sidebar.append(b); }
workspace.append(notice, content); layout.append(sidebar, workspace); root.replaceChildren(layout);
async function render(): Promise<void> {
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
  const query = document.createElement('textarea'); query.placeholder = 'What evidence do you need?'; query.setAttribute('aria-label', 'Question');
  const peer = document.createElement('select'); peer.setAttribute('aria-label', 'Custodian'); for (const p of info.peers) { const o = document.createElement('option'); o.value = p.publicKey; o.textContent = p.publicKey; peer.append(o); }
  panel.append(el('h2', 'Ask a custodian'), peer, query, button('Send question', async () => { unwrap(await app.submitQuestion({ spaceId: selectedSpace, custodianKey: peer.value, query: query.value.trim(), ttlSeconds: 3600 })); page = 'Overview'; await render(); }));
 }
 if (page === 'Reviews') {
  const reviews = unwrap(await app.listReviews({ spaceId: selectedSpace })); if (token !== revision) return;
  if (!reviews.length) panel.append(el('p', 'No reviews waiting.'));
  for (const review of reviews) panel.append(button(review.question, async () => { const current = unwrap(await app.getReview({ draftId: review.draftId })); showReview(current, panel); }));
 }
 if (page === 'Evidence') for (const responseId of state.evidenceIds) panel.append(button(`Open evidence ${responseId.slice(0,8)}`, async () => {
  const evidence = unwrap(await app.getEvidence({ responseId })); panel.replaceChildren(el('h2', evidence.question));
  for (const passage of evidence.passages) panel.append(el('blockquote', passage.text, 'quote'), el('code', JSON.stringify(passage.ref)));
  panel.append(el('p', `Conditions: ${JSON.stringify(evidence.conditions)}`));
  if (evidence.conditions.allowLocalSummary) panel.append(button('Request optional local summary', async () => { unwrap(await app.requestLocalSummary({ responseId })); page = 'Summaries'; await render(); }));
 }));
 if (page === 'Summaries') { panel.append(el('p', 'Private drafts require semantic review. Evidence remains independently readable.')); for (const item of state.summaries) panel.append(button(`${item.summaryId.slice(0,8)} · ${item.state}`, async () => { const summary = unwrap(await app.getSummary({ summaryId: item.summaryId })); panel.replaceChildren(el('h2', 'Summary draft — review required')); for (const claim of summary.claims) { panel.append(el('p', claim.text)); for (const quote of claim.quotes) panel.append(el('blockquote', quote.text, 'quote'), el('code', JSON.stringify(quote.ref))); } })); }
}
function showReview(review: ReviewView, panel: HTMLElement): void {
 panel.replaceChildren(el('h2', review.question), el('p', `Recipient: ${review.recipientKey}`), el('p', `Coverage: ${review.coverage} · Expires: ${new Date(review.expiresAtMs).toISOString()}`), el('p', `Conditions: ${JSON.stringify(review.conditions)}`));
 const selected = new Set(review.selectedSpanIds);
 for (const passage of review.passages) { const label = el('label', '', 'source'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(passage.ref.spanId); checkbox.onchange = () => { if (checkbox.checked) selected.add(passage.ref.spanId); else selected.delete(passage.ref.spanId); approve.disabled = true; }; label.append(checkbox, el('blockquote', passage.text, 'quote'), el('code', JSON.stringify(passage.ref))); panel.append(label); }
 panel.append(button('Save passage selection', async () => { const updated = unwrap(await app.reviseDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest, selectedSpanIds: [...selected], conditions: review.conditions })); showReview(updated, panel); }));
 const approve = button('Approve exact reviewed evidence', async () => { unwrap(await app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest })); await render(); }); panel.append(approve);
}
let refreshPending = false;
const unsubscribe = app.subscribe(() => { refreshPending = true; });
const timer = setInterval(() => { if (page === 'Overview' && refreshPending) { refreshPending = false; void render().catch(showError); } }, 1500);
window.addEventListener('beforeunload', () => { unsubscribe(); clearInterval(timer); });
void render().catch(showError);
