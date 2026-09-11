import type { DesktopBridge } from '../bridge.js';
import type { Capability, DesktopScenario, DesktopSetup, Result, ReviewView, SpaceView } from '@kuro/contracts';

declare global { interface Window { kuro: DesktopBridge } }

const { app, host } = window.kuro;
const root = document.querySelector<HTMLDivElement>('#app')!;
function el(tag: string, text = '', className = ''): HTMLElement { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
function hidden(tag: string, text: string, className = ''): HTMLElement { const node = el(tag, text, className); node.setAttribute('aria-hidden', 'true'); return node; }
function button(text: string, action: () => Promise<void>): HTMLButtonElement { const b = document.createElement('button'); b.textContent = text; b.className = 'list-item'; b.onclick = () => { b.disabled = true; void action().catch(showError).finally(() => { b.disabled = false; }); }; return b; }
function unwrap<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.code); return r.value; }
function metric(label: string, value: number): HTMLElement { const node = el('div', '', 'metric'); node.append(el('div', label, 'metric-label'), el('div', String(value), 'metric-value')); return node; }
const notice = el('div', '', 'notice hidden'); notice.setAttribute('role', 'status');
function showNotice(message: string): void { notice.className = 'notice'; notice.textContent = message; }
const errorExplanation: Record<string, string> = {
 CLOCK_UNCERTAIN: 'Protected actions are paused. Restore the device clock or resume the workspace, then refresh the shared space.',
 ACCESS_DENIED: 'This action is not allowed. The shared-space owner manages membership; this device still needs a local grant and an explicit document permission.',
 STALE_REVISION: 'This information changed. Refresh, then review the current version before saving or approving.',
 MODEL_UNAVAILABLE: 'A required local model is unavailable. Open Models and prepare it before trying again.',
 PEER_OFFLINE: 'The other device is unavailable. Check that both devices are on the selected private LAN and retry.',
 IDENTITY_UNAVAILABLE: 'The protected keychain is unavailable. Unlock or restore the native keychain, then try again.',
 CAPACITY_EXCEEDED: 'KURO is busy. Wait for the current work to finish or cancel a queued task, then try again.',
 CANCELLED: 'The operation was cancelled. Start it again if it is still needed.',
 EXPIRED: 'This access period ended. Refresh the shared space and review the current permissions before continuing.',
};
function showError(error: unknown): void {
 const code = error instanceof Error ? error.message : 'OPERATION_UNAVAILABLE';
 notice.className = 'notice error'; notice.textContent = `${code}: ${errorExplanation[code] ?? 'The operation is unavailable. Refresh the page and try again.'}`;
}

let page = 'Overview', selectedSpace = '', revision = 0, protectedRevision = 0, askQuery = '';
let latestSetup: DesktopSetup | undefined;
let setupDraft: { displayName: string; bootstrapHost: string; bootstrapPort: string; localPort: string; hostLan: boolean; lanAddress: string } | undefined;
let setupDirty = false, adminFormDirty = false, refreshPending = false;
const capabilities: Capability[] = ['search', 'read', 'share', 'receive', 'manage'];
type ProtectedSession = {
 token: number; page: string; panel: HTMLElement; kind: 'review' | 'evidence' | 'summary';
 load: () => Promise<unknown>; display: (value: unknown, token: number) => void; expiresAtOf: (value: unknown) => number | undefined; fingerprint?: string; expiresAtMs?: number;
};
type ReviewEdits = { selectedSpanIds: string[]; allowLocalSummary: boolean };
let protectedSession: ProtectedSession | undefined;
const reviewEdits = new Map<string, ReviewEdits>();
const pages = ['Overview', 'Setup', 'Models', 'Spaces', 'Permissions', 'Import', 'Ask', 'Reviews', 'Evidence', 'Summaries'];
const layout = el('div', '', 'layout'), sidebar = el('aside', '', 'sidebar'), workspace = el('div', '', 'workspace'), topbar = el('header', '', 'topbar'), content = el('main', '', 'main');
const nav = el('nav', '', 'nav');
const navButtons = new Map<string, HTMLButtonElement>();
const brand = el('div', '', 'brand'); brand.append(hidden('span', 'K', 'brand-mark'), el('span', 'KURO'));
sidebar.append(brand, el('p', 'Private knowledge, shared carefully', 'brand-subtitle'), el('div', 'Workspace', 'section-label'));
for (const name of pages) {
 const b = button(name, async () => { page = name; await render(); }); b.className = 'nav-button'; navButtons.set(name, b); nav.append(b);
}
const sidebarNote = el('div', '', 'sidebar-note'); sidebarNote.append(el('strong', 'Source custody'), el('p', 'Original documents and indexes never leave this device. Only passages a reviewer approves are sent.'));
sidebar.append(nav, sidebarNote);

