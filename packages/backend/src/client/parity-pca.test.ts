import { describe, expect, it } from 'vitest';
import { createAtlasClient } from './index';

// [namespace path, method, HTTP method, expected path, arguments]: every /v1/pca/* operation of the Backend API.
const TABLE: Array<[string, string, string, string, unknown[]]> = [
  ['grants', 'list', 'GET', '/v1/pca/grants', [{}]],
  ['grants', 'get', 'GET', '/v1/pca/grants/p1', ['p1']],
  ['grants', 'revoke', 'DELETE', '/v1/pca/grants/p1', ['p1']],
  ['grants', 'setAuthority', 'PUT', '/v1/pca/grants/p1/authority', ['p1', {}]],
  ['grants', 'createStepUp', 'POST', '/v1/pca/grants/p1/step-up', ['p1']],
  ['grants', 'approveStepUp', 'POST', '/v1/pca/grants/p1/step-up/p2/approve', ['p1', 'p2', {}]],
  ['grants', 'amend', 'POST', '/v1/pca/grants/p1/amend', ['p1', {}]],
  ['grants', 'createNeeds', 'POST', '/v1/pca/grants/p1/needs', ['p1', {}]],
  ['grants', 'listNeeds', 'GET', '/v1/pca/grants/p1/needs', ['p1', {}]],
  ['needs', 'approve', 'POST', '/v1/pca/needs/p1/approve', ['p1', {}]],
  ['needs', 'deny', 'POST', '/v1/pca/needs/p1/deny', ['p1']],
  ['bondAccounts', 'create', 'POST', '/v1/pca/bond-accounts', [{}]],
  ['bondAccounts', 'get', 'GET', '/v1/pca/bond-accounts', [{ account: 'a' }]],
  ['undo', 'createRecord', 'POST', '/v1/pca/undo/records', [{}]],
  ['undo', 'getRecord', 'GET', '/v1/pca/undo/records/p1', ['p1']],
  ['undo', 'updateRecord', 'PUT', '/v1/pca/undo/records/p1', ['p1', {}]],
  ['undo', 'listVetoes', 'GET', '/v1/pca/undo/vetoes', [{}]],
  ['', 'createWorkflowReceipt', 'POST', '/v1/pca/workflow-receipts', [{}]],
  ['', 'createConstitution', 'POST', '/v1/pca/constitutions', [{}]],
  ['principals', 'create', 'POST', '/v1/pca/principals', [{}]],
  ['principals', 'list', 'GET', '/v1/pca/principals', [{}]],
  ['principals', 'delete', 'DELETE', '/v1/pca/principals/p1', ['p1']],
  ['', 'rotateGuardian', 'POST', '/v1/pca/guardian/rotate', []],
  ['', 'createBeacon', 'POST', '/v1/pca/beacons', [{}]],
  ['', 'deletePqPin', 'DELETE', '/v1/pca/pq-pins/p1', ['p1']],
  ['intent', 'listMapObservations', 'GET', '/v1/pca/intent/maps/p1/observations', ['p1', {}]],
  ['intent', 'createSchema', 'POST', '/v1/pca/intent/schemas', [{}]],
  ['approvers', 'createEnrolment', 'POST', '/v1/pca/approvers/enrolments', [{}]],
  ['approvers', 'list', 'GET', '/v1/pca/approvers', [{}]],
  ['approvers', 'get', 'GET', '/v1/pca/approvers/p1', ['p1']],
  ['approvers', 'update', 'PATCH', '/v1/pca/approvers/p1', ['p1', {}]],
  ['approvers', 'updateMember', 'PATCH', '/v1/pca/approvers/p1/members/p2', ['p1', 'p2', {}]],
  ['approvers', 'deleteCredential', 'DELETE', '/v1/pca/approvers/p1/credentials/p2', ['p1', 'p2']],
  ['approvals', 'getSettings', 'GET', '/v1/pca/approvals/settings', []],
  ['approvals', 'setSettings', 'PUT', '/v1/pca/approvals/settings', [{}]],
  ['actionRegistry', 'get', 'GET', '/v1/pca/action-registry', []],
  ['actionRegistry', 'createPublisherKey', 'POST', '/v1/pca/action-registry/publisher-keys', [{}]],
  ['actionRegistry', 'deletePublisherKey', 'DELETE', '/v1/pca/action-registry/publisher-keys/p1', ['p1']],
  ['actionRegistry', 'publishPack', 'POST', '/v1/pca/action-registry/packs', [{}]],
  ['actionRegistry', 'listVersions', 'GET', '/v1/pca/action-registry/namespaces/p1/versions', ['p1', {}]],
  ['actionRegistry', 'getVersion', 'GET', '/v1/pca/action-registry/namespaces/p1/versions/p2', ['p1', 'p2']],
  ['actionRegistry', 'diff', 'GET', '/v1/pca/action-registry/namespaces/p1/diff', ['p1', { from: 'a', to: 'b' }]],
  ['actionRegistry', 'pin', 'PUT', '/v1/pca/action-registry/namespaces/p1/pin', ['p1', {}]],
  ['actionRegistry', 'unpin', 'DELETE', '/v1/pca/action-registry/namespaces/p1/pin', ['p1']],
  ['actionRegistry', 'listActions', 'GET', '/v1/pca/action-registry/actions', [{}]],
  ['actionRegistry', 'getAction', 'GET', '/v1/pca/action-registry/actions/p1', ['p1']],
  ['actionRegistry', 'import', 'POST', '/v1/pca/action-registry/imports', [{}]],
  ['actionRegistry', 'listDrafts', 'GET', '/v1/pca/action-registry/drafts', [{}]],
  ['actionRegistry', 'getDraft', 'GET', '/v1/pca/action-registry/drafts/p1', ['p1']],
  ['actionRegistry', 'updateDraft', 'PATCH', '/v1/pca/action-registry/drafts/p1', ['p1', {}]],
  ['actionRegistry', 'deleteDraft', 'DELETE', '/v1/pca/action-registry/drafts/p1', ['p1']],
  ['actionRegistry', 'reviewAction', 'POST', '/v1/pca/action-registry/actions/p1/review', ['p1']],
  ['actionRegistry', 'confirmDraft', 'POST', '/v1/pca/action-registry/drafts/p1/confirm', ['p1', {}]],
  ['actionRegistry', 'publish', 'POST', '/v1/pca/action-registry/publish', [{}]],
  ['actionRegistry', 'createReviewerEnrolment', 'POST', '/v1/pca/action-registry/reviewers/enrolments', [{}]],
  ['actionRegistry', 'listReviewers', 'GET', '/v1/pca/action-registry/reviewers', [{}]],
  ['actionRegistry', 'deleteReviewer', 'DELETE', '/v1/pca/action-registry/reviewers/p1', ['p1']],
  ['actionRegistry', 'listSources', 'GET', '/v1/pca/action-registry/sources', [{}]],
  ['actionRegistry', 'createSource', 'POST', '/v1/pca/action-registry/sources', [{}]],
  ['actionRegistry', 'updateSource', 'PATCH', '/v1/pca/action-registry/sources/p1', ['p1', {}]],
  ['actionRegistry', 'deleteSource', 'DELETE', '/v1/pca/action-registry/sources/p1', ['p1']],
  ['actionRegistry', 'syncSource', 'POST', '/v1/pca/action-registry/sources/p1/sync', ['p1']],
  ['actionRegistry', 'listTemplates', 'GET', '/v1/pca/action-registry/templates', [{}]],
  ['actionRegistry', 'applyTemplate', 'POST', '/v1/pca/action-registry/templates/p1/apply', ['p1', {}]],
];

describe('atlas.pca operations', () => {
  it.each(TABLE)('%s.%s -> %s %s', async (ns, method, httpMethod, path, args) => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const atlas = createAtlasClient({ secretKey: 'sk_test_placeholder_not_a_real_key', apiUrl: 'https://api.example.test', fetch: fetchImpl });
    const target = (ns ? (atlas.pca as any)[ns] : atlas.pca) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await target[method]!(...args);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(httpMethod);
    expect(new URL(calls[0]!.url).pathname).toBe(path);
  });
});
