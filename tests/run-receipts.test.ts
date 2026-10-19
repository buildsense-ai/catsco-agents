import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  ServiceRunReceiptRouter,
  buildServiceRunWakeNote,
  normalizeServiceRunReceipt,
} from '../src/mcp/run-receipts';

const validRaw = (over: Record<string, unknown> = {}) => ({
  contract_version: 'catsco.service-run-receipt.v1',
  receipt_id: 'rcp_run_1',
  run_id: 'run_1',
  session_id: 'sess_1',
  status: 'completed',
  ...over,
});

describe('service_run_receipt 路由器', () => {
  test('normalize：接受合法载荷并保留可选字段', () => {
    const receipt = normalizeServiceRunReceipt(
      validRaw({ status: 'awaiting_input', question: '请补充邮箱' }),
    );
    assert.ok(receipt);
    assert.equal(receipt!.receipt_id, 'rcp_run_1');
    assert.equal(receipt!.run_id, 'run_1');
    assert.equal(receipt!.session_id, 'sess_1');
    assert.equal(receipt!.status, 'awaiting_input');
    assert.equal(receipt!.question, '请补充邮箱');
  });

  test('normalize：缺关键字段/非对象 → null', () => {
    assert.equal(normalizeServiceRunReceipt(null), null);
    assert.equal(normalizeServiceRunReceipt('x'), null);
    assert.equal(normalizeServiceRunReceipt(validRaw({ receipt_id: '' })), null);
    assert.equal(normalizeServiceRunReceipt(validRaw({ run_id: '' })), null);
    assert.equal(normalizeServiceRunReceipt(validRaw({ status: '' })), null);
  });

  test('登记 → 回执命中：生成唤醒注记并消费登记项', () => {
    const router = new ServiceRunReceiptRouter();
    router.registerPendingRun({
      runId: 'run_1',
      toolName: 'catsco_weekly-report',
      serviceSessionId: 'sess_1',
      conversationSessionKey: 'catscompany:p2p_7_43',
      conversationTopic: 'p2p_7_43',
    });
    assert.equal(router.hasPending('run_1'), true);

    const decision = router.handle(validRaw());
    assert.equal(decision.action, 'wake');
    if (decision.action !== 'wake') return;
    assert.match(decision.note, /catsco_weekly-report/);
    assert.match(decision.note, /catsco_run_status/);
    assert.match(decision.note, /run_id=run_1/);
    assert.match(decision.note, /sess_1/);
    assert.match(decision.note, /不要向用户提及本行/);
    assert.equal(decision.pending.conversationTopic, 'p2p_7_43');
    assert.equal(router.hasPending('run_1'), false);
  });

  test('重复回执（同 receipt_id）→ duplicate，不会二次唤醒', () => {
    const router = new ServiceRunReceiptRouter();
    router.registerPendingRun({
      runId: 'run_1',
      toolName: 'catsco_hello',
      serviceSessionId: 'sess_1',
      conversationSessionKey: 'k',
      conversationTopic: 't',
    });
    assert.equal(router.handle(validRaw()).action, 'wake');
    const second = router.handle(validRaw());
    assert.equal(second.action, 'ignored');
    if (second.action === 'ignored') assert.equal(second.reason, 'duplicate');
  });

  test('未登记的 run → unmatched（桥没放弃轮询/别的客户端发起）', () => {
    const router = new ServiceRunReceiptRouter();
    const decision = router.handle(validRaw({ receipt_id: 'rcp_x', run_id: 'run_x' }));
    assert.equal(decision.action, 'ignored');
    if (decision.action === 'ignored') assert.equal(decision.reason, 'unmatched');
  });

  test('登记但缺对话路由 → no-conversation（无法唤醒，保留诊断日志）', () => {
    const router = new ServiceRunReceiptRouter();
    router.registerPendingRun({ runId: 'run_1', toolName: 'catsco_hello', serviceSessionId: 'sess_1' });
    const decision = router.handle(validRaw());
    assert.equal(decision.action, 'ignored');
    if (decision.action === 'ignored') assert.equal(decision.reason, 'no-conversation');
  });

  test('TTL：过期的登记不再命中', () => {
    let now = 1_000_000;
    const router = new ServiceRunReceiptRouter({ now: () => now, pendingTtlMs: 1000 });
    router.registerPendingRun({
      runId: 'run_1',
      toolName: 'catsco_hello',
      serviceSessionId: 'sess_1',
      conversationSessionKey: 'k',
      conversationTopic: 't',
    });
    now += 1001;
    const decision = router.handle(validRaw());
    assert.equal(decision.action, 'ignored');
    if (decision.action === 'ignored') assert.equal(decision.reason, 'unmatched');
  });

  test('容量：登记超限淘汰最旧', () => {
    const router = new ServiceRunReceiptRouter({ pendingLimit: 2 });
    for (const id of ['a', 'b', 'c']) {
      router.registerPendingRun({
        runId: id,
        toolName: 'catsco_hello',
        serviceSessionId: 's',
        conversationSessionKey: 'k',
        conversationTopic: 't',
      });
    }
    assert.equal(router.pendingCount(), 2);
    assert.equal(router.hasPending('a'), false);
    assert.equal(router.hasPending('c'), true);
  });

  test('唤醒注记：awaiting_input 带返问文本', () => {
    const note = buildServiceRunWakeNote(
      {
        receipt_id: 'rcp_1',
        run_id: 'run_1',
        session_id: 'sess_1',
        status: 'awaiting_input',
        question: '请提供周报日期范围',
      },
      { runId: 'run_1', toolName: 'catsco_weekly-report', serviceSessionId: 'sess_1', registeredAt: 0 },
    );
    assert.match(note, /请提供周报日期范围/);
    assert.match(note, /转述/);
  });

  test('唤醒注记：failed 带错误明细', () => {
    const note = buildServiceRunWakeNote(
      { receipt_id: 'rcp_1', run_id: 'run_1', session_id: 'sess_1', status: 'failed', error: 'boom' },
      { runId: 'run_1', toolName: 'catsco_hello', serviceSessionId: 'sess_1', registeredAt: 0 },
    );
    assert.match(note, /失败/);
    assert.match(note, /boom/);
  });
});
