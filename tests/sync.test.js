import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Synchronizer} from '../lib/sync.js';
import {fixture,subject} from './helpers.js';
test('database failures remain visible and a failed final flush cannot report success',async()=>{
 const e=await fixture(),logs=[],status=[];const s=new Synchronizer({experiment:e,push:async()=>{throw new Error('db unavailable');},markFailure:async()=>{},log:m=>logs.push(m),onStatus:async value=>status.push(value)});
 assert.equal(await s.flush(subject(e)),false);assert.equal(s.status.status,'error');assert.equal(s.status.lastSyncedRevision,null);assert.equal(s.status.errors.length,1);assert.ok(logs.length);
});
test('serialized database synchronization passes optimistic revisions and recovers without losing failure history',async()=>{
 const e=await fixture(),revisions=[];let fail=true;
 const sync=new Synchronizer({experiment:e,push:async(s,_e,o)=>{revisions.push(o.expectedRevision);if(fail){fail=false;throw new Error('down');}},markFailure:async()=>{}});
 const state=subject(e);assert.equal(await sync.flush(state),false);assert.equal(await sync.flush(state),true);assert.equal(sync.status.errors.length,1);state.revision++;
 assert.equal(await sync.flush(state),true);assert.deepEqual(revisions,[null,null,0]);
});