function capsInput(initial: Capability[] = [], label = 'Capabilities', allowed: Capability[] = capabilities): { node: HTMLElement; value: () => Capability[] } {
 const checks = new Map<Capability, HTMLInputElement>(); const node = document.createElement('fieldset'); node.className = 'checkbox-row'; const legend = el('legend', label); node.append(legend);
 for (const capability of allowed) { const label = el('label', capability, 'inline-check'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = initial.includes(capability); checks.set(capability, input); label.prepend(input); node.append(label); }
 return { node, value: () => allowed.filter(capability => checks.get(capability)!.checked) };
}
function expiryInput(value: number | null = null): { node: HTMLInputElement; value: () => number | null } {
 const input = document.createElement('input'); input.type = 'datetime-local';
 if (value) { const date = new Date(value), pad = (n: number) => String(n).padStart(2, '0'); input.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
 let unchanged = true; input.oninput = () => { unchanged = false; };
 return { node: input, value: () => unchanged ? value : input.value ? new Date(input.value).getTime() : null };
}
function bindingText(binding: { kind: string; spaceId: string; spaceAlias: string; authorityKey?: string; peerKey?: string; memberId?: string }): string {
 return `Verified ${binding.kind} binding · space ${binding.spaceId} · alias ${binding.spaceAlias} · key ${binding.authorityKey ?? binding.peerKey ?? ''}${binding.memberId ? ` · member ${binding.memberId}` : ''}`;
}
function selected(spaceId: string): SpaceView | undefined { return currentState?.spaces.find(space => space.spaceId === spaceId); }
let currentState: Awaited<ReturnType<typeof app.getState>> extends Result<infer T> ? T | undefined : never;
workspace.append(notice, topbar, content); layout.append(sidebar, workspace); root.replaceChildren(layout);
function markActivePage(): void {
 for (const [name, item] of navButtons) {
  const active = name === page;
  item.classList.toggle('active', active);
  if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
 }
}
function showRefreshNeeded(): void { notice.className = 'notice'; notice.replaceChildren(document.createTextNode('Changes were committed elsewhere. '), button('Refresh page', async () => { adminFormDirty = false; await render(); })); }
content.addEventListener('input', () => { if (['Spaces', 'Permissions'].includes(page)) adminFormDirty = true; });
content.addEventListener('change', () => { if (['Spaces', 'Permissions'].includes(page)) adminFormDirty = true; });
content.addEventListener('focusin', event => { if (['Spaces', 'Permissions'].includes(page) && (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)) adminFormDirty = true; });
function refreshAfterCommit(): void {
 if (protectedSession) { void reauthorizeProtected(); return; }
 if (adminFormDirty) { refreshPending = true; showRefreshNeeded(); return; }
 void render().catch(showError);
}

function invalidateProtected(): void {
 const session = protectedSession;
 protectedRevision++; protectedSession = undefined;
 if (session) session.panel.replaceChildren(el('p', 'Protected view cleared. Reopen it to authorize the current state.', 'notice error'));
}
window.addEventListener('kuro:lifecycle-invalidated', () => {
 revision++;
 invalidateProtected();
 reviewEdits.clear();
 topbar.replaceChildren(el('div', 'Private workspace', 'topbar-left'));
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
 if (refreshPending) { notice.className = 'notice hidden'; notice.replaceChildren(); }
 adminFormDirty = false; refreshPending = false;
 markActivePage();
 invalidateProtected();
 if (['Reviews', 'Evidence', 'Summaries'].includes(page)) content.replaceChildren(el('p', 'Authorizing protected content…'));
 const token = ++revision;
 // Setup is deliberately content-free and must be the first desktop read: an unconfigured core has no StateView.
 const setup = unwrap(await host.getSetup({})); latestSetup = setup;
 if (token !== revision) return;
 if (setup.runtime !== 'running' || page === 'Setup' || page === 'Models') {
  if (setup.runtime !== 'running' && page !== 'Models') page = 'Setup';
  renderRecovery(setup); return;
 }
 let state: NonNullable<typeof currentState>, info: Awaited<ReturnType<typeof host.getInfo>> extends Result<infer T> ? T : never;
 try {
  const [stateResult, infoResult] = await Promise.all([app.getState({}), host.getInfo({})]);
  state = unwrap(stateResult); info = unwrap(infoResult); currentState = state;
 } catch (error) {
  if (error instanceof Error && error.message === 'CLOCK_UNCERTAIN') { page = 'Setup'; renderRecovery(setup); return; }
  throw error;
 }
 if (token !== revision) return;
 if (!state.spaces.some(s => s.spaceId === selectedSpace)) selectedSpace = state.spaces[0]?.spaceId ?? '';
 const header = el('div', '', 'page-heading'); header.append(el('h1', page), el('p', `${info.mode} · Device ${info.profile}`, 'badge'));
 const select = document.createElement('select'); select.className = 'space-select'; select.setAttribute('aria-label', 'Shared space');
 for (const space of state.spaces) { const o = document.createElement('option'); o.value = space.spaceId; o.textContent = `${space.isOwner ? 'Owner' : 'Participant'} · ${space.spaceId.slice(0, 8)} · ${space.syncState}`; select.append(o); }
 select.value = selectedSpace; select.onchange = () => { selectedSpace = select.value; void render().catch(showError); };
 const workspaceLabel = el('div', '', 'topbar-left'); workspaceLabel.append(hidden('span', '', 'status-dot'), el('span', 'Private workspace'));
 topbar.replaceChildren(workspaceLabel, select);
 content.replaceChildren(header);
 if (info.mode === 'core-simulated' && info.aiProvider === 'qvac') content.append(el('p', 'Actual QVAC models run locally on this device. The network and identities are simulated, so this does not demonstrate cross-device delivery.', 'notice'));
 else if (info.mode !== 'real') content.append(el('p', 'Simulation active: AI and network results do not demonstrate real inference or cross-device delivery.', 'notice'));
 if (!state.clockEpochValid) content.append(el('p', 'CLOCK_UNCERTAIN: protected actions are paused. Restore the device clock or resume the workspace, then refresh this shared space.', 'notice error'));
 const panel = el('section', '', 'panel stack'); content.append(panel);
 if (page === 'Overview') {
  const metrics = el('div', '', 'metrics'); metrics.append(metric('Documents', state.documents.length), metric('Requests', state.requests.length), metric('Evidence bundles', state.evidenceIds.length), metric('Summary drafts', state.summaries.length)); panel.append(metrics);
  panel.append(el('h2', 'Your local workspace'), el('p', `${state.documents.length} documents · ${state.requests.length} requests · ${state.evidenceIds.length} evidence bundles`));
  if (selectedSpace) panel.append(button('Refresh shared space', async () => { unwrap(await app.refreshSpace({ spaceId: selectedSpace })); await render(); }));
  else panel.append(el('p', 'Create or pair a shared space to begin.', 'notice'));
  for (const request of state.requests) panel.append(el('p', `${request.requestId} · ${request.state}`));
  for (const job of state.jobs) { panel.append(el('p', `Job ${job.jobId} · ${job.state}`)); if (['QUEUED', 'RUNNING'].includes(job.state)) panel.append(button('Cancel job', async () => { unwrap(await app.cancelJob({ jobId: job.jobId })); await render(); })); }
  if (info.mode === 'demo') { const scenarios = document.createElement('select'); scenarios.setAttribute('aria-label', 'Simulation scenario'); for (const scenario of ['ready','waiting','offline','expired','stale-review','model-unavailable','capacity','error']) { const o = document.createElement('option'); o.value = scenario; o.textContent = scenario; scenarios.append(o); } scenarios.value = info.scenario ?? 'ready'; scenarios.onchange = () => { void host.setScenario({ scenario: scenarios.value as DesktopScenario }).then(unwrap).then(render).catch(showError); }; panel.append(scenarios); }
 }
 if (page === 'Spaces') await renderSpaces(panel, state, info.memberId);
 if (page === 'Permissions') await renderPermissions(panel, state, info.memberId);
 if (page === 'Import') {
  panel.append(el('h2', 'Import a private UTF-8 text snapshot'), el('p', 'New documents are private to this device member. Sharing requires explicit document permissions.'));
  if (selectedSpace) panel.append(button('Choose text file and import', async () => { const file = unwrap(await host.selectText({})); if (!file) return; unwrap(await app.importText({ spaceId: selectedSpace, selectionId: file.selectionId, replaceDocumentId: null, expectedRevision: null, rules: [{ memberId: info.memberId, actions: ['read','share'], validUntilMs: null }] })); await render(); }));
  else panel.append(el('p', 'Create or pair a space before importing.', 'notice'));
  for (const documentEntry of state.documents.filter(d => d.spaceId === selectedSpace)) panel.append(el('p', `${documentEntry.documentId} · ${documentEntry.ingestionState}`));
 }
 if (page === 'Ask') {
  if (!selectedSpace) { panel.append(el('h2', 'Ask a custodian'), el('p', 'Create or pair a space before sending a question.', 'notice')); return; }
  const query = document.createElement('textarea'); query.placeholder = 'What evidence do you need?'; query.setAttribute('aria-label', 'Question'); query.value = askQuery; query.oninput = () => { askQuery = query.value; };
  const peer = document.createElement('select'); peer.setAttribute('aria-label', 'Custodian');
  const administration = unwrap(await app.getSpaceAdministration({ spaceId: selectedSpace }));
  const projectedKeys = administration.scope === 'owner'
   ? administration.members.flatMap(member => member.devices.map(device => ({ memberId: member.memberId, publicKey: device.publicKey })))
   : administration.members.flatMap(member => member.deviceKeys.map(publicKey => ({ memberId: member.memberId, publicKey })));
  for (const p of projectedKeys) if (p.memberId !== info.memberId && p.publicKey !== info.publicKey) { const o = document.createElement('option'); o.value = p.publicKey; o.textContent = `${p.memberId.slice(0, 8)} · ${p.publicKey}`; peer.append(o); }
  panel.append(el('h2', 'Ask a custodian'), peer, query);
  if (!peer.options.length) panel.append(el('p', 'No custodian is available in this selected space projection.', 'notice'));
  else panel.append(button('Send question', async () => { unwrap(await app.submitQuestion({ spaceId: selectedSpace, custodianKey: peer.value, query: query.value.trim(), ttlSeconds: 3600 })); askQuery = ''; page = 'Overview'; await render(); }));
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

function renderRecovery(setup: DesktopSetup): void {
 markActivePage();
 topbar.replaceChildren(el('div', 'Private workspace', 'topbar-left'));
 if (page === 'Models') {
  const heading = el('div', '', 'page-heading'); heading.append(el('h1', 'Models'), el('p', `Runtime ${setup.runtime}`, 'badge'));
  const panel = el('section', '', 'panel stack'); content.replaceChildren(heading, panel); renderModels(setup, panel); return;
 }
 renderSetup(setup);
}

function renderSetup(setup: DesktopSetup, existingPanel?: HTMLElement): void {
 const panel = existingPanel ?? el('section', '', 'panel stack');
 if (!existingPanel) content.replaceChildren(el('div', 'KURO setup', 'page-heading'), panel);
 const preferredLan = setup.localAddresses.find(address => !address.startsWith('127.')) ?? setup.localAddresses[0] ?? '';
 const draft = setupDraft ?? { displayName: setup.displayName ?? '', bootstrapHost: setup.network?.bootstrap[0]?.host ?? '', bootstrapPort: String(setup.network?.bootstrap[0]?.port ?? ''), localPort: setup.network?.localPort ? String(setup.network.localPort) : '', hostLan: setup.network?.bootstrapPort !== null && setup.network?.bootstrapPort !== undefined, lanAddress: preferredLan };
 setupDraft = draft;
 const name = document.createElement('input'); name.setAttribute('aria-label', 'Device name'); name.value = draft.displayName; name.placeholder = 'This device name'; name.oninput = () => { draft.displayName = name.value; setupDirty = true; };
 const hostName = document.createElement('input'); hostName.setAttribute('aria-label', 'Private bootstrap host'); hostName.value = draft.bootstrapHost; hostName.placeholder = 'bootstrap.example or LAN IPv4'; hostName.oninput = () => { draft.bootstrapHost = hostName.value; setupDirty = true; };
 const peerPort = document.createElement('input'); peerPort.setAttribute('aria-label', 'Bootstrap port'); peerPort.type = 'number'; peerPort.value = draft.bootstrapPort; peerPort.placeholder = 'Bootstrap port'; peerPort.oninput = () => { draft.bootstrapPort = peerPort.value; setupDirty = true; };
 const localPort = document.createElement('input'); localPort.setAttribute('aria-label', 'Local UDP port'); localPort.type = 'number'; localPort.value = draft.localPort; localPort.placeholder = 'Optional local UDP port'; localPort.oninput = () => { draft.localPort = localPort.value; setupDirty = true; };
 const lan = document.createElement('input'); lan.type = 'checkbox'; lan.checked = draft.hostLan; lan.onchange = () => { draft.hostLan = lan.checked; setupDirty = true; };
 const lanAddress = document.createElement('select'); lanAddress.setAttribute('aria-label', 'LAN bootstrap address'); for (const address of setup.localAddresses) { const option = document.createElement('option'); option.value = address; option.textContent = address; lanAddress.append(option); } lanAddress.value = draft.lanAddress; lanAddress.onchange = () => { draft.lanAddress = lanAddress.value; setupDirty = true; };
 panel.append(el('h2', 'Set up this KURO workspace'), el('p', `Runtime: ${setup.runtime}`), el('p', 'Choose a device name and a private connection route. KURO never enables public discovery automatically.'), el('p', 'Native KURO requires macOS 26.5 (Darwin 25.5.0, build 25F71) on arm64. Unsupported systems stay closed to protect your data.', 'notice'));
 panel.append(el('label', 'Device name')); panel.append(name); panel.append(el('label', 'Private bootstrap host')); panel.append(hostName); panel.append(el('label', 'Bootstrap port')); panel.append(peerPort);
 const lanLabel = el('label', 'Host a private LAN bootstrap', 'inline-check'); lanLabel.prepend(lan); panel.append(lanLabel);
 panel.append(el('label', 'LAN bootstrap address'), lanAddress);
 panel.append(el('label', 'Local UDP port (optional)')); panel.append(localPort);
 panel.append(el('p', `Platform ${setup.platform}/${setup.architecture} · KURO version ${setup.version}`), el('p', `Key protection: ${setup.secretProtection} · Clock protection: ${setup.clockProtection}`));
 if (setup.localAddresses.length) panel.append(el('p', `Available LAN bootstrap addresses: ${setup.localAddresses.join(', ')}`));
 if (setup.error) panel.append(el('p', `${setup.error}: ${errorExplanation[setup.error] ?? 'The workspace could not start. Check the setup details and try again.'}`, 'notice error'));
 if (setup.runtime === 'unconfigured' || setup.runtime === 'stopped') panel.append(button('Link my existing identity before first start', async () => { const linked = unwrap(await host.selectLinkedIdentity({})); if (linked) { notice.className = 'notice'; notice.textContent = `Identity linked for member ${linked.memberId}. Enroll this device separately with each space owner.`; } }));
 if (setup.runtime === 'running') panel.append(button('Export my public identity for a linked device', async () => { const file = unwrap(await host.exportIdentity({})); if (file) { notice.className = 'notice'; notice.textContent = `Public identity exported: ${file.displayName}. This file contains no secret key or grant.`; } }));
 panel.append(button('Save profile and start workspace', async () => {
  const port = Number(draft.bootstrapPort), local = draft.localPort ? Number(draft.localPort) : null;
  const bootstrapHost = draft.hostLan ? draft.lanAddress : draft.bootstrapHost.trim();
  if (!bootstrapHost || !Number.isInteger(port)) throw new Error('Enter one bounded bootstrap host and port.');
  unwrap(await host.saveProfile({ displayName: draft.displayName.trim(), network: { bootstrap: [{ host: bootstrapHost, port }], localPort: local, bootstrapPort: draft.hostLan ? port : null } }));
  setupDirty = false; unwrap(await host.startWorkspace({})); await render();
 }));
 if (setup.runtime === 'failed' || setup.runtime === 'stopped') panel.append(button('Retry workspace start', async () => { unwrap(await host.startWorkspace({})); await render(); }));
 if (setup.runtime === 'running') panel.append(button('Restart workspace', async () => { unwrap(await host.stopWorkspace({})); unwrap(await host.startWorkspace({})); await render(); }));
 if (setup.runtime === 'running') panel.append(button('Stop workspace', async () => { unwrap(await host.stopWorkspace({})); await render(); }));
}

function renderModels(setup: DesktopSetup, panel: HTMLElement): void {
 panel.append(el('h2', 'Local models'), el('p', `Free disk space: ${setup.freeDiskBytes === null ? 'unavailable' : `${Math.floor(setup.freeDiskBytes / 1024 / 1024)} MB`}. KURO downloads models only from its built-in sources and verifies each download.`));
 for (const model of setup.models) {
  const item = el('div', '', 'source'); const percent = model.bytes ? Math.floor(model.downloadedBytes / model.bytes * 100) : 0;
  item.append(el('h3', `${model.kind === 'embedding' ? 'Embedding index' : 'Optional local summary'} · ${model.name}`), el('p', `${model.state} · ${percent}% · ${Math.floor(model.downloadedBytes / 1024 / 1024)} / ${Math.floor(model.bytes / 1024 / 1024)} MB`));
  if (model.error) item.append(el('p', model.error, 'notice error'));
  if (['missing', 'failed', 'cancelled'].includes(model.state)) item.append(button(`Prepare ${model.kind} model`, async () => { unwrap(await host.prepareModel({ kind: model.kind })); await render(); }));
  if (['checking', 'downloading', 'verifying'].includes(model.state)) item.append(button(`Cancel ${model.kind} download`, async () => { unwrap(await host.cancelModel({ kind: model.kind })); await render(); }));
  panel.append(item);
 }
 if (setup.embeddingProfile) panel.append(button('Start authorized index rebuild', async () => {
  // Domain state is intentionally read only after this explicit user activation.
  const state = unwrap(await app.getState({})); const space = state.spaces.find(item => item.spaceId === selectedSpace) ?? state.spaces[0];
  if (!space) throw new Error('Create or pair a space before rebuilding its index.');
  selectedSpace = space.spaceId; unwrap(await app.setIndexProfile({ spaceId: space.spaceId, profile: setup.embeddingProfile!, expectedRevision: space.corpusRevision })); await render();
 }));
}

async function renderSpaces(panel: HTMLElement, state: NonNullable<typeof currentState>, memberId: string): Promise<void> {
 panel.append(el('h2', 'Shared spaces'), el('p', 'The space owner decides who may join. Joining a space does not give anyone access to your documents.'));
 const sharedCaps = capsInput(['search', 'read'], 'Owner capabilities'); const localCaps = capsInput(['search', 'read'], 'Local actions');
 panel.append(el('h3', 'Create owner space'), el('p', 'Choose explicit owner capabilities and local actions.'), sharedCaps.node, localCaps.node, button('Create owner space', async () => { const space = unwrap(await app.createSpace({ capabilities: sharedCaps.value(), localActions: localCaps.value() })); selectedSpace = space.spaceId; await render(); }));
 panel.append(button('Verify pairing and continue', async () => {
  const selectedPairing = unwrap(await host.selectPairing({})); if (!selectedPairing) return;
  const { binding, selectionId } = selectedPairing; panel.append(el('p', bindingText(binding), 'notice'));
  if (binding.kind === 'authority') { const space = unwrap(await app.pairSpace({ selectionId, localActions: localCaps.value() })); selectedSpace = space.spaceId; }
  else if (binding.kind === 'member') { const space = selectedSpace ? selected(selectedSpace) : undefined; if (!space?.isOwner) throw new Error('Select an owner space before enrolling a verified member.'); unwrap(await app.enrollMember({ spaceId: space.spaceId, selectionId, capabilities: sharedCaps.value(), validUntilMs: null, expectedRevision: space.policyRevision })); }
  else unwrap(await app.pairPeer({ selectionId }));
  await render();
 }));
 for (const space of state.spaces) {
  const section = el('div', '', 'source'); section.append(el('h3', `${space.isOwner ? 'Owner' : 'Participant'} · ${space.spaceId}`), el('p', `${space.syncState} · remaining ${Math.floor(space.remainingValidityMs / 1000)}s · last sync ${space.lastSyncMs ? new Date(space.lastSyncMs).toLocaleString() : 'never'}`));
  section.append(button('Refresh shared space', async () => { unwrap(await app.refreshSpace({ spaceId: space.spaceId })); await render(); }));
  if (space.isOwner) section.append(button('Export invitation', async () => { const file = unwrap(await host.exportInvitation({ spaceId: space.spaceId })); if (file) showNotice(`Invitation exported: ${file.displayName}`); }));
  if (!space.isOwner) section.append(button('Export enrollment', async () => { const file = unwrap(await host.exportEnrollment({ spaceId: space.spaceId })); if (file) showNotice(`Enrollment exported: ${file.displayName}`); }));
  panel.append(section);
 }
}

async function renderPermissions(panel: HTMLElement, state: NonNullable<typeof currentState>, localMemberId: string): Promise<void> {
 panel.append(el('h2', 'Permissions'), el('p', 'Space membership, this device’s approvals, and document permissions are separate. New imports are private to this device until you explicitly allow a person to use them.'));
 const space = selectedSpace ? selected(selectedSpace) : undefined; if (!space) { panel.append(el('p', 'Create or pair a space first.')); return; }
 const administration = unwrap(await app.getSpaceAdministration({ spaceId: space.spaceId }));
 if (administration.scope === 'owner') {
  panel.append(el('h3', 'Owner directory'));
  for (const member of administration.members) {
   const caps = capsInput(member.capabilities), expiry = expiryInput(member.validUntilMs); const active = document.createElement('input'); active.type = 'checkbox'; active.checked = member.active;
   const row = el('div', '', 'source'); row.append(el('p', member.memberId), caps.node, expiry.node); const activeLabel = el('label', 'Active', 'inline-check'); activeLabel.prepend(active); row.append(activeLabel, button('Save shared membership', async () => { unwrap(await app.setMember({ spaceId: space.spaceId, memberId: member.memberId, active: active.checked, capabilities: caps.value(), validUntilMs: expiry.value(), expectedRevision: space.policyRevision })); await render(); }));
   for (const device of member.devices) if (device.publicKey !== space.authorityKey) row.append(el('code', `${device.publicKey} · ${device.revoked ? 'revoked' : 'linked'}`), button('Revoke linked device', async () => { unwrap(await app.revokeDevice({ spaceId: space.spaceId, publicKey: device.publicKey, expectedRevision: space.policyRevision })); await render(); }));
   panel.append(row);
  }
  if (administration.members.length > 1) {
   panel.append(el('h3', 'Allowed member relationship'));
   const memberOptions = administration.members.map(member => member.memberId);
   const source = document.createElement('select'); source.setAttribute('aria-label', 'Relationship source member'); const target = document.createElement('select'); target.setAttribute('aria-label', 'Relationship target member');
   for (const memberId of memberOptions) { const a = document.createElement('option'); a.value = memberId; a.textContent = memberId; source.append(a); const b = a.cloneNode(true) as HTMLOptionElement; target.append(b); }
   source.value = localMemberId; target.value = memberOptions.find(memberId => memberId !== localMemberId) ?? memberOptions[0] ?? '';
   const controls = el('div', '', 'source'); const refreshRelationship = () => { const current = administration.relationships.find(item => item.memberId === source.value && item.otherMemberId === target.value); const allowed = document.createElement('input'); allowed.type = 'checkbox'; allowed.checked = current?.allowed ?? false; allowed.setAttribute('aria-label', 'Relationship allowed'); const expiry = expiryInput(current?.validUntilMs ?? null); controls.replaceChildren(el('p', current ? 'This relationship is configured.' : 'These members are not yet allowed to work together.'), allowed, expiry.node, button('Save relationship', async () => { if (source.value === target.value) throw new Error('Choose two different members.'); unwrap(await app.setRelationship({ spaceId: space.spaceId, memberId: source.value, otherMemberId: target.value, allowed: allowed.checked, validUntilMs: expiry.value(), expectedRevision: space.policyRevision })); await render(); })); };
   source.onchange = refreshRelationship; target.onchange = refreshRelationship; panel.append(source, target, controls); refreshRelationship();
  }
 } else panel.append(el('p', `Recipient projection: ${administration.members.length} authorized member records. Only the owner device can change shared membership.`));
 try {
  const local = unwrap(await app.getLocalGrants({ spaceId: space.spaceId })); panel.append(el('h3', 'Permissions approved on this device'));
  const sharedMembers = administration.members.map(member => ({ memberId: member.memberId, capabilities: member.capabilities }));
  const persistedGrants = new Map(local.grants.map(grant => [grant.memberId, grant]));
  const editableGrants = sharedMembers.map(member => ({ ...member, ...(persistedGrants.get(member.memberId) ?? { admitted: false, actions: [] as Capability[], validUntilMs: null }) }));
  for (const grant of editableGrants) { const caps = capsInput(grant.actions, `Local actions for ${grant.memberId}`, grant.capabilities), expiry = expiryInput(grant.validUntilMs); const admitted = document.createElement('input'); admitted.type = 'checkbox'; admitted.checked = grant.admitted; const row = el('div', '', 'source'); const admittedLabel = el('label', `Admit ${grant.memberId}`, 'inline-check'); admittedLabel.prepend(admitted); row.append(admittedLabel, caps.node, expiry.node, button('Save local grant', async () => { unwrap(await app.setLocalPolicy({ spaceId: space.spaceId, memberId: grant.memberId, admitted: admitted.checked, actions: caps.value(), validUntilMs: expiry.value(), expectedRevision: local.policyEpoch })); await render(); })); panel.append(row); }
  const ruleMembers = [...new Set([...local.grants.map(grant => grant.memberId), ...administration.members.map(member => member.memberId)])];
  for (const documentEntry of state.documents.filter(document => document.spaceId === space.spaceId)) {
   const rules = unwrap(await app.getDocumentRules({ spaceId: space.spaceId, documentId: documentEntry.documentId })); const section = el('div', '', 'source'); section.append(el('h3', `Document ${documentEntry.documentId}`), el('p', 'Choose exactly who may use this document and when that permission ends.'));
   const saveRules = async (updated: typeof rules.rules) => { unwrap(await app.setDocumentRules({ spaceId: space.spaceId, documentId: documentEntry.documentId, rules: updated, expectedRevision: rules.revision })); await render(); };
   rules.rules.forEach((rule, index) => { const member = document.createElement('select'); member.setAttribute('aria-label', `Document rule member ${index + 1}`); for (const memberId of ruleMembers) { const option = document.createElement('option'); option.value = memberId; option.textContent = memberId; member.append(option); } member.value = rule.memberId; const caps = capsInput(rule.actions, `Document rule actions ${index + 1}`), expiry = expiryInput(rule.validUntilMs); const row = el('div', '', 'source'); row.append(member, caps.node, expiry.node, button('Save document rule', async () => { const updated = rules.rules.map((current, currentIndex) => currentIndex === index ? { memberId: member.value, actions: caps.value(), validUntilMs: expiry.value() } : current); await saveRules(updated); }), button('Remove document rule', async () => { await saveRules(rules.rules.filter((_, currentIndex) => currentIndex !== index)); })); section.append(row); });
   if (rules.rules.length < 16 && ruleMembers.length) { const member = document.createElement('select'); member.setAttribute('aria-label', 'Add document rule member'); for (const memberId of ruleMembers) { const option = document.createElement('option'); option.value = memberId; option.textContent = memberId; member.append(option); } const caps = capsInput([], 'New document rule actions'), expiry = expiryInput(); section.append(el('h3', 'Add document rule'), member, caps.node, expiry.node, button('Add document rule', async () => { await saveRules([...rules.rules, { memberId: member.value, actions: caps.value(), validUntilMs: expiry.value() }]); })); }
   panel.append(section);
  }
 } catch (error) { showError(error); panel.append(el('p', 'Permissions on this device are unavailable. Check the shared-space membership and this device’s local approval, then refresh.', 'notice')); }
}

function showReview(review: ReviewView, panel: HTMLElement, token: number): void {
 if (!protectedCurrent(token, 'Reviews')) return;
 panel.replaceChildren(el('div', 'Review exact evidence before delivery', 'eyebrow'), el('h2', review.question), el('p', `Recipient: ${review.recipientKey}`), el('p', `Coverage: ${review.coverage} · Expires: ${new Date(review.expiresAtMs).toISOString()}`), el('p', `Review revision ${review.revision} · digest ${review.viewDigest}`, 'small'));
 const saved = reviewEdits.get(reviewKey(review));
 const selected = new Set(saved?.selectedSpanIds ?? review.selectedSpanIds);
 const allowSummary = document.createElement('input'); allowSummary.type = 'checkbox'; allowSummary.setAttribute('aria-label', 'Allow requester-local summary'); allowSummary.checked = saved?.allowLocalSummary ?? review.conditions.allowLocalSummary;
 const approval = button('Approve exact reviewed evidence', async () => {
  if (!protectedCurrent(token, 'Reviews')) return;
  try { unwrap(await app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest })); await render(); }
  catch (error) { if (protectedCurrent(token, 'Reviews')) { invalidateProtected(); closeProtected(panel, error); } }
 });
 const unsaved = el('p', 'Unsaved changes. Save the selection and conditions before approving.', 'helper hidden');
 const updateApproval = (): void => {
  const unchanged = selected.size === review.selectedSpanIds.length && !review.selectedSpanIds.some(id => !selected.has(id)) && allowSummary.checked === review.conditions.allowLocalSummary;
  approval.disabled = !unchanged;
  unsaved.className = unchanged ? 'helper hidden' : 'helper';
 };
 const persistEdits = () => reviewEdits.set(reviewKey(review), { selectedSpanIds: [...selected], allowLocalSummary: allowSummary.checked });
 const markChanged = () => { persistEdits(); unsaved.className = 'helper'; approval.disabled = true; };
 for (const passage of review.passages) {
  const label = el('label', '', 'source'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(passage.ref.spanId);
  checkbox.onchange = () => { if (checkbox.checked) selected.add(passage.ref.spanId); else selected.delete(passage.ref.spanId); markChanged(); };
  label.append(checkbox, el('blockquote', passage.text, 'quote'), el('code', JSON.stringify(passage.ref))); panel.append(label);
 }
 const conditionsLabel = el('label', 'Processing conditions', 'source');
 allowSummary.onchange = markChanged;
 conditionsLabel.append(allowSummary, el('span', 'Permit the requester to make a local summary from this approved evidence.'));
 const conditions = el('p', `Conditions: ${JSON.stringify({ ...review.conditions, allowLocalSummary: allowSummary.checked })}`, 'review-summary');
 panel.append(conditionsLabel, conditions);
 panel.append(button('Save passage selection and conditions', async () => {
  if (!protectedCurrent(token, 'Reviews')) return;
  persistEdits();
  try {
   const updated = unwrap(await app.reviseDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest, selectedSpanIds: [...selected], conditions: { ...review.conditions, allowLocalSummary: allowSummary.checked } }));
   reviewEdits.delete(reviewKey(review));
   if (protectedCurrent(token, 'Reviews')) showReview(updated, panel, token);
  } catch (error) { if (protectedCurrent(token, 'Reviews')) { invalidateProtected(); closeProtected(panel, error); } }
 }));
 panel.append(unsaved, approval);
 updateApproval();
}

let protectedValidationPending = false;
const unsubscribe = app.subscribe(refreshAfterCommit);
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
const setupTimer = setInterval(() => {
 // This read has no document/evidence content. Do not repaint a typed setup form.
 void host.getSetup({}).then(unwrap).then(setup => {
  const changed = JSON.stringify(setup) !== JSON.stringify(latestSetup); latestSetup = setup;
  if (changed && (page === 'Models' || (page === 'Setup' && !setupDirty))) void render().catch(showError);
 }).catch(showError);
}, 5000);
window.addEventListener('beforeunload', () => { unsubscribe(); clearInterval(timer); clearInterval(setupTimer); });
void render().catch(showError);
