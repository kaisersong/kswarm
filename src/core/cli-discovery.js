import {accessSync,constants,statSync,readdirSync,realpathSync} from 'node:fs';
import {isAbsolute,join,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';

/** Discovery only: inspect a real CLI file; never execute it or parse its name as shell code. */
export function findAgentExecutable(command){
 if(typeof command!=='string'||!command||command.length>32768||/[\0\r\n*?]/.test(command))return null;
 const windows=process.platform==='win32';
 const file=path=>{try{if(!statSync(path).isFile()||windows&&!/\.(?:exe|com|cmd|bat)$/i.test(path))return null;if(!windows)accessSync(path,constants.X_OK);return windows?realpathSync.native(path):path;}catch{return null;}};
 if(isAbsolute(command))return file(command);
 if(/^[-/]/.test(command))return null;
 if(windows){
  // Inspect PATH/PATHEXT directly: where.exe's piped OEM encoding corrupts Unicode paths.
  const extensions=(process.env.PATHEXT??'.COM;.EXE;.BAT;.CMD').split(';').filter(ext=>/^\.(?:com|exe|bat|cmd)$/i.test(ext));
  const names=/\.(?:com|exe|bat|cmd)$/i.test(command)?[command]:extensions.map(ext=>command+ext);
  for(const raw of (process.env.PATH??'').split(delimiter)){const directory=raw.replace(/^"(.*)"$/,'$1');if(!directory)continue;for(const name of names){const found=file(join(directory,name));if(found)return found;}}
  return null;
 }
 try{
  const rows=execFileSync('/usr/bin/which',[command],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).trim().split(/\r?\n/);
  for(const path of rows)if(isAbsolute(path)){const found=file(path);if(found)return found;}
 }catch{/* Keep conventional user locations as the POSIX fallback. */}
 const home=homedir(),nvm=process.env.NVM_DIR||join(home,'.nvm'),candidates=[join('/usr/local/bin',command),join('/opt/homebrew/bin',command),join(home,'.local/bin',command),join(home,'.opencode/bin',command)];
 try{for(const version of readdirSync(join(nvm,'versions/node')))candidates.push(join(nvm,'versions/node',version,'bin',command));}catch{}
 for(const path of candidates){const found=file(path);if(found)return found;}
 return null;
}
