import {loadRelease,encode,utf8} from './zip.js';
import {Installer,parseUF2,JOURNAL,FIRMWARE_PHASES} from './core.js';
import {BrowserFS,separateHandles} from './fs.js';
import {makeDemo} from './demo.js';
const $=id=>document.getElementById(id);
let release,files,sd,boot,backup,engine,demo=false,busy=false,cancel=false,scanned=false,backupReady=false,sdReady=false,complete=false,resumeReady=false,recoveryReady=false;
const activity=[];let messageTimer,demoDrives;
const sdPhases=['sd-verified','verified',...FIRMWARE_PHASES];
const firmwareAttempted=()=>!!engine?.journal?.firmwareAttempt||FIRMWARE_PHASES.includes(engine?.journal?.phase);
function reconnectRequired(){
  if(demo)demoDrives={sd,boot};
  sd=boot=null;$('reconnected').checked=false;
}
function journalState(){
  const phase=engine?.journal?.phase;
  backupReady=['backup-verified',...sdPhases].includes(phase);
  sdReady=sdPhases.includes(phase);resumeReady=sdReady;
  recoveryReady=!!engine?.journal;
}
const supported=()=>isSecureContext&&'showDirectoryPicker'in window&&'DecompressionStream'in window&&!!crypto.subtle;
function log(text,error=false){const at=new Date().toLocaleTimeString();activity.push({at,text,error});const p=document.createElement('p');p.textContent=at+'  '+text;if(error)p.className='error';$('log').append(p);$('log').scrollTop=$('log').scrollHeight;}
function message(text){$('message').textContent=text;$('message').hidden=false;clearTimeout(messageTimer);messageTimer=setTimeout(()=>$('message').hidden=true,15000);}
function stage(title,detail){$('stage-title').textContent=title;$('stage-detail').textContent=detail;}
function progress(n,total){$('progress').value=total?Math.round(n/total*100):0;}
function draw(){
  const active=busy,ready=!!files,canUse=demo||supported();
  $('choose-zip').disabled=active||demo||!release||!canUse;
  const pending=firmwareAttempted(),connected=sd&&boot&&$('one-radio').checked;
  for(const [id,enabled]of Object.entries({
    'choose-sd':ready&&canUse,'choose-boot':ready&&canUse,
    'scan':ready&&connected&&!engine?.journal,'choose-backup':ready&&connected&&canUse,
    'backup':scanned&&backup&&!backupReady&&!pending&&connected,
    'install':backupReady&&!sdReady&&!complete&&connected,
    'firmware':sdReady&&!complete&&!pending&&connected&&backup,
    'verify':files&&connected&&backup&&(sdReady||resumeReady)&&$('reconnected').checked,
    'restore':files&&connected&&backup&&recoveryReady&&!pending&&!complete,
    'manual-firmware':!demo&&sdReady&&ready&&!complete,
    'demo-reconnect':demo&&pending&&!sd&&!boot,
    'demo':!engine?.journal||demo||complete,'reset':true,'report':activity.length>0
  }))$(id).disabled=active||!enabled;
  $('choose-zip').disabled||=!!engine?.journal&&!complete;
  $('one-radio').disabled=active;$('reconnected').disabled=active||!sd||!boot;
  $('cancel').hidden=!active||engine?.journal?.phase==='firmware-copying';$('cancel').disabled=cancel;
  $('reconnect-step').hidden=!(sdReady||resumeReady);
  $('demo-reconnect').hidden=!demo||!pending||!!sd||!!boot;
  const labels={package:ready,radio:scanned,backup:backupReady,sd:sdReady,firmware:complete};
  for(const [k,v]of Object.entries(labels))$('status-'+k).classList.toggle('done',!!v);
  $('release-status').textContent=ready?'Verified':'Not loaded';$('release-status').classList.toggle('good',ready);
  $('backup-status').textContent=backupReady?'Verified':'Required';$('backup-status').classList.toggle('good',backupReady);
  $('sd-name').textContent=sd?.name||'Contains RADIO, MODELS and SCRIPTS';$('boot-name').textContent=boot?.name||'Contains INFO_UF2.TXT and CURRENT.UF2';
  $('backup-name').textContent=backup?'Backup folder: '+backup.name:'Choose a folder outside the radio drives. Keep it for recovery.';
  const archive=backupReady&&engine?.journal?.archive;
  $('backup-archive').textContent=archive?'Verified ZIP: '+archive.path+' · '+(archive.size/1048576).toFixed(1)+' MB. Saved inside your backup folder.':'A dated ZIP is created automatically and checked before installation can begin.';
  $('firmware').textContent=demo?'Copy UF2 to demo radio':'Copy UF2 to radio';$('next-steps').hidden=!complete;
}
function getEngine(){
  if(!engine)engine=new Installer({manifest:release,files,sd,boot,backup,progress,cancel:()=>cancel,status:(title,detail)=>{stage(title,detail);draw();}});
  Object.assign(engine,{sd,boot,backup,files,manifest:release});return engine;
}
async function action(title,fn){
  if(busy)return;busy=true;cancel=false;$('message').hidden=true;progress(0,1);stage(title,'Keep this tab open and the USB cable connected.');draw();log(title);
  try{await fn();progress(1,1);}catch(e){
    const text=e.name==='AbortError'?'Selection cancelled.':e.message;log(text,true);message(text);stage(firmwareAttempted()?'Firmware verification needed.':'Stopped.',text);
    journalState();
    if(engine?.journal?.phase==='restored'){scanned=false;resumeReady=false;stage('Previous SD files restored.', 'The firmware was not written. Start a fresh scan and choose an empty backup folder to try again.');}
    if(engine?.journal?.phase==='recovery-required')stage('Reconnect to recover.',text);
  }finally{busy=false;draw();}
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
  files=loaded;engine=null;scanned=backupReady=sdReady=complete=resumeReady=recoveryReady=false;$('plan').hidden=true;
  stage('Release verified.','Connect the radio in bootloader mode, then choose its two drives.');log('Release hash and all '+files.size+' install resources match '+release.id+'.');
});
for(const kind of ['sd','boot','backup'])$('choose-'+kind).onclick=()=>{
  if(demo){log('Demo '+kind+' folder is already selected.');return;}
  // Start the native picker in the click handler, before slow work can consume activation.
  const selection=window.showDirectoryPicker({id:'kse-'+kind,mode:'readwrite'});
  action('Selecting '+(kind==='boot'?'firmware drive':kind==='sd'?'SD drive':'backup folder')+'…',async()=>{
    const handle=await selection;await checkHandles(handle,kind);
    const fs=new BrowserFS(handle,{readOnly:kind==='boot'});
    complete=false;
    if(kind==='sd'){sd=fs;$('reconnected').checked=false;}else if(kind==='boot'){boot=fs;$('reconnected').checked=false;}else{
      backup=fs;backupReady=sdReady=resumeReady=recoveryReady=false;if(engine)engine.journal=null;
      if(await fs.exists(JOURNAL)){const j=JSON.parse(utf8.decode(await fs.read(JOURNAL)));if(j.schema!==1||j.release!==release.id)throw Error('This backup belongs to another release.');getEngine().journal=j;journalState();scanned=true;complete=false;$('reconnected').checked=false;}
    }
    if(kind!=='backup'&&!engine?.journal)scanned=false;
    stage('Folder selected.','Check the radio, or continue a verification/recovery using the same radio and backup.');log('Selected '+kind+': '+fs.name);
  });
};
$('one-radio').onchange=draw;$('reconnected').onchange=draw;
$('scan').onclick=()=>action('Checking the radio…',async()=>{
  if(!demo&&!(await boot.exists('INFO_UF2.TXT')))throw Error('Select the root of EDGETX_UF2.');
  const summary=await getEngine().scan();scanned=true;backupReady=sdReady=complete=false;
  $('plan').hidden=false;$('plan-summary').textContent=summary.operations.length+' file changes · '+summary.files+' existing files · '+(summary.bytes/1048576).toFixed(1)+' MB to back up';
  $('plan-files').replaceChildren();for(const op of summary.operations){const li=document.createElement('li');li.textContent=op.operation.toUpperCase()+'  '+op.path;$('plan-files').append(li);}
  $('plan-notes').replaceChildren();for(const text of summary.notes){const p=document.createElement('p');p.textContent=text;$('plan-notes').append(p);}
  stage('MK3 radio identified.','Choose an empty folder on your computer and make the backup.');log('MK3 board and SD configuration match. No radio files changed.');
});
$('backup').onclick=()=>action('Backing up your radio…',async()=>{
  await getEngine().createBackup();backupReady=true;recoveryReady=true;stage('Backup folder + ZIP verified.','Your original firmware and SD files are saved on your computer. You can now install the SD files.');log('Backup folder and '+engine.journal.archive.path+' verified. Every ZIP entry was reopened and checked. Radio unchanged.');
});
$('install').onclick=()=>action('Installing the SD files…',async()=>{
  await getEngine().install();sdReady=true;stage('SD files verified.','Complete the firmware step, then reconnect for the final check.');$('sd-result').textContent='Installed and readback-verified. Personal files match the backup.';log('SD update verified, including preserved personal files. Firmware remains unchanged.');
});
$('cancel').onclick=()=>{cancel=true;draw();log('Cancellation requested. Waiting for the current file operation to finish.');};
$('firmware').onclick=()=>action('Checking before the firmware copy…',async()=>{
  if(!sdReady)throw Error('Verify the SD installation first.');
  try{
    await getEngine().copyFirmware();
    log('UF2 stream closed. Firmware has NOT yet passed readback verification.');
    stage('UF2 copied — reconnect to verify.',demo?'Simulate a reconnect below, then run the final check.':'Wait for Writing complete on the radio, eject both drives, then reconnect in bootloader mode. Reselect both drives above.');
  }finally{
    if(firmwareAttempted())reconnectRequired();
  }
});
$('demo-reconnect').onclick=()=>{
  if(!demo||!demoDrives||busy)return;
  ({sd,boot}=demoDrives);demoDrives=null;$('reconnected').checked=true;
  stage('Demo radio reconnected.','Run the final check to compare the simulated firmware and all SD files.');
  log('Demo reconnect simulated. No physical USB behavior tested.');draw();
};
$('manual-firmware').onclick=()=>{
  if(demo||busy||!sdReady)return;
  download(files.get('@firmware'),'KSE-2.12.1-KS-MK3.uf2');
  reconnectRequired();stage('Manual firmware copy selected.','Copy the downloaded UF2 to EDGETX_UF2. Wait for Writing complete, eject and reconnect in bootloader mode, reselect both drives, then verify.');draw();
};
$('verify').onclick=()=>action('Verifying installed files and firmware…',async()=>{
  complete=false;draw();
  const result=await getEngine().verifyFinal({reconnected:$('reconnected').checked});backupReady=sdReady=complete=true;
  stage(demo?'Demo complete.':'Installation verified.','Firmware readback and all SD files match. Eject both drives through your computer before restarting the radio.');
  $('final-result').textContent=result.verification.applicationBlocks+' application blocks verified; original bootloader preserved. Radio operation still needs a bench check.';
  log('PASS: SD files, firmware payload and preserved bootloader verified. This is a file check, not a radio/flight test.');
});
$('restore').onclick=()=>{
  if(!confirm('Restore the previous SD program files from this backup? This does not restore firmware.'))return;
  action('Restoring the previous SD files…',async()=>{
    await getEngine().restore();backupReady=sdReady=complete=scanned=false;stage('Previous SD files restored.','The SD matches your backup. Firmware was not changed by the installer.');log('Previous SD files restored and verified.');
  });
};
$('report').onclick=()=>download(encode(JSON.stringify({schema:1,prototype:true,demo,release:release?.id,activities:activity,phase:engine?.journal?.phase||'not-started',verification:engine?.journal?.verification||null},null,2)),'KSE-install-report.json','application/json');
$('demo').onclick=()=>action('Connecting a demo radio…',async()=>{
  const d=await makeDemo();({manifest:release,files,sd,boot,backup}=d);engine=null;scanned=backupReady=sdReady=complete=resumeReady=recoveryReady=false;demo=true;demoDrives=null;$('reconnected').checked=false;$('demo-banner').hidden=false;$('plan').hidden=true;$('one-radio').checked=true;
  $('release-label').textContent='Demo release · no hardware writes';$('release-link').hidden=true;
  stage('Try the installation workflow.','Click Check radio & preview changes. The demo includes existing settings, a saved layout and personal files.');log('Demo uses the same backup, SD install, UF2 copy and verification steps with memory drives only.');
});
$('reset').onclick=()=>location.reload();
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
try{
  const response=await fetch('./release.json',{cache:'no-store'});if(!response.ok)throw Error('Release information is unavailable');release=await response.json();
  if(release.firmwareWriteEnabled!==true)throw Error('This release does not enable the verified UF2 copy step');
  $('release-label').textContent=release.label;$('release-link').href=release.releaseURL;
  if(!supported()){stage('Open this in desktop Chrome or Edge.','This browser cannot access selected drive folders. You can still try the demo.');log('Drive access unavailable in this browser. Demo remains available.');}
}catch(e){message(e.message);stage('Release unavailable.',e.message);}draw();
