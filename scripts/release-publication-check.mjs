import { assertVersion } from './release-validate.mjs';

const version = process.env.RELEASE_VERSION;
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
assertVersion(version);
if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
if (response.status === 404) process.exit(0);
if (response.ok) throw new Error(`Release v${version} already exists`);
throw new Error(`Cannot check existing release: ${response.status}`);
