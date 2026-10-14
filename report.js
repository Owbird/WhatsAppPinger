import {loadExperiment} from './lib/experiment.js';
import {loadReportData} from './lib/repo.js';
import {buildReport,formatReport} from './lib/reporting.js';
import {loadCheckpoint,checkpointPath} from './lib/store.js';
import {closePool} from './lib/db.js';
try{
 const args=process.argv.slice(2);let dataDir='./data',json=false;
 for(let i=0;i<args.length;i++){if(args[i]==='--json')json=true;else if(args[i]==='--data-dir'&&args[i+1])dataDir=args[++i];else throw new Error(`Unknown option ${args[i]}`);}
 const experiment=await loadExperiment(),data=await loadReportData(),localCheckpoints=[];
 for(const a of data.accounts){const local=await loadCheckpoint(checkpointPath(a.id,dataDir),experiment,{accountId:a.id,host:a.host_label});if(local)localCheckpoints.push(local);}
 const report=buildReport(data,experiment,{localCheckpoints});console.log(json?JSON.stringify(report,null,2):formatReport(report));
}catch(e){console.error(e.message);process.exitCode=1;}finally{await closePool();}
