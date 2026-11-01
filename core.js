import {encode,utf8,sha256,safePath} from './zip.js';
import {createBackupZip,verifyBackupZip} from './backup-zip.js';
export const JOURNAL='installation.json';
export const UF2_FILENAME='KSE.UF2';
export const FIRMWARE_PHASES=['firmware-copying','firmware-copied','firmware-check-required'];
const ROOTS=['SCRIPTS/RF2/','SCRIPTS/IMGR/','WIDGETS/KSETouch/','WIDGETS/RfTool/'];
const protectedUser=p=>/^SCRIPTS\/RF2\/(PREFS\/|settings[^/]*\.(lua|luac)$|background_error\.log$)/i.test(p)||/^SCRIPTS\/IMGR\/pending\./i.test(p);
export const ownProgram=p=>ROOTS.some(r=>p.startsWith(r))&&!protectedUser(p)&&/\.(lua|luac)$/.test(p);
const legacy=p=>/^SCRIPTS\/TOOLS\/Flight Modifier\.(lua|luac)$/.test(p);
const check=(value,message)=>{if(!value)throw Error(message);};
const restartRadio='Wait for any writing to finish. Eject the radio drives, unplug USB, turn the radio off, enter bootloader mode again, reconnect USB and reselect both drives.';
export async function readOptional(fs,path){return await fs.exists(path)?fs.read(path):null;}
export function parseUF2(bytes,{installer=false}={}){
  check(bytes.length>=512&&bytes.length%512===0&&bytes.length<=32*1024*1024,'Invalid UF2 length');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),blocks=new Map(),ids=new Set(),count=bytes.length/512;
  for(let p=0;p<bytes.length;p+=512){
    check(v.getUint32(p,true)===0x0a324655&&v.getUint32(p+4,true)===0x9e5d5157&&v.getUint32(p+508,true)===0x0ab16f30,'Invalid UF2 block');
    const flags=v.getUint32(p+8,true),address=v.getUint32(p+12,true),size=v.getUint32(p+16,true),index=v.getUint32(p+20,true),total=v.getUint32(p+24,true);
    check(total===count&&index<count&&!ids.has(index)&&!blocks.has(address),'UF2 has duplicate or missing blocks');ids.add(index);
    const metadata=address===0x2001fffc;
    check(metadata?size===4:size===256&&address%256===0,'Invalid UF2 payload');
    check(metadata||(address>=0x08000000&&address<0x08010000)||(address>=0x90000000&&address<0x91000000),'UF2 address outside this radio');
    if(installer){
      check(!(flags&~0xa001),'Unsupported UF2 flags');
      check(address>=0x90000000?!(flags&1):!!(flags&1),'Firmware must preserve the existing bootloader');
    }
    blocks.set(address,{flags,data:bytes.slice(p+32,p+32+size)});
  }
  for(let a=0x08000000;a<0x08010000;a+=256)check(blocks.has(a),'UF2 bootloader region is incomplete');
  check(blocks.has(0x90000000),'UF2 application is missing');return blocks;
}
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
// A UF2 volume can flash blocks before close() returns. Abort only releases the
// browser stream; it cannot undo a partial flash. Never retry automatically.
export async function transferUF2(openWriter,bytes,progress=()=>{}){
  parseUF2(bytes,{installer:true});
  const stream=await openWriter();
  try{
    for(let offset=0;offset<bytes.length;offset+=65536){
      const chunk=bytes.subarray(offset,offset+65536);await stream.write(chunk);
      progress(offset+chunk.length,bytes.length,UF2_FILENAME);
    }
    await stream.close();
  }catch(error){await stream.abort().catch(()=>{});throw error;}
}
export function verifyFirmware(current,previous,target){
  const actual=parseUF2(current),before=parseUF2(previous),expected=parseUF2(target,{installer:true});
  let app=0;
  for(const [address,block]of expected){
    if(address>=0x90000000){check(actual.has(address)&&equal(actual.get(address).data,block.data),'Installed firmware differs. '+restartRadio+' Then verify again.');app++;}
  }
  check([...actual.keys()].filter(a=>a>=0x90000000).length===app,'Firmware readback size differs. '+restartRadio+' Then verify again.');
  for(let address=0x08000000;address<0x08010000;address+=256)check(equal(actual.get(address).data,before.get(address).data),'Bootloader differs from the backup.');
  return {applicationBlocks:app,preservedBootloaderBlocks:256};
}
export async function identify(sd,boot){
  const info=utf8.decode(await boot.read('INFO_UF2.TXT'));
  check(/^Board-ID:\s*tx16smk3\s*$/im.test(info),'Select the TX16S MK3 / MK3 MAX bootloader drive.');
  const radio=await sd.read('RADIO/radio.yml');
  check(/^board:\s*["']?tx16smk3["']?\s*$/im.test(utf8.decode(radio)),'Select the root of an existing MK3 radio SD card.');
  const names=await sd.list();
  check(names.some(p=>/^MODELS\/[^/]+\.yml$/i.test(p)),'This folder has no EdgeTX models. Choose the SD card root.');
  const firmware=await boot.read('CURRENT.UF2');parseUF2(firmware);
  return {board:'tx16smk3',radioHash:await sha256(radio),firmwareHash:await sha256(firmware),firmware,info:encode(info),names};
}
// Preview hashes every possible install/removal target and important settings.
// Untouched media/logs get size/path checks only. Their content baseline is
// established during backup, never inferred from timestamps or file sizes.
export async function previewInventory(fs,manifest,{names,progress=()=>{},cancel=()=>false}={}){
  names=names||await fs.list();const result={},targets=new Set([...manifest.files.map(f=>f.path),manifest.settings.path]);let total=0;
  for(let i=0;i<names.length;i++){
    check(!cancel(),'Cancelled before completing the preview.');const path=safePath(names[i]);
    const hash=targets.has(path)||(path.endsWith('.luac')&&targets.has(path.slice(0,-1)))||ownProgram(path)||legacy(path)||/^(?:RADIO\/|MODELS\/|SCRIPTS\/RF2\/(?:PREFS\/|settings[^/]*\.(?:lua|luac)$))/i.test(path);
    if(hash){const bytes=await fs.read(path);result[path]={sha256:await sha256(bytes),size:bytes.length};}
    else result[path]={size:(await fs.stat(path)).size};
    const size=result[path].size;
    check(Number.isSafeInteger(size)&&size>=0&&size<=256*1024*1024,'File exceeds the prototype backup limit (256 MB) or has an invalid size: '+path);
    total+=size;check(total<=32*1024**3,'Backup exceeds the 32 GB prototype limit.');progress(i+1,names.length,path);
  }
  return result;
}
export async function inventory(fs,progress=()=>{},cancel=()=>false){
  const names=await fs.list(),result={};let total=0;
  for(let i=0;i<names.length;i++){
    check(!cancel(),'Cancelled before completing the scan.');const path=safePath(names[i]);
    const bytes=await fs.read(path);total+=bytes.length;check(total<=32*1024**3,'Backup exceeds the 32 GB prototype limit.');
    result[path]={sha256:await sha256(bytes),size:bytes.length};progress(i+1,names.length,path);
  }
  return result;
}
export function buildPlan(manifest,before){
  const plan=[],notes=[];
  const existing=new Map();
  for(const path of Object.keys(before)){safePath(path);const key=path.toLowerCase();check(!existing.has(key),'Ambiguous SD filename: '+path);existing.set(key,path);}
  for(const f of [...manifest.files,manifest.settings]){const alias=existing.get(f.path.toLowerCase());check(!alias||alias===f.path,'Filename casing differs from the package: '+alias+'. Resolve it before installing.');}
  const hasElrs=Object.keys(before).some(p=>/^SCRIPTS\/TOOLS\/[^/]*(elrs|expresslrs)[^/]*\.(lua|luac)$/i.test(p));
  const packagePaths=new Set(manifest.files.map(f=>safePath(f.path)));
  const add=(path,after)=>{const prior=before[path]?.sha256||null;if(prior!==after)plan.push({path,before:prior,after,operation:after===null?'remove':prior?'update':'add'});};
  for(const f of manifest.files){
    check(!/^RADIO\/|^MODELS\/|^flights-count/i.test(f.path),'Package contains protected radio files');
    check(!protectedUser(f.path)||f.path==='SCRIPTS/RF2/PREFS/README.txt','Package contains personal preferences');
    if(/elrs/i.test(f.path)&&f.path.startsWith('SCRIPTS/TOOLS/')&&hasElrs){notes.push('Your existing ExpressLRS tool will be kept.');continue;}
    add(f.path,f.sha256);
  }
  const settings=Object.keys(before).some(p=>/^SCRIPTS\/RF2\/settings(?:_backup|_pending)?\.lua$/i.test(p));
  if(!settings)add(manifest.settings.path,manifest.settings.sha256);
  else if(!before[manifest.settings.path])notes.push('RF2 recovery settings exist without settings.lua. Restore your settings before opening RF Lua; neutral defaults will not overwrite recovery data.');
  for(const p of Object.keys(before)){
    const compiled=p.endsWith('.luac')&&packagePaths.has(p.slice(0,-1));
    const keepElrs=hasElrs&&/^SCRIPTS\/TOOLS\/.*(elrs|expresslrs)/i.test(p);
    // Keep preferences; remove only old executable program files in owned trees,
    // compiled companions for supplied tools, and the incompatible legacy tool.
    if(!keepElrs&&((ownProgram(p)&&!packagePaths.has(p))||compiled||legacy(p)))add(p,null);
    if(/^SCRIPTS\/RF2\/settings(?:_backup|_pending)?\.luac$/i.test(p))add(p,null);
  }
  const keys=new Set();for(const op of plan){check(!keys.has(op.path),'Duplicate install operation');keys.add(op.path);}
  return {operations:plan.sort((a,b)=>a.path.localeCompare(b.path)),notes:[...new Set(notes)]};
}
export async function verifyInventory(fs,expected,progress=()=>{}){
  const names=await fs.list();check(JSON.stringify(names.slice().sort())===JSON.stringify(Object.keys(expected).sort()),'The SD file list changed. Scan again before installing.');
  for(let i=0;i<names.length;i++){
    const p=names[i];check(await sha256(await fs.read(p))===expected[p].sha256,'File changed or failed verification: '+p);progress(i+1,names.length,p);
  }
}
export function expectedAfter(before,operations){
  const after=structuredClone(before);
  for(const op of operations){if(op.after===null)delete after[op.path];else after[op.path]={sha256:op.after};}
  return after;
}
export async function writeVerified(fs,path,bytes){await fs.write(path,bytes);check(await sha256(await fs.read(path))===await sha256(bytes),'Write verification failed: '+path);}
export class Installer {
  constructor({manifest,files,sd,boot,backup,progress=()=>{},cancel=()=>false,status=()=>{}}){
    Object.assign(this,{manifest,files,sd,boot,backup,progress,cancel,status});this.busy=false;this.journal=null;
  }
  async lock(action){check(!this.busy,'An operation is already running.');this.busy=true;try{return await action();}finally{this.busy=false;}}
  async record(){await writeVerified(this.backup,JOURNAL,encode(JSON.stringify(this.journal,null,2)));}
  async scan(){return this.lock(async()=>{
    this.preview=this.before=this.plan=this.identity=this.journal=null;
    this.identity=await identify(this.sd,this.boot);
    const preview=await previewInventory(this.sd,this.manifest,{names:this.identity.names,progress:this.progress,cancel:this.cancel});
    const radioPath=Object.keys(preview).find(p=>p.toLowerCase()==='radio/radio.yml');
    check(preview[radioPath]?.sha256===this.identity.radioHash,'Radio settings changed during the preview. Scan again.');
    const plan=buildPlan(this.manifest,preview);
    // An incomplete fingerprint must never silently classify an existing target
    // as a new file or omit it from the recovery journal.
    for(const op of plan.operations)check(!preview[op.path]||/^[a-f0-9]{64}$/.test(preview[op.path].sha256),'Preview is missing an install-target checksum: '+op.path);
    this.preview=preview;this.plan=plan.operations;this.notes=plan.notes;
    const entries=Object.values(preview),deferred=entries.filter(f=>!f.sha256);
    return {operations:this.plan,notes:this.notes,files:entries.length,bytes:entries.reduce((s,f)=>s+f.size,0),deferredFiles:deferred.length,deferredBytes:deferred.reduce((s,f)=>s+f.size,0)};
  });}
  async createBackup(){return this.lock(async()=>{
    check(this.preview&&this.identity&&this.plan,'Scan the radio first.');check(this.backup,'Choose a backup folder.');
    check(!(await this.backup.list()).length,'Choose an empty backup folder.');
    this.before=this.journal=null;
    const identity=await identify(this.sd,this.boot);
    check(identity.radioHash===this.identity.radioHash&&identity.firmwareHash===this.identity.firmwareHash,'The selected radio changed. Scan again.');
    const names=Object.keys(this.preview),before={};
    check(JSON.stringify(identity.names.slice().sort())===JSON.stringify(names.slice().sort()),'The SD file list changed. Scan again before backing up.');
    this.status('Backing up and checking every SD file…','Images, sounds and all other accessible files are fully read, checksummed and backed up before installation can begin.');
    await writeVerified(this.backup,'CURRENT.UF2',identity.firmware);await writeVerified(this.backup,'INFO_UF2.TXT',identity.info);
    for(let i=0;i<names.length;i++){
      check(!this.cancel(),'Backup cancelled. Radio unchanged. Choose a new empty backup folder to retry.');const p=names[i],bytes=await this.sd.read(p);
      const hash=await sha256(bytes),preview=this.preview[p];
      check(bytes.length===preview.size&&(!preview.sha256||hash===preview.sha256),'File changed since preview or during backup: '+p);
      before[p]={sha256:hash,size:bytes.length};
      await writeVerified(this.backup,'SD/'+p,bytes);this.progress(i+1,names.length,p);
    }
    check(JSON.stringify(buildPlan(this.manifest,before).operations)===JSON.stringify(this.plan),'The install plan changed. Scan again before installing.');
    this.before=before;
    check(await sha256(await this.boot.read('CURRENT.UF2'))===this.identity.firmwareHash,'Firmware changed during backup.');
    this.journal={schema:1,release:this.manifest.id,created:new Date().toISOString(),board:this.identity.board,radioHash:this.identity.radioHash,firmwareHash:this.identity.firmwareHash,before:this.before,operations:this.plan,touched:[],phase:'backup-incomplete',firmwareWritten:false};
    try{
      const entries=[{path:'CURRENT.UF2',size:identity.firmware.length,sha256:identity.firmwareHash},{path:'INFO_UF2.TXT',size:identity.info.length,sha256:await sha256(identity.info)},...names.map(p=>({path:'SD/'+p,...this.before[p]}))];
      const metadata={schema:1,created:this.journal.created,board:identity.board,plannedRelease:this.manifest.id,firmware:{file:'CURRENT.UF2',sha256:identity.firmwareHash,description:'Exact firmware read from the radio before installation; may be stock EdgeTX or KS.'},files:entries};
      const extras={
        'backup-info.json':encode(JSON.stringify(metadata,null,2)),
        'RESTORE.txt':encode('KSE Touch - original radio backup\n\nThis ZIP is a snapshot from BEFORE installation. CURRENT.UF2 is the firmware\nread from your radio, including stock/non-KS firmware if that was installed.\nSD/ contains your original SD files, including models and radio settings.\nSHA256SUMS.txt records checksums; backup-info.json identifies the snapshot.\n\nKeep the original backup folder too. Its installation.json recovery journal\ntracks later installation changes and is intentionally outside this ZIP.\nThe installer can use that folder to recover interrupted SD installations.\n\nTo recover from this ZIP alone, extract it to your computer first. Use only\nwith the same radio. In USB bootloader mode, restore the contents of SD/ to\nthe SD card root and follow the radio/package firmware recovery instructions\nto restore CURRENT.UF2 to EDGETX_UF2. Restore firmware and SD files together.\nDo not delete unrelated files or format a drive as part of ZIP extraction.\nVerify copied files, eject both drives, and check settings and controls on\nthe bench before flight. ZIP extraction does not install anything itself.\n\nKnown OS housekeeping files are excluded. The ZIP uses STORE (no compression)\nfor bounded processing; ZIP64 is used for large archives when needed.\n')
      };
      for(const [path,bytes]of Object.entries(extras)){await writeVerified(this.backup,path,bytes);entries.push({path,size:bytes.length,sha256:await sha256(bytes)});}
      const sums=encode(entries.map(e=>e.sha256+'  '+e.path).join('\n')+'\n');await writeVerified(this.backup,'SHA256SUMS.txt',sums);entries.push({path:'SHA256SUMS.txt',size:sums.length,sha256:await sha256(sums)});
      const path='KSE-radio-backup-'+this.journal.created.replace(/[:.]/g,'-')+'.zip';
      this.status('Creating and verifying your backup ZIP…','The current firmware and all backed-up SD files are being archived on your computer.');
      this.journal.archive=await createBackupZip(this.backup,path,entries,{created:this.journal.created,progress:this.progress,cancel:this.cancel});
      this.status('Verifying the radio against its complete backup…','Every SD file is read again and compared with the backup checksums. Installation remains locked until this passes.');
      await verifyInventory(this.sd,this.before,this.progress);
      check(await sha256(await this.boot.read('CURRENT.UF2'))===this.identity.firmwareHash,'Firmware changed during ZIP creation.');
      check(!this.cancel(),'Backup cancelled. Radio unchanged.');this.journal.phase='backup-verified';await this.record();
    }catch(error){this.journal.phase='backup-incomplete';throw error;}return this.journal;
  });}
  allowed(op){
    safePath(op.path);const supplied=this.manifest.files.find(f=>f.path===op.path)||(op.path===this.manifest.settings.path?this.manifest.settings:null);
    if(op.after!==null)return !!supplied&&op.after===supplied.sha256;
    return ownProgram(op.path)||legacy(op.path)||/^SCRIPTS\/RF2\/settings(?:_backup|_pending)?\.luac$/i.test(op.path)||(op.path.endsWith('.luac')&&this.manifest.files.some(f=>f.path===op.path.slice(0,-1)));
  }
  async validateJournal(){
    const j=this.journal;check(j?.schema===1&&j.release===this.manifest.id&&j.board==='tx16smk3','Backup belongs to another installer release.');
    check(Array.isArray(j.operations)&&Array.isArray(j.touched)&&j.before&&typeof j.before==='object','Invalid recovery journal');
    const seen=new Set();for(const op of j.operations){check(!seen.has(op.path)&&this.allowed(op),'Journal contains an unrecognized file operation');seen.add(op.path);check(op.before===(j.before[op.path]?.sha256||null),'Backup journal mismatch');}
    check(new Set(j.touched).size===j.touched.length&&j.touched.every(p=>seen.has(p)),'Invalid recovery list');
    check(await sha256(await this.backup.read('CURRENT.UF2'))===j.firmwareHash,'Firmware backup is damaged');
    check(await sha256(await this.sd.read('RADIO/radio.yml'))===j.radioHash,'This SD card does not match the backup.');
    const info=utf8.decode(await this.boot.read('INFO_UF2.TXT'));check(/^Board-ID:\s*tx16smk3\s*$/im.test(info),'Wrong bootloader drive');
  }
  async install(){return this.lock(async()=>{
    check(this.journal?.phase==='backup-verified','Complete a verified backup first.');await this.validateJournal();
    await verifyBackupZip(this.backup,this.journal.archive,{progress:this.progress,cancel:this.cancel});
    await verifyInventory(this.sd,this.journal.before,this.progress);
    check(await sha256(await this.boot.read('CURRENT.UF2'))===this.journal.firmwareHash,'Firmware changed since backup.');
    for(const op of this.journal.operations){
      if(op.before)check(await sha256(await this.backup.read('SD/'+op.path))===op.before,'Backup is damaged: '+op.path);
      if(op.after)check(this.files.has(op.path)&&await sha256(this.files.get(op.path))===op.after,'Package changed: '+op.path);
    }
    this.journal.phase='installing';await this.record();
    try{
      for(let i=0;i<this.journal.operations.length;i++){
        check(!this.cancel(),'Installation cancelled.');const op=this.journal.operations[i];
        this.journal.touched.push(op.path);await this.record(); // Intent persisted before changing a radio file.
        if(op.after)await writeVerified(this.sd,op.path,this.files.get(op.path));else await this.sd.remove(op.path);
        this.progress(i+1,this.journal.operations.length,op.path);
      }
      await verifyInventory(this.sd,expectedAfter(this.journal.before,this.journal.operations),this.progress);
      check(await sha256(await this.boot.read('CURRENT.UF2'))===this.journal.firmwareHash,'Firmware changed unexpectedly.');
      this.journal.phase='sd-verified';await this.record();return this.journal;
    }catch(error){
      this.journal.error=error.message;try{await this.rollback();}catch(recovery){this.journal.phase='recovery-required';this.journal.recoveryError=recovery.message;await this.record().catch(()=>{});throw Error(error.message+' Reconnect the same radio and use Restore SD files with this backup.');}
      throw Error(error.message+' Previous SD files restored and verified; firmware was not written.');
    }
  });}
  async rollback(){
    check(!this.journal?.firmwareAttempt&&!FIRMWARE_PHASES.includes(this.journal?.phase)&&!this.journal?.firmwareWritten,'Firmware copying has been attempted. '+restartRadio+' Verify first; use the full backup instructions to restore firmware and SD files together.');
    await this.validateJournal();const ops=new Map(this.journal.operations.map(o=>[o.path,o]));
    check(await sha256(await this.boot.read('CURRENT.UF2'))===this.journal.firmwareHash,'Firmware has changed. Restore firmware and SD files together using the full backup instructions.');
    // Validate all recovery bytes before the first restore write.
    for(const path of this.journal.touched){const op=ops.get(path);if(op.before)check(await sha256(await this.backup.read('SD/'+path))===op.before,'Backup is damaged: '+path);}
    this.journal.phase='restoring';await this.record();
    for(const path of [...this.journal.touched].reverse()){
      const op=ops.get(path);if(op.before)await writeVerified(this.sd,path,await this.backup.read('SD/'+path));else if(await this.sd.exists(path))await this.sd.remove(path);
    }
    await verifyInventory(this.sd,this.journal.before,this.progress);this.journal.phase='restored';await this.record();return this.journal;
  }
  async restore(){return this.lock(async()=>{this.journal=JSON.parse(utf8.decode(await this.backup.read(JOURNAL)));return this.rollback();});}
  async copyFirmware(){return this.lock(async()=>{
    if(!this.journal)this.journal=JSON.parse(utf8.decode(await this.backup.read(JOURNAL)));
    check(this.manifest.firmwareWriteEnabled===true,'Firmware copying is disabled for this release.');
    check(this.journal.phase==='sd-verified'&&!this.journal.firmwareAttempt,'Complete the SD installation first. If firmware copying was already attempted, restart the radio in bootloader mode, reconnect USB and verify instead of copying again.');
    check(typeof this.boot?.copyFirmware==='function','This drive adapter cannot copy firmware.');
    // Own a stable copy for the entire transfer; check everything before the first
    // write to the firmware drive, including the original stock/non-KS backup.
    const target=this.files.get('@firmware')?.slice();
    check(target&&await sha256(target)===this.manifest.firmware.sha256,'Firmware checksum mismatch');parseUF2(target,{installer:true});
    await this.validateJournal();
    await verifyBackupZip(this.backup,this.journal.archive,{progress:this.progress,cancel:this.cancel});
    await verifyInventory(this.sd,expectedAfter(this.journal.before,this.journal.operations),this.progress);
    check(await sha256(await this.boot.read('CURRENT.UF2'))===this.journal.firmwareHash,'Firmware changed since backup. '+restartRadio+' Verify before proceeding.');
    check(!this.cancel(),'Firmware copy cancelled before writing.');
    this.journal.phase='firmware-copying';this.journal.firmwareWritten=null;
    this.journal.firmwareAttempt={file:UF2_FILENAME,sha256:this.manifest.firmware.sha256,started:new Date().toISOString()};
    this.status('Copying firmware to EDGETX_UF2…','Keep the radio connected and this tab open. Cancellation is disabled during firmware copying.');
    try{
      await this.record(); // Durable intent before opening ANY firmware writer.
      await this.boot.copyFirmware(target,this.progress);
      this.journal.phase='firmware-copied';this.journal.firmwareAttempt.copyCompleted=new Date().toISOString();
      await this.record();return this.journal;
    }catch(error){
      this.journal.phase='firmware-check-required';this.journal.firmwareAttempt.error=error.message;
      await this.record().catch(()=>{});
      throw Error('Firmware copy is not verified: '+error.message+'. '+restartRadio+' Confirm the restart and run the final check. No automatic retry or SD rollback was performed.');
    }
  });}
  async verifyFinal({reconnected=false}={}){return this.lock(async()=>{
    if(!this.journal)this.journal=JSON.parse(utf8.decode(await this.backup.read(JOURNAL)));
    check(['sd-verified','verified',...FIRMWARE_PHASES].includes(this.journal.phase),'SD installation has not completed.');
    check(!this.journal.firmwareAttempt||reconnected,'Reconnect after a full radio restart: unplug USB, turn the radio off, enter bootloader mode again, reconnect USB and reselect both drives before verifying firmware.');
    await this.validateJournal();
    const target=this.files.get('@firmware');check(target&&await sha256(target)===this.manifest.firmware.sha256,'Load the verified release first.');
    await verifyInventory(this.sd,expectedAfter(this.journal.before,this.journal.operations),this.progress);
    const result=verifyFirmware(await this.boot.read('CURRENT.UF2'),await this.backup.read('CURRENT.UF2'),target);
    this.journal.phase='verified';this.journal.firmwareWritten=true;this.journal.verification={...result,at:new Date().toISOString(),hardwareRuntimeVerified:false};await this.record();return this.journal;
  });}
}
