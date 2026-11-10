import {build} from 'esbuild';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await build({absWorkingDir:root,entryPoints:['dist/server.js'],outfile:'dist/server.bundle.js',bundle:true,platform:'node',format:'esm',packages:'bundle',external:['node:*'],banner:{js:"import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"}});
