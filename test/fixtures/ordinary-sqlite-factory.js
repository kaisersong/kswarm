// Business rollback fixtures use an explicitly ordinary connection only.
// A generated runtime/Native authority is a different acceptance environment.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readOriginalSqliteAuthority} from '../../src/core/original-sqlite-authority.js';
import {readOriginalSqliteSourceRuntime} from '../../src/core/original-sqlite-source-runtime.js';
export function ordinarySqliteFactory(path){
 assert.equal(readOriginalSqliteAuthority(),null,'fixture requires standalone ordinary authority absence');
 assert.equal(readOriginalSqliteSourceRuntime(),null,'fixture requires standalone runtime absence');
 return new DatabaseSync(path);
}
