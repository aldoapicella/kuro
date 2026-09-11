import { execFileSync } from 'node:child_process';
import { assertSourceSha } from './release-validate.mjs';

const sourceSha = process.env.RELEASE_SOURCE_SHA;
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
assertSourceSha(sourceSha);
if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');

execFileSync('git', ['merge-base', '--is-ancestor', sourceSha, 'origin/main'], { stdio: 'inherit' });
const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${sourceSha}&status=completed&per_page=100`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
if (!response.ok) throw new Error(`Cannot read GitHub workflow runs: ${response.status}`);
const { workflow_runs: runs } = await response.json();
const passed = runs.some(run => run.path === '.github/workflows/core-transport.yml' && run.event === 'push' && run.head_sha === sourceSha && run.conclusion === 'success');
if (!passed) throw new Error(`No successful push run of core-transport.yml exists for ${sourceSha}; both hosted matrix jobs must pass before release`);
console.log(`Validated ${sourceSha} on main with a successful core-transport workflow.`);
