import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historicalRecord} from '../lib/historical.js';
test('historical import preserves source identity, timestamps and missing values while dropping private detail',()=>{
 const bytes=Buffer.from(JSON.stringify({rq1:{tierStatus:{T0:'complete'},tierProgress:{T2:7}},candidate:'PRIVATE_CANDIDATE',registered:true,events:[{tier:'T2',phase:'run',index:7,signal:'error',timestamp:'2026-01-01T01:00:00+01:00',detail:'PRIVATE_AUTH_DETAIL'}]}));
 const r=historicalRecord(bytes);assert.equal(r.sourceHash,historicalRecord(bytes).sourceHash);assert.equal(r.dataset,'historical');
 assert.equal(r.observations.events[0].timestamp,'2026-01-01T00:00:00.000Z');assert.equal(r.observations.cumulativeOperations,null);assert.equal(r.observations.tiers.T1.latency,null);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|registered|candidate|detail/);
});
