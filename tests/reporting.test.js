import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReport,formatReport} from '../lib/reporting.js';
import {fixture,subject} from './helpers.js';
const blank={runs:[],progress:[],events:[],network:[],historical:[],archivedCheckpoints:[]};
test('one report compares three independent accounts and keeps missing values distinct from zero',async()=>{
 const e=await fixture();const accounts=['vps1','vps2','local'].map((host,i)=>({id:`A0${i+1}`,host_label:host,status:'enrolled',environment:{hostname:'buffalo'},t4_enabled:false}));
 const s=subject(e,{dataset:'prospective'});const report=buildReport({...blank,accounts,runs:[{id:'1',account_id:'A01',engine_version:1,dataset:'prospective',sync_revision:0,sync_status:'synced'}],progress:[{run_id:'1',state:s}]},e);
 assert.equal(report.experiment.enrolledAccounts,3);assert.equal(report.experiment.startedRuns,1);assert.equal(report.accounts[0].successfulOperations,0);assert.equal(report.accounts[1].successfulOperations,null);
 assert.equal(report.accounts[0].synchronization.status,'local_copy_not_checked');assert.equal(report.accounts[1].enrollmentEnvironment.hostname,'buffalo');assert.match(formatReport(report),/A01.*vps1/);
});
test('report separates historical records and simulation while exposing checkpoint disagreement',async()=>{
 const e=await fixture(),s=subject(e,{dataset:'prospective'});const accounts=[{id:'A01',host_label:'vps1',status:'running'}];
 const report=buildReport({...blank,accounts,runs:[{id:'1',account_id:'A01',engine_version:1,dataset:'prospective'},{id:'2',engine_version:null,dataset:'historical'},{id:'3',engine_version:1,dataset:'simulation'}],progress:[{run_id:'1',state:s}],historical:[{source_hash:'synthetic'}]},e,{localCheckpoints:[{state:{...s,revision:1},sync:{status:'error',errors:[{timestamp:'2026-01-01T00:00:00Z'}]}}]});
 assert.equal(report.historical.runs.length,1);assert.equal(report.simulations.length,1);assert.equal(report.experiment.startedRuns,1);assert.equal(report.accounts[0].synchronization.status,'conflicting_copies');
});
