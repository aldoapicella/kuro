import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAppPort, demoId } from '../src/fake-app.js';
import { value } from '../src/composition/simulated.js';
test('approval requires reviewed revision and evidence survives model failure', async () => {
 const fake = new FakeAppPort();
 const review = value(await fake.app.listReviews({ spaceId: demoId(1) }))[0]!;
 assert.equal((await fake.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision + 1, reviewedViewDigest: review.viewDigest })).ok, false);
 const approved = value(await fake.app.approveDraft({ draftId: review.draftId, expectedRevision: review.revision, reviewedViewDigest: review.viewDigest }));
 assert.ok(value(await fake.app.getEvidence(approved)).passages.length);
 fake.reset('model-unavailable');
 const responseId = demoId(8);
 assert.equal((await fake.app.requestLocalSummary({ responseId })).ok, false);
 assert.ok(value(await fake.app.getEvidence({ responseId })).passages.length);
 fake.close();
});
