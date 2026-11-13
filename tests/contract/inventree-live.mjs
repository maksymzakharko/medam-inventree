/** Runs only mounted into a disposable CI app-cli container, using the real compiled adapter. */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from './dist/config.js';
import { InventreeClient } from './dist/integrations/inventree/client.js';
import { verifyEvidence } from './dist/modules/consumption/operations.js';

const config = loadConfig();
assert.equal(process.env.CI, 'true');
assert.equal(process.env.MEDAM_CONTRACT_TEST, 'ci-only-ephemeral');
assert.equal(config.nodeEnv, 'development');
assert.equal(config.appOrigin, 'http://localhost:8080');
const fixture = JSON.parse(await readFile('/app/contract-fixture.json', 'utf8'));
for (const key of ['partId', 'sourceId', 'destinationId']) assert(Number.isSafeInteger(fixture[key]) && fixture[key] > 0);
const inventory = new InventreeClient({ baseUrl: config.inventreeUrl, token: config.inventreeToken,
  timeoutMs: config.inventreeTimeoutMs, expectedVersion: config.inventreeExpectedVersion,
  expectedApiVersion: config.inventreeExpectedApiVersion });
const ctx = { config, inventory, db: null }; // Evidence verification itself performs only upstream reads.
await inventory.checkVersion();
const lot = `CI-${randomUUID()}`;
const exp = `${new Date().getUTCFullYear() + 2}-12-31`;
function row(kind, quantity, snapshot, extra = {}) {
  return { id: randomUUID(), kind, created_at: new Date(), request: { quantity, _snapshot: snapshot, ...extra } };
}
async function proof(operation, action, expectedState, expectedQuantity) {
  await action();
  const entries = await inventory.auditForOperation(operation.id, operation.request.stockItemId, operation.created_at.toISOString());
  const actual = await verifyEvidence(ctx, operation, entries);
  if (actual.state !== expectedState || actual.appliedQuantity !== expectedQuantity) {
    console.error(JSON.stringify({ kind: operation.kind, actual, audit: entries.map(e => ({ id:e.pk, type:e.event_type, object:e.object_pk, deltas:e.deltas, cid:e.cid })) }));
  }
  assert.equal(actual.state, expectedState, `Real ${operation.kind} audit proof`);
  assert.equal(actual.appliedQuantity, expectedQuantity);
  console.log(`PASS ${operation.kind}: ${actual.state}, actual quantity ${actual.appliedQuantity}`);
  return actual;
}
let created;
const receipt = row('receipt', '5', { id:0, partId:fixture.partId, locationId:fixture.sourceId,
  quantity:'0', lot, exp, name:'MEDAM disposable contract fixture' });
await proof(receipt, async () => {
  const items = await inventory.createStock(receipt.id, { part:fixture.partId,location:fixture.sourceId,quantity:'5',batch:lot,expiry_date:exp });
  assert.equal(items.length,1); created=items[0];
}, 'SUCCEEDED', '5');
function snapshot(stock) { return { id:stock.pk,partId:stock.part,locationId:stock.location,quantity:stock.quantity,lot:stock.batch,exp:stock.expiry_date,name:'MEDAM disposable contract fixture' }; }
let stock = await inventory.getStock(created.pk);
let operation = row('consumption','2',snapshot(stock),{stockItemId:stock.pk});
await proof(operation,()=>inventory.adjustStock('remove',operation.id,stock.pk,'2'),'SUCCEEDED','2');
stock = await inventory.getStock(stock.pk);
operation = row('transfer','1',{...snapshot(stock),destinationId:fixture.destinationId},{stockItemId:stock.pk});
await proof(operation,()=>inventory.adjustStock('transfer',operation.id,stock.pk,'1',fixture.destinationId),'SUCCEEDED','1');
stock = await inventory.getStock(stock.pk);
operation = row('adjustment','1',snapshot(stock),{stockItemId:stock.pk,direction:'increase'});
await proof(operation,()=>inventory.adjustStock('add',operation.id,stock.pk,'1'),'SUCCEEDED','1');
stock = await inventory.getStock(stock.pk);
operation = row('transfer','3',{...snapshot(stock),destinationId:fixture.destinationId},{stockItemId:stock.pk});
await proof(operation,()=>inventory.adjustStock('transfer',operation.id,stock.pk,'3',fixture.destinationId),'SUCCEEDED','3');
stock = await inventory.getStock(stock.pk);
operation = row('consumption','20',snapshot(stock),{stockItemId:stock.pk});
await proof(operation,()=>inventory.adjustStock('remove',operation.id,stock.pk,'20'),'DISCREPANCY','3');
assert.equal((await inventory.getStock(stock.pk)).quantity,'0');
console.log('Real InvenTree contract passed: receipt/cid, remove, split transfer, add, full transfer, clamp and retained depleted item.');
