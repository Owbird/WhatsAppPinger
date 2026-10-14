import path from 'node:path';
import {inspectAccount} from '../lib/repo.js';
import {loadExperiment} from '../lib/experiment.js';
import {resolveHostLabel} from '../lib/config.js';
import {verifyIdentity,identityMetadataAvailable} from '../lib/identity.js';
import {closePool} from '../lib/db.js';
const args=process.argv.slice(2),get=f=>args.includes(f)?args[args.indexOf(f)+1]:null;
let client;
try{
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Authentication requires an interactive terminal; do not capture its output');
 const accountId=get('--account');if(!accountId)throw new Error('Use --account ID --host HOST [--data-dir DIR]');
 const host=resolveHostLabel(get('--host')),e=await loadExperiment();const {account}=await inspectAccount(accountId,host,e);
 if(account.status!=='enrolled'||account.lease_holder)throw new Error('Account is not available for authentication setup');
 if(!await identityMetadataAvailable())throw new Error('Shared identity key unavailable');
 const [{default:pkg},{default:qrcode}]=await Promise.all([import('whatsapp-web.js'),import('qrcode-terminal')]);
 client=new pkg.Client({authStrategy:new pkg.LocalAuth({clientId:accountId,dataPath:path.resolve(get('--data-dir')??'./data')}),puppeteer:{headless:true,args:['--no-sandbox']}});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Authentication timeout')),300000);
  client.on('qr',qr=>qrcode.generate(qr,{small:true}));
  client.once('ready',()=>{clearTimeout(timer);resolve();});
  client.once('auth_failure',()=>{clearTimeout(timer);reject(new Error('Authentication failed'));});
  client.initialize().catch(()=>{clearTimeout(timer);reject(new Error('Session initialization failed'));});
 });
 await verifyIdentity({identityHash:account.identity_hash},client.info?.wid?._serialized);
 console.log('Existing account identity verified; session prepared. No measurements collected.');
}catch(e){console.error(e.message);process.exitCode=1;}
finally{try{await client?.destroy();}catch{}await closePool();}
