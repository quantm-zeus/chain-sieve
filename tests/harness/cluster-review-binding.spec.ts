import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClusterResultSchema, type ClusterContract } from '@ciag/shared-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../tools/prd-compiler/compiler.js';
import { runtimeRoot } from '../../tools/task-runner/state.js';
import { validateClusterReview } from '../../tools/cluster-verifier/verification.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const git = (root: string, args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const put = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

const setup = async (change: Record<string, unknown> = {}, extraReviewFile = false) => {
  const root = await mkdtemp(join(tmpdir(), 'cluster-review-binding-'));
  roots.push(root);
  git(root, ['init', '-b', 'cluster/g0']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  git(root, ['config', 'user.name', 'Independent Review']);
  await put(root, 'product.txt', 'verified product\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feat: frozen product']);
  const productCommit = git(root, ['rev-parse', 'HEAD']);
  const productTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const cluster = { id: 'C-G0-IMPLEMENTATION', group: 'G0' } as ClusterContract;
  const result = ClusterResultSchema.parse({
    schemaVersion: '2.0.0', clusterId: cluster.id, status: 'PASS',
    clusterContractSha256: 'a'.repeat(64), headCommitSha: productCommit, headTreeSha: productTree,
    taskAttestations: [{ taskId: 'T-G0-CORE', taskCommitSha: productCommit, taskTreeSha: productTree, resultSha256: 'b'.repeat(64) }],
    commandEvidence: [{ command: 'pnpm test', exitCode: 0, outputSha256: 'c'.repeat(64), artifactPath: 'evidence.log', artifactSha256: 'c'.repeat(64) }],
    verifierVersion: 'cluster-2.0.0', verificationPolicyVersion: 'cluster-policy', verificationTimestamp: '2026-07-31T00:00:00.000Z',
  });
  const resultText = `${JSON.stringify(result, null, 2)}\n`;
  await put(runtimeRoot(root), `cluster-results/${cluster.id}.result.json`, resultText);
  const review = {
    schemaVersion: '2.0.0', clusterId: cluster.id, reviewerIdentity: 'independent-session-42',
    reviewedProductCommit: productCommit, reviewedProductTree: productTree,
    clusterContractSha256: result.clusterContractSha256,
    clusterResultPath: `cluster-results/${cluster.id}.result.json`, clusterResultSha256: sha256(resultText),
    taskAttestationHashes: [{ taskId: 'T-G0-CORE', resultSha256: 'b'.repeat(64) }],
    reviewedAt: '2026-07-31T00:01:00.000Z',
    reviewPasses: [{ name: 'independent-review', status: 'PASS', evidence: ['commit/tree/result/task attestations checked'] }],
    findings: [], verdict: 'PASS', ...change,
  };
  const reviewPath = `artifacts/reviews/clusters/${cluster.id}.review.json`;
  await put(root, reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  if (extraReviewFile) await put(root, 'product-tamper.txt', 'not metadata only\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'review: bind independent result']);
  return { root, cluster, result, review };
};

describe('cluster independent-review binding', () => {
  it('accepts a metadata-only review commit whose parent is the frozen product', async () => {
    const value = await setup();
    await expect(validateClusterReview(value.cluster, value.result, value.review, value.root)).resolves.toMatchObject({ verdict: 'PASS' });
  });

  it.each([
    ['reviewedProductCommit', '1'.repeat(40), 'CLUSTER_REVIEW_WRONG_PRODUCT_COMMIT'],
    ['reviewedProductTree', '2'.repeat(40), 'CLUSTER_REVIEW_WRONG_PRODUCT_TREE'],
    ['clusterResultSha256', '3'.repeat(64), 'CLUSTER_REVIEW_WRONG_RESULT_HASH'],
    ['reviewedAt', '2026-07-30T00:00:00.000Z', 'CLUSTER_REVIEW_PREDATES_RESULT'],
  ])('rejects stale or mismatched %s', async (field, value, error) => {
    const fixture = await setup({ [field]: value });
    await expect(validateClusterReview(fixture.cluster, fixture.result, fixture.review, fixture.root)).rejects.toThrow(error);
  });

  it('rejects unresolved P1 findings and non-review changes', async () => {
    const finding = await setup({ findings: [{ severity: 'P1', text: 'release blocker', resolved: false }] });
    await expect(validateClusterReview(finding.cluster, finding.result, finding.review, finding.root)).rejects.toThrow('CLUSTER_INDEPENDENT_REVIEW_REQUIRED');
    const tamper = await setup({}, true);
    await expect(validateClusterReview(tamper.cluster, tamper.result, tamper.review, tamper.root)).rejects.toThrow('CLUSTER_REVIEW_COMMIT_NOT_ARTIFACT_ONLY');
  });

  it('rejects an implementation identity posing as the independent reviewer', async () => {
    const value = await setup();
    await expect(
      validateClusterReview(
        value.cluster,
        value.result,
        value.review,
        value.root,
        ['independent-session-42'],
      ),
    ).rejects.toThrow('CLUSTER_REVIEWER_NOT_INDEPENDENT');
  });
});
