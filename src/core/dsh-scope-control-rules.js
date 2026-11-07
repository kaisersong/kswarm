import {IntrinsicSet} from './intrinsic-collections.js';
import {protocolDigest} from './project-protocol.js';
import {dshFields as fields,dshClosed as closed,dshFail as fail,dshText as text,dshHash as hash,dshRevision as revision,dshAuthScope} from './dsh-owner-data.js';
import {DSH_POLICY_AXES as axes,DSH_LEAF_KINDS as leafKinds,dshScopeIdentity,dshScopeKey,dshScopeChain,dshPolicyId,dshLeafId,dshModeGuards,dshPolicyHash,dshLeafHash} from './dsh-scope-control-data.js';
const keys=Reflect.ownKeys,finite=Number.isFinite,define=Object.defineProperty,isArray=Array.isArray,freeze=Object.freeze,parse=Date.parse;
const add=(array,value)=>define(array,array.length,{__proto__:null,value,enumerable:true,writable:true,configurable:true});
const has=(array,value)=>{for(let i=0;i<array.length;i++)if(array[i]===value)return true;return false;};
const same=(a,b)=>{if(protocolDigest(a)!==protocolDigest(b))fail('DSH_CONTROL_CONFLICT');};
const future=value=>typeof value==='string'&&finite(parse(value));
const leafLevel=kind=>kind==='source_auth'?3:4;
/** Same original heads/receipts. This child computes preparations only; the
 * original acceptance stage is the sole place that applies the returned rows. */
