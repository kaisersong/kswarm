import {createHub} from '../../../src/core/hub.js';
import {installOwnedDesktopControl} from '../../../src/server/owned-desktop-control.js';
import {createProjectInputAuthority} from '../../../src/core/project-input-authority.js';
import {createSqlitePersistence} from '../../../src/core/sqlite-persistence.js';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const scope={profileId:'a'.repeat(64),workspaceId:'b'.repeat(64)};
let armed=false;const filePath=join(process.env.CONTROL_TEST_ROOT,'state.sqlite');
const persistence=createSqlitePersistence({filePath,sqliteFactory(path){const db=new DatabaseSync(path),exec=db.exec.bind(db);db.exec=sql=>{if(armed&&sql==='COMMIT'&&process.env.CONTROL_TEST_COMMIT_FAULT==='1'){armed=false;let cause=Error('original SQLite fault');for(let i=0;i<7;i++)cause=new Error('actual cause '+i,{cause});throw cause;}const result=exec(sql);if(armed&&sql==='COMMIT'&&process.env.CONTROL_TEST_AFTER_COMMIT_FAULT==='1'){armed=false;try{persistence.close();}catch{}}return result;};return db;}});
const hub=createHub({silent:true,dataDir:{backend:'sqlite',filePath},persistence});armed=process.env.CONTROL_TEST_COMMIT_FAULT==='1'||process.env.CONTROL_TEST_AFTER_COMMIT_FAULT==='1';
if(process.env.CONTROL_TEST_LEGACY_PROJECT==='1')hub.createProject({id:'legacy',name:'Legacy',goal:'kept',poAgent:'po',members:[],autoAssignPo:false});
if(process.env.CONTROL_TEST_HOLD_ACK_CALLBACK==='1'&&process.send){const send=process.send.bind(process);let held=false;process.send=(message,callback)=>send(message,error=>{if(!held&&message.type==='response'){held=true;setTimeout(()=>callback(error),100);}else callback(error);});}
installOwnedDesktopControl({hub,scope});
// The test-only lifecycle is not a control command or a production authority.
process.on('disconnect',()=>{hub.closePersistence();});
