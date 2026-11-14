import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normStoreDetail } from './lib/models.mjs';

test('store detail marks a store with a closed message as not open and carries its opening time', () => {
  const closed = normStoreDetail({
    uuid: 'f1e2d3c4-0000-0000-0000-000000000000',
    title: 'Master Poulet',
    isOpen: true,
    isOrderable: true,
    closedMessage: 'Opens at 11:00 AM',
    orderForLaterInfo: { nextOpenTime: '2026-11-14T10:00:00.000Z' },
    scheduledOrderInfo: { isSchedulable: true },
  });
  assert.equal(closed.open, false);
  assert.equal(closed.closedNote, 'Opens at 11:00 AM');
  assert.equal(closed.opensAt, '2026-11-14T10:00:00.000Z');
  assert.equal(closed.schedulable, true);
});

test('store detail of an open store has no closed note', () => {
  const open = normStoreDetail({
    uuid: 'f1e2d3c4-0000-0000-0000-000000000001',
    title: 'Open Place',
    isOpen: true,
    isOrderable: true,
    scheduledOrderInfo: { isSchedulable: true },
  });
  assert.equal(open.open, true);
  assert.equal('closedNote' in open, false);
  assert.equal('opensAt' in open, false);
});
