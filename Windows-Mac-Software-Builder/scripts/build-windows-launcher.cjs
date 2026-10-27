'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const sources=['src/native-launcher/launcher.c','src/native-launcher/launcher.manifest'];
const directory=path.join(root,'dist/native-launcher');
const output=path.join(directory,'windows-launcher.exe');
const proof=path.join(directory,'windows-launcher.json');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHash=crypto.createHash('sha256').update(fs.readFileSync(__filename)).update(sources.map(file=>digest(path.join(root,file))).join('\n')).digest('hex');
function check(){
  const saved=JSON.parse(fs.readFileSync(proof));
  if(saved.sourceSha256!==sourceHash||saved.binarySha256!==digest(output))throw new Error('Native launcher is missing or differs from its current verified sources.');
  const bytes=fs.readFileSync(output);if(bytes.toString('ascii',0,2)!=='MZ'||bytes.readUInt16LE(bytes.readUInt32LE(0x3c)+4)!==0x8664)throw new Error('Native launcher must be Windows x64.');
  return saved;
}
if(process.platform!=='win32')throw new Error('Compile the native launcher on Windows with the Visual Studio C++ tools.');
try{const saved=check();console.log('Reusing exact native launcher:',saved);process.exit(0);}catch(error){if(process.argv.includes('--check'))throw error;}
fs.mkdirSync(directory,{recursive:true});
const programFiles=process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)';
const vswhere=path.join(programFiles,'Microsoft Visual Studio/Installer/vswhere.exe');
const installation=execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8'}).trim();
if(!installation)throw new Error('Visual Studio C++ build tools are unavailable.');
const vcvars=path.join(installation,'Common7/Tools/VsDevCmd.bat');
const environment=execFileSync('cmd.exe',['/d','/s','/c','call "'+vcvars+'" -arch=x64 -host_arch=x64 >nul && set'],{encoding:'utf8',maxBuffer:4*1024**2,windowsVerbatimArguments:true});
const compilerEnv={...process.env};
for(const line of environment.split(/\r?\n/)){const split=line.indexOf('=');if(split>0)compilerEnv[line.slice(0,split)]=line.slice(split+1);}
const compiler=path.join(compilerEnv.VCToolsInstallDir,'bin/Hostx64/x64/cl.exe');
execFileSync(compiler,['/nologo','/utf-8','/O2','/W4','/WX','/MT','/DUNICODE','/D_UNICODE','/Brepro',path.join(root,sources[0]),'/Fo'+path.join(directory,'launcher.obj'),'/Fe'+output,
  '/link','/SUBSYSTEM:WINDOWS','/DYNAMICBASE','/NXCOMPAT','/HIGHENTROPYVA','/MANIFEST:EMBED','/MANIFESTINPUT:'+path.join(root,sources[1]),'kernel32.lib','user32.lib','gdi32.lib','shell32.lib','ole32.lib','uuid.lib','bcrypt.lib','comctl32.lib'],{env:compilerEnv,stdio:'inherit',cwd:directory});
fs.writeFileSync(proof,JSON.stringify({sourceSha256:sourceHash,binarySha256:digest(output),architecture:'windows-x64',staticCrt:true},null,2)+'\n');
console.log('Native launcher compiled and checked:',check());