export function createDshScopeControlRules({heads,receipts,record}){
 function policyValue(axis,value){
  if(axis==='mode'){fields(value,['mode']);if(value.mode!=='off'&&value.mode!=='observe'&&value.mode!=='auto_draft')fail('DSH_SCOPE_POLICY_INVALID');}
  else{fields(value,['allowed','restriction']);if(typeof value.allowed!=='boolean'||value.restriction!==null)fail('DSH_SCOPE_POLICY_UNSUPPORTED');}
 }
 function leafValue(kind,value,identity){
  if(kind==='source_auth'){
   fields(value,['authScope','sourceBindingVersion','roleMappingVersion','provenanceVersion','status','attestationRef']);
   // This is the actual sourceBinding leaf, not an AuthScope on shared global cells.
   dshAuthScope(value.authScope,identity);if(identity.kind!=='sourceBinding'||!revision(value.sourceBindingVersion)||!revision(value.roleMappingVersion)||!revision(value.provenanceVersion)||(value.status!=='active'&&value.status!=='revoked')||!text(value.attestationRef))fail('DSH_AUTHORIZATION_LEAF_INVALID');
  }else if(kind==='mandate'){
   const names=['schemaVersion','mandateId','sourceBindingId','revision','authorizationEpoch','status','issuedByUserId','allowedActorProviderIds','allowedActions','ruleVersion','selection','validUntil','maxInputBytes','budgetRef','limits','dataEgressPolicyRef','ownerDomains','ownerDomainsHash','followup'];fields(value,names);
   if(identity.kind!=='mandate'||value.schemaVersion!==1||value.mandateId!==identity.mandateId||value.sourceBindingId!==identity.sourceBindingId||!revision(value.revision)||!revision(value.authorizationEpoch)||(value.status!=='active'&&value.status!=='revoked'&&value.status!=='expired')||!text(value.issuedByUserId)||!text(value.budgetRef)||!future(value.validUntil)||!revision(value.maxInputBytes)||value.ruleVersion!=='github_issue_draft_v1'||!text(value.dataEgressPolicyRef)||!hash(value.ownerDomainsHash))fail('DSH_AUTHORIZATION_LEAF_INVALID');
   if(!isArray(value.allowedActorProviderIds)||!value.allowedActorProviderIds.length||!isArray(value.allowedActions)||!value.allowedActions.length||!isArray(value.ownerDomains)||!value.ownerDomains.length)fail('DSH_AUTHORIZATION_LEAF_INVALID');
   for(let i=0;i<value.allowedActorProviderIds.length;i++)if(!text(value.allowedActorProviderIds[i]))fail('DSH_AUTHORIZATION_LEAF_INVALID');
   const allowed=['source.read','model.process_source','local.draft.create','local.draft.revise'];for(let i=0;i<value.allowedActions.length;i++)if(!has(allowed,value.allowedActions[i]))fail('DSH_AUTHORIZATION_LEAF_INVALID');
   const selectionKeys=keys(value.selection);if(selectionKeys.length!==1||(selectionKeys[0]!=='issueIds'&&selectionKeys[0]!=='labelIds'))fail('DSH_AUTHORIZATION_LEAF_INVALID');const selected=value.selection[selectionKeys[0]];if(!isArray(selected)||!selected.length)fail('DSH_AUTHORIZATION_LEAF_INVALID');for(let i=0;i<selected.length;i++)if(!text(selected[i]))fail('DSH_AUTHORIZATION_LEAF_INVALID');
   fields(value.limits,['maxActiveWorks','maxDraftRunsPerWork','maxTokens','maxCostMinor','currency','executionDeadline']);const limitNames=['maxActiveWorks','maxDraftRunsPerWork','maxTokens','maxCostMinor'];for(let i=0;i<limitNames.length;i++)if(!revision(value.limits[limitNames[i]]))fail('DSH_AUTHORIZATION_LEAF_INVALID');if(!text(value.limits.currency)||!future(value.limits.executionDeadline))fail('DSH_AUTHORIZATION_LEAF_INVALID');
   for(let i=0;i<value.ownerDomains.length;i++){const row=value.ownerDomains[i];fields(row,['domainId','kind']);if(!text(row.domainId)||(row.kind!=='work'&&row.kind!=='egress_gate'&&row.kind!=='active_pointer'))fail('DSH_AUTHORIZATION_LEAF_INVALID');}
   if(value.ownerDomainsHash!==protocolDigest(['dsh-owner-domains-v1',value.ownerDomains]))fail('DSH_AUTHORIZATION_LEAF_INVALID');fields(value.followup,['enabled','observationEndsAt','completionPredicate','resumeAfterCompletion']);if(typeof value.followup.enabled!=='boolean'||!future(value.followup.observationEndsAt)||value.followup.completionPredicate!=='draft_ready'||value.followup.resumeAfterCompletion!==false)fail('DSH_AUTHORIZATION_LEAF_INVALID');
  }else if(kind==='egress'){
   fields(value,['policyRef','policyHash','provider','destinationRef','purposes','enabled']);if(identity.kind!=='mandate'||!text(value.policyRef)||!hash(value.policyHash)||!text(value.provider)||!text(value.destinationRef)||!isArray(value.purposes)||!value.purposes.length||typeof value.enabled!=='boolean')fail('DSH_AUTHORIZATION_LEAF_INVALID');for(let i=0;i<value.purposes.length;i++)if(value.purposes[i]!=='admission'&&value.purposes[i]!=='preview'&&value.purposes[i]!=='draft')fail('DSH_AUTHORIZATION_LEAF_INVALID');
  }else if(kind==='readonly'){
   fields(value,['executionProfile','schemaVersion','snapshotHash','snapshotPolicyDigest','approvalRef']);if(identity.kind!=='mandate'||value.executionProfile!=='model_text_only_v1'&&value.executionProfile!=='dsh_readonly_v1'||value.schemaVersion!==(value.executionProfile==='model_text_only_v1'?1:2))fail('DSH_AUTHORIZATION_LEAF_INVALID');
   if(value.executionProfile==='model_text_only_v1'){if(value.snapshotHash!==null||value.snapshotPolicyDigest!==null||value.approvalRef!==null)fail('DSH_AUTHORIZATION_LEAF_INVALID');}
   else if(value.snapshotHash!==null&&!hash(value.snapshotHash)||value.snapshotPolicyDigest!==null&&!hash(value.snapshotPolicyDigest)||value.approvalRef!==null&&!text(value.approvalRef))fail('DSH_AUTHORIZATION_LEAF_INVALID');
  }else fail('DSH_AUTHORIZATION_LEAF_INVALID');
 }
 function references(value,allowMissing=false){
  const scopes=dshScopeChain(value.scope,value.thread,value.mandateId),policies=[],leaves=[],expectation=[];let missing=false;
  for(let si=0;si<scopes.length;si++)for(let ai=0;ai<axes.length;ai++){
   const scope=scopes[si],axis=axes[ai],id=dshPolicyId(scope.scopeKey,axis),row=heads.get(id);add(expectation,id);
   if(!row){missing=true;continue;}policyValue(axis,row.value);add(policies,{scopeKey:scope.scopeKey,axis,epoch:row.epoch,canonicalHash:row.canonicalHash,controlRevision:row.revision});
  }
  for(let i=0;i<leafKinds.length;i++){const kind=leafKinds[i],scope=scopes[leafLevel(kind)],id=dshLeafId(scope.scopeKey,kind),row=heads.get(id);add(expectation,id);if(!row){missing=true;continue;}leafValue(kind,row.value,scope.identity);add(leaves,{id,epoch:row.epoch,canonicalHash:row.canonicalHash,controlRevision:row.revision});}
  if(missing&&!allowMissing)fail('DSH_BASELINE_UNCONFIRMED');
  return{scopes,policies,leaves,expectation,missing};
 }
 function baseline(value,requireAuth){
  const refs=references(value),mode=dshModeGuards(refs.scopes,heads),facts={__proto__:null};
  for(let i=0;i<leafKinds.length;i++){const kind=leafKinds[i];facts[kind]=heads.get(dshLeafId(refs.scopes[leafLevel(kind)].scopeKey,kind));}
  if(requireAuth)same(facts.source_auth.value.authScope,value.authScope);
  return{...refs,mode,facts};
 }
 function validateRecord(row){
  fields(row,['kind','id','projectId','schemaVersion','contract','scope','writerStoreId','scopeKey','identity',row.kind==='dsh_scope_control'?'axis':'factKind','epoch','revision','canonicalHash','value','authorityRef','recordDigest']);
  const identity=dshScopeIdentity(row.identity),scopeKey=dshScopeKey(row.scope,identity);if(row.projectId!==null||row.scopeKey!==scopeKey||!revision(row.epoch)||!revision(row.revision)||!text(row.authorityRef))fail('DSH_AUTHORITY_SUSPECT');
  if(row.kind==='dsh_scope_control'){if(!has(axes,row.axis)||row.id!==dshPolicyId(scopeKey,row.axis)||row.canonicalHash!==dshPolicyHash(row.axis,row.value))fail('DSH_AUTHORITY_SUSPECT');policyValue(row.axis,row.value);}
  else{if(!has(leafKinds,row.factKind)||row.id!==dshLeafId(scopeKey,row.factKind)||row.canonicalHash!==dshLeafHash(row.factKind,row.value))fail('DSH_AUTHORITY_SUSPECT');leafValue(row.factKind,row.value,identity);}
 }
 function prepare(value){
  const names=value.type==='policy'?['scope','type','identity','axis','epoch','value','authorityRef']:['scope','type','identity','factKind','epoch','value','authorityRef'];fields(value,names);const identity=dshScopeIdentity(value.identity),scopeKey=dshScopeKey(value.scope,identity);if(!revision(value.epoch)||!text(value.authorityRef))fail('DSH_SCOPE_CONTROL_INVALID');
  const policy=value.type==='policy',axis=policy?value.axis:value.factKind;if(policy){if(!has(axes,axis))fail('DSH_SCOPE_CONTROL_INVALID');policyValue(axis,value.value);}else{if(value.type!=='leaf'||!has(leafKinds,axis))fail('DSH_SCOPE_CONTROL_INVALID');leafValue(axis,value.value,identity);}
  const id=policy?dshPolicyId(scopeKey,axis):dshLeafId(scopeKey,axis),canonicalHash=policy?dshPolicyHash(axis,value.value):dshLeafHash(axis,value.value),old=heads.get(id);
  if(old){if(value.epoch<old.epoch)fail('DSH_CONTROL_STALE');if(value.epoch===old.epoch){if(old.canonicalHash!==canonicalHash||old.authorityRef!==value.authorityRef)fail('DSH_CONTROL_CONFLICT');return{old,records:[],response:closed({ok:true,control:old})};}}
  if(!policy&&axis==='mandate'&&value.value.status==='active'){for(const row of heads.values())if(row.kind==='dsh_authorization_leaf'&&row.factKind==='mandate'&&row.id!==id&&row.value.status==='active'&&row.identity.tenantId===identity.tenantId&&row.identity.workspaceId===identity.workspaceId&&row.identity.provider===identity.provider&&row.identity.repositoryId===identity.repositoryId&&row.identity.sourceBindingId===identity.sourceBindingId)fail('DSH_MANDATE_OVERLAP');}
  const row=record(policy?'dsh_scope_control':'dsh_authorization_leaf',id,null,value,{scopeKey,identity,...(policy?{axis}:{factKind:axis}),epoch:value.epoch,revision:old?old.revision+1:1,canonicalHash,value:value.value,authorityRef:value.authorityRef});
  const records=[['protocolHead',row]],narrow=policy?(axis==='mode'?value.value.mode!=='auto_draft':!value.value.allowed):axis==='source_auth'?value.value.status!=='active'||old&&old.canonicalHash!==canonicalHash:axis==='mandate'?value.value.status!=='active'||old&&old.canonicalHash!==canonicalHash:axis==='egress'?!value.value.enabled||old&&old.canonicalHash!==canonicalHash:old&&old.value.snapshotHash!==null&&value.value.snapshotHash===null;
  if(narrow){for(const binding of receipts.values())if(binding.kind==='dsh_binding'){
   const scopes=dshScopeChain(binding.scope,binding.thread,binding.mandateId);let match=false;for(let i=0;i<scopes.length;i++)if(scopes[i].scopeKey===scopeKey)match=true;if(!match)continue;
   const control=heads.get(binding.projectId+':control');if(!control)fail('DSH_AUTHORITY_SUSPECT');const body={...control};delete body.recordDigest;
   body.revision++;body.ownerVersion++;body.generationClosed=true;body.stopped=true;body.currentDraftValid=false;body.closingFence={id:row.id,epoch:row.epoch,canonicalHash:row.canonicalHash};add(records,['protocolHead',record('dsh_control',body.id,body.projectId,body,body)]);
  }}
  return{row,records,response:closed({ok:true,control:row})};
 }
 function generating(value,baseline,time,requiredAction){
  same(value.modeGuards,baseline.mode);fields(value.controlGuards,['policies','leaves']);same(value.controlGuards.policies,baseline.policies);same(value.controlGuards.leaves,baseline.leaves);
  for(let si=0;si<baseline.scopes.length;si++)for(let ai=0;ai<axes.length;ai++){const row=heads.get(dshPolicyId(baseline.scopes[si].scopeKey,axes[ai]));if(axes[ai]==='mode'?row.value.mode!=='auto_draft':!row.value.allowed)fail('DSH_SCOPE_POLICY_BLOCKED');}
  const facts=baseline.facts,mandate=facts.mandate.value;if(facts.source_auth.value.status!=='active'||mandate.status!=='active'||mandate.mandateId!==value.mandateId||mandate.revision!==value.mandateRevision||mandate.authorizationEpoch!==value.authorizationEpoch||parse(mandate.validUntil)<=time||parse(mandate.limits.executionDeadline)<=time||parse(value.executionDeadline)>parse(mandate.limits.executionDeadline)||!facts.egress.value.enabled||!has(facts.egress.value.purposes,'draft')||mandate.dataEgressPolicyRef!==facts.egress.value.policyRef)fail('DSH_AUTHORITY_BLOCKED');
  if(requiredAction!=='local.draft.create'&&requiredAction!=='local.draft.revise')fail('DSH_AUTHORITY_BLOCKED');
  if(!has(mandate.allowedActions,requiredAction)||!has(mandate.allowedActions,'source.read')||!has(mandate.allowedActions,'model.process_source'))fail('DSH_AUTHORITY_BLOCKED');
  if(facts.readonly.value.executionProfile!==value.executionProfile)fail('DSH_EXECUTION_PROFILE_UNSUPPORTED');if(value.executionProfile==='dsh_readonly_v1'&&(!hash(facts.readonly.value.snapshotHash)||!hash(facts.readonly.value.snapshotPolicyDigest)||!text(facts.readonly.value.approvalRef)))fail('DSH_READONLY_SNAPSHOT_REQUIRED');
  if(value.egressGuard.policyRef!==facts.egress.value.policyRef||value.egressGuard.epoch!==facts.egress.epoch||value.egressGuard.policyHash!==facts.egress.value.policyHash)fail('DSH_EGRESS_CONFLICT');
  return mandate;
 }
 function assertExpectation(value,expected){const refs=references(value,true);if(!isArray(expected)||expected.length!==refs.expectation.length)fail('DSH_AUTHORITY_SUSPECT');for(let i=0;i<expected.length;i++)if(expected[i]!==refs.expectation[i]||!heads.has(expected[i]))fail('DSH_AUTHORITY_SUSPECT');}
 return freeze({prepare,baseline,references,validateRecord,generating,assertExpectation});
}
