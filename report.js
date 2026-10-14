import {loadExperiment} from './lib/experiment.js';
import {loadReportData} from './lib/repo.js';
import {buildReport,formatReport} from './lib/reporting.js';
import {loadRunCheckpoint} from './lib/store.js';
import {closePool} from './lib/db.js';
try{
 const args=process.argv.slice(2);let dataDir='./data',json=false;
 for(let i=0;i<args.length;i++){if(args[i]==='--json')json=true;else if(args[i]==='--data-dir'&&args[i+1])dataDir=args[++i];else throw new Error(`Unknown option ${args[i]}`);}
 const experiment=await loadExperiment(),data=await loadReportData(),localCheckpoints=[];
 for(const run of data.runs.filter(r=>r.engine_version===1&&r.dataset==='prospective')){const {local}=await loadRunCheckpoint(run.account_id,run.host_label,experiment,dataDir,run);if(local)localCheckpoints.push(local);}
 const report=buildReport(data,experiment,{localCheckpoints});console.log(json?JSON.stringify(report,null,2):formatReport(report));
}catch(e){console.error(e.message);process.exitCode=1;}finally{await closePool();}
