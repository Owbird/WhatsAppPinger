import {resolveOutcome} from '../lib/repo.js';
import {loadExperiment} from '../lib/experiment.js';
import {closePool} from '../lib/db.js';
const args=process.argv.slice(2);const get=f=>args.includes(f)?args[args.indexOf(f)+1]:null;
try{
 const accountId=get('--account'),outcome=get('--status'),reasonCode=get('--reason');
 if(!accountId||!outcome||!reasonCode)throw new Error('Use --account ID --status confirmed_restricted|false_alarm|indeterminate|technical_failure --reason NON_IDENTIFYING_CODE');
 console.log(JSON.stringify(await resolveOutcome(accountId,outcome,reasonCode,await loadExperiment())));
}catch(e){console.error(e.message);process.exitCode=1;}finally{await closePool();}
