import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export async function softwareMetadata() {
  const version=async name=>{try{return JSON.parse(await fs.readFile(new URL(`../node_modules/${name}/package.json`,import.meta.url),'utf8')).version;}catch{return null;}};
  let build=process.env.BUILD_ID??null;
  if(!build) {try {build=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}}
  return {build,node:process.version,libraryVersion:await version('whatsapp-web.js'),puppeteerVersion:await version('puppeteer'),pgVersion:await version('pg'),workingTree:'unrecorded; assign BUILD_ID to a reviewed build for research use'};
}
