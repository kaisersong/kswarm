import {types} from 'node:util';
import {protocolDigest,isProjectProtocolScope} from './project-protocol.js';
import {dshFields as fields,dshClosed as closed,dshFail as fail,dshText as text,dshThread} from './dsh-owner-data.js';
const isProxy=types.isProxy,own=Object.hasOwn,descriptors=Object.getOwnPropertyDescriptors,define=Object.defineProperty,freeze=Object.freeze;
export const DSH_POLICY_AXES=freeze(['mode','mandate','egress','privacy','readonly']);
export const DSH_SCOPE_LEVELS=freeze(['global','tenant','workspace','sourceBinding','mandate']);
export const DSH_LEAF_KINDS=freeze(['source_auth','mandate','egress','readonly']);
function addBindingNames(names){const fixed=['provider','repositoryId','sourceBindingId'];for(let i=0;i<fixed.length;i++)define(names,names.length,{__proto__:null,value:fixed[i],enumerable:true});}
export function dshScopeIdentity(raw){
 const rows=raw&&typeof raw==='object'&&!isProxy(raw)?descriptors(raw):null,kind=rows&&own(rows,'kind')&&own(rows.kind,'value')?rows.kind.value:null;
 const names=['kind'];if(kind!=='global')define(names,names.length,{__proto__:null,value:'tenantId',enumerable:true});if(kind!=='global'&&kind!=='tenant')define(names,names.length,{__proto__:null,value:'workspaceId',enumerable:true});if(kind==='sourceBinding'||kind==='mandate')addBindingNames(names);if(kind==='mandate')define(names,names.length,{__proto__:null,value:'mandateId',enumerable:true});
 if(kind!=='global'&&kind!=='tenant'&&kind!=='workspace'&&kind!=='sourceBinding'&&kind!=='mandate')fail('DSH_SCOPE_INVALID');fields(raw,names);const value=closed(raw);
 for(let i=0;i<names.length;i++)if(!text(value[names[i]]))fail('DSH_SCOPE_INVALID');if((kind==='sourceBinding'||kind==='mandate')&&value.provider!=='github')fail('DSH_SCOPE_INVALID');return value;
}
export function dshScopeKey(scope,identity){if(!isProjectProtocolScope(scope))fail('DSH_SCOPE_INVALID');return'dsh-scope-key:'+protocolDigest(['dsh-trusted-control-scope-v1',scope,dshScopeIdentity(identity)]);}
export function dshScopeChain(scope,rawThread,mandateId){
 const t=dshThread(rawThread);if(!text(mandateId))fail('DSH_SCOPE_INVALID');const identities=[{kind:'global'},{kind:'tenant',tenantId:t.tenantId},{kind:'workspace',tenantId:t.tenantId,workspaceId:t.workspaceId},{kind:'sourceBinding',tenantId:t.tenantId,workspaceId:t.workspaceId,provider:t.provider,repositoryId:t.repositoryId,sourceBindingId:t.sourceBindingId},{kind:'mandate',tenantId:t.tenantId,workspaceId:t.workspaceId,provider:t.provider,repositoryId:t.repositoryId,sourceBindingId:t.sourceBindingId,mandateId}];
 const out=[];for(let i=0;i<identities.length;i++)define(out,i,{__proto__:null,value:closed({scopeKey:dshScopeKey(scope,identities[i]),identity:identities[i]}),enumerable:true});return freeze(out);
}
export const dshPolicyId=(scopeKey,axis)=>'dsh-policy:'+protocolDigest(['dsh-policy-v1',scopeKey,axis]);
export const dshLeafId=(scopeKey,factKind)=>'dsh-leaf:'+protocolDigest(['dsh-authorization-leaf-v1',scopeKey,factKind]);
export function dshModeGuards(scopes,policies){const out=[];for(let i=0;i<scopes.length;i++){const row=policies.get(dshPolicyId(scopes[i].scopeKey,'mode'));if(!row)fail('DSH_BASELINE_UNCONFIRMED');define(out,i,{__proto__:null,value:closed({scopeKey:scopes[i].scopeKey,epoch:row.epoch}),enumerable:true});}return freeze(out);}
export const dshPolicyHash=(axis,value)=>protocolDigest(['dsh-prefix-policy-v1',axis,value]);
export const dshLeafHash=(factKind,value)=>protocolDigest(['dsh-authorization-leaf-v1',factKind,value]);
