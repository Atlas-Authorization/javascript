import { CONFORMANCE_CASES, WEBHOOK_CONFORMANCE_CASES } from './cases';
import { materialize, type RecordedCall } from './requests';

/**
 * The recording: every case as the exact signed request, at a fixed time with
 * a fixed secret, so the bytes never change. A platform under test pins its
 * clock to {@link RECORDING.nowMs} and uses {@link RECORDING.secret} for the
 * connection {@link RECORDING.connectionId}; then it can replay these without
 * Atlas.
 */
export const RECORDING = {
  nowMs: Date.parse('2026-10-21T14:03:11Z'),
  connectionId: 'conn_conformance',
  secret: 'conformance_secret_0123456789abcdef',
  baseUrl: 'https://referalli.example.test',
  runId: 'rec',
} as const;

/** Every case as a fixed signed call. */
export const RECORDED_CALLS: readonly (RecordedCall & { expect: { status: number[] } })[] = CONFORMANCE_CASES.map((c) => ({
  ...materialize(c, {
    baseUrl: RECORDING.baseUrl,
    connectionId: RECORDING.connectionId,
    secret: RECORDING.secret,
    now: RECORDING.nowMs,
    runId: RECORDING.runId,
  }),
  expect: { status: c.expect.status },
}));

/** The generic webhook protocol, recorded the same way (timestamps in ms, as Atlas sends them). */
export const WEBHOOK_RECORDED_CALLS: readonly (RecordedCall & { expect: { status: number[] } })[] = WEBHOOK_CONFORMANCE_CASES.map((c) => ({
  ...materialize(c, {
    baseUrl: RECORDING.baseUrl,
    connectionId: RECORDING.connectionId,
    secret: RECORDING.secret,
    now: RECORDING.nowMs,
    runId: RECORDING.runId,
  }),
  expect: { status: c.expect.status },
}));
