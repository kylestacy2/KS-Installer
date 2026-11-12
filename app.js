import {loadRelease,encode,utf8} from './zip.js';
import {Installer,parseUF2,JOURNAL,FIRMWARE_PHASES} from './core.js';
import {BrowserFS,separateHandles} from './fs.js';
import {makeDemo} from './demo.js';
const $=id=>document.getElementById(id);
let release,files,sd,boot,backup,engine,demo=false,busy=false,cancel=false,scanned=false,backupReady=false,sdReady=false,complete=false,resumeReady=false,recoveryReady=false;
const activity=[];let messageTimer,demoDrives;
const sdPhases=['sd-verified','verified',...FIRMWARE_PHASES];
const stepKeys=['release','radio','backup','sd','verify'];
const stepDone=new Map();let revealStep=null;
const PICKER_CANCELLED=Symbol('picker-cancelled');
const radioRestartInstructions='Wait for Writing complete. Eject the radio drives on your computer, then unplug USB. Turn the radio off, enter bootloader mode again with USB unplugged, and reconnect USB. Reselect both drives, then confirm the restart in step 05. Keep this installer tab open.';
function resetSteps(){stepDone.clear();for(const key of stepKeys)$('step-'+key).open=true;}
function showStep(key){
  const card=$('step-'+key);card.open=true;
  $('step-'+key+'-heading').focus({preventScroll:true});
  card.scrollIntoView({block:'start',behavior:'instant'});
}
function drawSteps(){
  if(busy)return; // Never hide controls or move focus during a file operation.
  const connected=!!sd&&!!boot&&$('one-radio').checked;
  const skipped=!!engine?.backupSkipped;
  const done={release:!!files,radio:scanned&&$('one-radio').checked&&(connected||sdReady),backup:backupReady||skipped,
    sd:complete||engine?.journal?.phase==='firmware-copied',verify:complete};
  const summaries={
    release:demo?'Demo release verified':release?.label+' · ZIP verified',
    radio:sdReady?'Initial radio check complete · reconnect in step 05':$('plan').hidden?'Drives selected · recovery checks available':$('plan-summary').textContent,
    backup:skipped?'Backup skipped · no recovery backup saved':'Original firmware + SD files saved · backup ZIP verified',
    sd:complete?'SD files and firmware verified':'SD files verified · UF2 copied · restart and reconnect',
    verify:'Installed release files, firmware and bootloader verified'
  };
  let advanced=false;
  for(const key of stepKeys){
    const card=$('step-'+key),was=stepDone.get(key)||false,now=!!done[key];
    if(now&&!was){card.open=false;advanced=true;}
    else if(was&&!now)card.open=true;
    card.classList.toggle('done',now);
    if(key==='backup')card.classList.toggle('skipped',skipped);
    $('step-'+key+'-summary').textContent=summaries[key];$('step-'+key+'-summary').hidden=!now;
    stepDone.set(key,now);
  }
  if(revealStep){const key=revealStep;revealStep=null;showStep(key);}
  else if(advanced){
    const next=sdReady&&connected&&firmwareAttempted()&&!complete?'verify':stepKeys.find(key=>!done[key]);
    if(next)showStep(next);
    else{
      // All five stay collapsed; keep the separate startup instructions visible.
      $('step-verify-heading').focus({preventScroll:true});
      $('step-verify').scrollIntoView({block:'start',behavior:'instant'});
    }
  }
}
const firmwareAttempted=()=>!!engine?.journal?.firmwareAttempt||FIRMWARE_PHASES.includes(engine?.journal?.phase);
function reconnectRequired(){
  if(demo)demoDrives={sd,boot};
  sd=boot=null;$('reconnected').checked=false;
  revealStep='verify';
}
function journalState(){
  const phase=engine?.journal?.phase;
  backupReady=!engine?.backupSkipped&&['backup-verified',...sdPhases].includes(phase);
  sdReady=sdPhases.includes(phase);resumeReady=sdReady;
  recoveryReady=!!engine?.journal&&!engine.backupSkipped;
}
const supported=()=>isSecureContext&&'showDirectoryPicker'in window&&'DecompressionStream'in window&&!!crypto.subtle;
function log(text,error=false){const at=new Date().toLocaleTimeString();activity.push({at,text,error});const p=document.createElement('p');p.textContent=at+'  '+text;if(error)p.className='error';$('log').append(p);$('log').scrollTop=$('log').scrollHeight;}
function message(text){$('message').textContent=text;$('message').hidden=false;clearTimeout(messageTimer);messageTimer=setTimeout(()=>$('message').hidden=true,15000);}
function stage(title,detail){$('stage-title').textContent=title;$('stage-detail').textContent=detail;}
function progress(n,total){$('progress').value=total?Math.round(n/total*100):0;}
function draw(){
  const active=busy,ready=!!files,canUse=demo||supported();
  const skipped=!!engine?.backupSkipped,prepared=backupReady||(skipped&&engine.journal.phase==='backup-skipped');
  $('choose-zip').disabled=active||demo||!release||!canUse;
  const pending=firmwareAttempted(),connected=sd&&boot&&$('one-radio').checked;
  $('radio-title').textContent='Connect your radio';
  $('radio-instructions').textContent='Start in bootloader mode, then select both radio drives. After copying firmware, reselect the drives directly in step 05.';
  for(const [id,enabled]of Object.entries({
    'choose-sd':ready&&canUse,'choose-boot':ready&&canUse,
    'reselect-sd':ready&&canUse&&(sdReady||resumeReady),'reselect-boot':ready&&canUse&&(sdReady||resumeReady),
    'scan':ready&&connected&&!engine?.journal,'choose-backup':ready&&connected&&canUse&&!skipped,
    'backup':scanned&&backup&&!backupReady&&!skipped&&!pending&&connected,
    'skip-backup':scanned&&!backupReady&&!skipped&&!pending&&connected&&(!engine?.journal||engine.journal.phase==='backup-incomplete'),
    'install':ready&&(prepared||sdReady)&&!complete&&!pending&&connected&&(backup||skipped),
    'verify':files&&connected&&(backup||skipped)&&(sdReady||resumeReady)&&$('reconnected').checked,
    'restore':files&&connected&&backup&&recoveryReady&&!skipped&&!pending&&!complete,
    'manual-firmware':!demo&&sdReady&&ready&&!complete,
    'demo-reconnect':demo&&pending&&!sd&&!boot,
    'demo':!engine?.journal||demo||complete,'reset':true,'report':activity.length>0
  }))$(id).disabled=active||!enabled;
  $('choose-zip').disabled||=!!engine?.journal&&!complete;
  $('one-radio').disabled=active;$('reconnected').disabled=active||!sd||!boot;
  $('cancel').hidden=!active||engine?.journal?.phase==='firmware-copying';$('cancel').disabled=cancel;$('cancel').textContent=skipped?'Cancel':'Cancel safely';
  $('reconnect-step').hidden=!(sdReady||resumeReady);
  $('demo-reconnect').hidden=!demo||!pending||!!sd||!!boot;
  const labels={package:ready,radio:scanned,backup:backupReady,sd:sdReady,firmware:complete};
  for(const [k,v]of Object.entries(labels))$('status-'+k).classList.toggle('done',!!v);
  $('status-backup').textContent=skipped?'Backup skipped':'Backup verified';$('status-backup').classList.toggle('skipped',skipped);
  $('release-status').textContent=ready?'Verified':'Not loaded';$('release-status').classList.toggle('good',ready);
  $('backup-status').textContent=skipped?'Skipped':backupReady?'Verified':'Recommended';$('backup-status').classList.toggle('good',backupReady);$('backup-status').classList.toggle('skipped',skipped);
  $('sd-name').textContent=sd?.name||'Contains RADIO, MODELS and SCRIPTS';$('boot-name').textContent=boot?.name||'Contains INFO_UF2.TXT and CURRENT.UF2';
  $('reselect-sd-name').textContent=sd?.name||'Select the reconnected SD card';$('reselect-boot-name').textContent=boot?.name||'Select the reconnected EDGETX_UF2 drive';
  $('backup-name').textContent=backup?'Backup folder: '+backup.name:'Choose a folder outside the radio drives. Keep it for recovery.';
  const archive=backupReady&&engine?.journal?.archive;
  $('backup-archive').textContent=skipped?'No recovery backup was saved. Keep this tab open until verification finishes; this installation cannot be resumed after closing the tab.':archive?'Verified ZIP: '+archive.path+' · '+(archive.size/1048576).toFixed(1)+' MB. Saved inside your backup folder.':'A dated ZIP is created automatically and checked when you choose to back up.';
  $('no-backup-notice').hidden=!skipped;
  $('sd-install-note').textContent='The installer replaces the matching program files and clears their old program caches. Your existing ExpressLRS tool is kept. '+(skipped?'Backup was skipped, so failed or cancelled writes cannot be rolled back.':'If a write fails, it attempts to restore the previous SD files from your backup.');
  $('firmware-backup-note').textContent=(skipped?'No original firmware backup was saved.':'The original firmware stays in your backup folder and ZIP.')+' Firmware copying cannot be cancelled once it begins.';
  $('recovery-instructions').hidden=skipped;
  $('install').textContent=sdReady&&!pending&&!complete?'Continue update':'Install update';$('next-steps').hidden=!complete;
  drawSteps();
}
function getEngine(){
  if(!engine)engine=new Installer({manifest:release,files,sd,boot,backup,progress,cancel:()=>cancel,status:(title,detail)=>{stage(title,detail);draw();}});
  Object.assign(engine,{sd,boot,backup,files,manifest:release});return engine;
}
async function action(title,fn,step,onPickerCancel){
  if(busy)return;const started=performance.now();busy=true;cancel=false;$('message').hidden=true;progress(0,1);stage(title,'Keep this tab open and the USB cable connected.');draw();log(title);
  let pickerCancelled=false;
  try{pickerCancelled=(await fn())===PICKER_CANCELLED;if(!pickerCancelled)progress(1,1);}catch(e){
    const text=e.name==='AbortError'?'Selection cancelled.':e.message;log(text,true);message(text);stage(firmwareAttempted()?'Firmware verification needed.':'Stopped.',text);
    journalState();
    if(engine?.journal?.phase==='restored'){scanned=false;resumeReady=false;stage('Previous SD files restored.', 'The firmware was not written. Start a fresh scan and choose an empty backup folder to try again.');}
    if(engine?.journal?.phase==='recovery-required')stage('Reconnect to recover.',text);
    revealStep=firmwareAttempted()?'verify':step;
  }finally{log('Step duration: '+((performance.now()-started)/1000).toFixed(1)+' seconds.');busy=false;draw();if(pickerCancelled)onPickerCancel();}
}
async function checkHandles(candidate,kind){
  const handles=[];for(const [k,fs]of Object.entries({sd,boot,backup}))if(k!==kind&&fs?.handle)handles.push(fs.handle);handles.push(candidate);await separateHandles(handles);
}
function download(bytes,name,type='application/octet-stream'){
  const blob=bytes instanceof Blob?bytes:new Blob([bytes],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
$('choose-zip').onclick=()=>$('zip').click();
$('zip').onchange=()=>action('Checking the release…',async()=>{
  const blob=$('zip').files[0];if(!blob)return;
  const loaded=await loadRelease(blob,release,(n,t)=>progress(n,t),()=>cancel);parseUF2(loaded.get('@firmware'),{installer:true});
  files=loaded;engine=null;scanned=backupReady=sdReady=complete=resumeReady=recoveryReady=false;$('plan').hidden=true;resetSteps();
  stage('Release verified.','Connect the radio in bootloader mode, then choose its two drives.');log('Release hash and all '+files.size+' install resources match '+release.id+'.');
},'release');
function chooseFolder(kind,step,buttonId){
  if(busy)return;
  if(demo){log('Demo '+kind+' folder is already selected.');return;}
  const previous={title:$('stage-title').textContent,detail:$('stage-detail').textContent,progress:$('progress').value};
  // Start the native picker in the click handler, before slow work can consume activation.
  let selection;try{selection=window.showDirectoryPicker({id:'kse-'+kind,mode:'readwrite'});}catch(error){selection=Promise.reject(error);}
  return action('Selecting '+(kind==='boot'?'firmware drive':kind==='sd'?'SD drive':'backup folder')+'…',async()=>{
    let handle;
    try{handle=await selection;}catch(error){
      // Only cancellation of the picker is a no-op. Read/permission failures
      // after selection still use the normal error and recovery path.
      if(error.name==='AbortError')return PICKER_CANCELLED;
      throw error;
    }
    await checkHandles(handle,kind);
    const fs=new BrowserFS(handle,{readOnly:kind==='boot'});
    complete=false;
    if(kind==='sd'){sd=fs;$('reconnected').checked=false;}else if(kind==='boot'){boot=fs;$('reconnected').checked=false;}else{
      backup=fs;backupReady=sdReady=resumeReady=recoveryReady=false;if(engine)engine.journal=null;
      if(await fs.exists(JOURNAL)){const j=JSON.parse(utf8.decode(await fs.read(JOURNAL)));if(j.schema!==1||j.release!==release.id)throw Error('This backup belongs to another release.');getEngine().journal=j;journalState();scanned=true;complete=false;$('reconnected').checked=false;}
    }
    if(kind!=='backup'&&!engine?.journal)scanned=false;
    stage('Folder selected.',sdReady?(firmwareAttempted()?'Select both drives here in step 05, confirm the radio restart, then verify.':'Continue the update in step 04 to copy the firmware after its preflight checks.'):'Check the radio, or continue a verification/recovery using the same radio and backup.');log('Selected '+kind+': '+fs.name);
    if(sdReady)revealStep=firmwareAttempted()||engine?.journal?.phase==='verified'?'verify':'sd';
  },step,()=>{
    stage(previous.title,previous.detail);$('progress').value=previous.progress;
    log((kind==='boot'?'UF2 drive':kind==='sd'?'SD card':'Backup folder')+' selection cancelled. Existing selections and installation progress kept; you can select the folder again.');
    showStep(step);$(buttonId).focus({preventScroll:true});
  });
}
for(const kind of ['sd','boot','backup'])$('choose-'+kind).onclick=()=>chooseFolder(kind,kind==='backup'?'backup':'radio','choose-'+kind);
for(const kind of ['sd','boot'])$('reselect-'+kind).onclick=()=>chooseFolder(kind,'verify','reselect-'+kind);
$('one-radio').onchange=draw;$('reconnected').onchange=()=>{if($('reconnected').checked)revealStep='verify';draw();};
$('scan').onclick=()=>action('Checking the radio…',async()=>{
  if(!demo&&!(await boot.exists('INFO_UF2.TXT')))throw Error('Select the root of EDGETX_UF2.');
  const summary=await getEngine().scan();scanned=true;backupReady=sdReady=complete=false;
  $('plan').hidden=false;$('plan-summary').textContent=summary.operations.length+' file changes · '+summary.files+' existing files · '+(summary.bytes/1048576).toFixed(1)+' MB of SD files to back up';
  $('plan-files').replaceChildren();for(const op of summary.operations){const li=document.createElement('li');li.textContent=op.operation.toUpperCase()+'  '+op.path;$('plan-files').append(li);}
  $('plan-notes').replaceChildren();for(const text of summary.notes){const p=document.createElement('p');p.textContent=text;$('plan-notes').append(p);}
  if(summary.deferredFiles){const p=document.createElement('p');p.textContent=summary.deferredFiles+' other SD files were checked by name and size. Their contents will be fully read and verified during backup.';$('plan-notes').append(p);}
  stage('MK3 radio identified.','Preview ready. Back up to an empty computer folder, or choose Skip backup to continue without a recovery copy.');log('MK3 identity and install targets checked. '+summary.deferredFiles+' untouched files can be fully backed up if you choose the backup option. No radio files changed.');
},'radio');
$('backup').onclick=()=>action('Backing up your radio…',async()=>{
  await getEngine().createBackup();backupReady=true;recoveryReady=true;stage('Backup folder + ZIP verified.','Your original firmware and SD files are saved on your computer. You can now install the SD files and firmware in one step.');log('Backup folder and '+engine.journal.archive.path+' verified. Every ZIP entry was reopened and checked. Radio unchanged.');
},'backup');
$('skip-backup').onclick=()=>{
  if(busy||$('skip-backup').disabled)return;
  $('skip-backup-dialog').showModal();
};
$('cancel-skip-backup').onclick=()=>$('skip-backup-dialog').close();
$('confirm-skip-backup').onclick=()=>{
  if(busy||!$('skip-backup-dialog').open||$('skip-backup').disabled)return;
  $('skip-backup-dialog').close();
  return action('Preparing installation without a backup…',async()=>{
    await getEngine().skipBackup({confirmed:true});backupReady=false;recoveryReady=false;
    stage('Backup skipped.','No recovery backup will be saved. Keep this tab open through installation, the radio restart and final verification.');
    $('sd-result').textContent='Ready to install without a backup. Previous files cannot be restored if installation fails.';
    log('User confirmed skipping the backup. No backup folder or ZIP created; automatic rollback is unavailable.');
  },'backup');
};
$('install').onclick=()=>action('Installing the update…',async()=>{
  const installer=getEngine();
  try{
    if(!sdReady){
      stage('Installing and verifying SD files…','Firmware will copy automatically after the SD files pass verification. Keep the radio connected.');
      await installer.install();sdReady=true;
      $('sd-result').textContent='SD files verified. Checking the radio before automatically copying firmware.';
      log('SD programs and preserved settings verified. Continuing automatically to the firmware copy.');
    }
    progress(0,1);stage('Checking before the firmware copy…','SD files are verified. Keep this tab open and the USB cable connected.');draw();
    await installer.copyFirmware();
    $('sd-result').textContent='SD files verified and UF2 copied. Restart the radio and reconnect for the final check.';
    log('UF2 stream closed. Firmware has NOT yet passed readback verification.');
    stage('UF2 copied — restart and reconnect.',demo?'Use Simulate radio restart in step 05, then run the final check.':radioRestartInstructions);
  }catch(error){
    if(sdReady&&!firmwareAttempted())$('sd-result').textContent='SD files are verified, but firmware copying has not started. Resolve the error, then choose Continue update; the SD installation will not be repeated.';
    throw error;
  }finally{
    if(firmwareAttempted())reconnectRequired();
  }
},'sd');
$('cancel').onclick=()=>{cancel=true;draw();log('Cancellation requested. Waiting for the current file operation to finish.');};
$('demo-reconnect').onclick=()=>{
  if(!demo||!demoDrives||busy)return;
  ({sd,boot}=demoDrives);demoDrives=null;$('reconnected').checked=true;revealStep='verify';
  stage('Demo radio restarted and reconnected.','Run the final check to compare the simulated firmware and installed release files.');
  log('Radio power-off, bootloader restart and USB reconnect simulated. No physical USB behavior tested.');draw();
};
$('manual-firmware').onclick=()=>{
  if(demo||busy||!sdReady)return;
  download(files.get('@firmware'),'KSE-2.12.1-KS-MK3.uf2');
  reconnectRequired();stage('Manual firmware copy selected.','Copy the downloaded UF2 to EDGETX_UF2. '+radioRestartInstructions);draw();
};
$('verify').onclick=()=>action('Verifying installed files and firmware…',async()=>{
  complete=false;draw();
  const result=await getEngine().verifyFinal({reconnected:$('reconnected').checked});backupReady=!engine.backupSkipped;sdReady=complete=true;
  stage(demo?'Demo complete.':'Installation verified.','Firmware readback and installed release files match. Eject both drives through your computer before restarting the radio.');
  $('final-result').textContent=result.verification.installedFiles+' installed SD files and '+result.verification.applicationBlocks+' application blocks verified; original bootloader preserved. Radio operation still needs a bench check.';
  log('PASS: installed release files, firmware payload and preserved bootloader verified. This is a file check, not a radio/flight test.');
},'verify');
$('restore').onclick=()=>{
  if(!confirm('Restore the previous SD program files from this backup? This does not restore firmware.'))return;
  action('Restoring the previous SD files…',async()=>{
    await getEngine().restore();backupReady=sdReady=complete=scanned=false;stage('Previous SD files restored.','The SD matches your backup. Firmware was not changed by the installer.');log('Previous SD files restored and verified.');
  },'backup');
};
$('report').onclick=()=>download(encode(JSON.stringify({schema:1,prototype:true,demo,release:release?.id,backupSkipped:!!engine?.backupSkipped,activities:activity,phase:engine?.journal?.phase||'not-started',verification:engine?.journal?.verification||null},null,2)),'KSE-install-report.json','application/json');
$('demo').onclick=()=>action('Connecting a demo radio…',async()=>{
  const d=await makeDemo();({manifest:release,files,sd,boot,backup}=d);engine=null;scanned=backupReady=sdReady=complete=resumeReady=recoveryReady=false;demo=true;demoDrives=null;$('reconnected').checked=false;$('demo-banner').hidden=false;$('plan').hidden=true;$('one-radio').checked=true;resetSteps();
  $('release-label').textContent='Demo release · no hardware writes';$('release-link').hidden=true;
  stage('Try the installation workflow.','Click Check radio & preview changes. The demo includes existing settings, a saved layout and personal files.');log('Demo uses the same backup, SD install, UF2 copy and verification steps with memory drives only.');
},'release');
$('reset').onclick=()=>location.reload();
window.addEventListener('beforeunload',event=>{if(busy||(engine?.backupSkipped&&!complete)){event.preventDefault();event.returnValue='';}});
try{
  const response=await fetch('./release.json',{cache:'no-store'});if(!response.ok)throw Error('Release information is unavailable');release=await response.json();
  if(release.firmwareWriteEnabled!==true)throw Error('This release does not enable the verified UF2 copy step');
  $('release-label').textContent=release.label;$('release-link').href=release.releaseURL;
  if(!supported()){stage('Open this in desktop Chrome or Edge.','This browser cannot access selected drive folders. You can still try the demo.');log('Drive access unavailable in this browser. Demo remains available.');}
}catch(e){message(e.message);stage('Release unavailable.',e.message);}draw();
