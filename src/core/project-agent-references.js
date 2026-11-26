const isArray=Array.isArray,NativeSet=Set;
const some=Function.prototype.call.bind(Array.prototype.some),has=Function.prototype.call.bind(Set.prototype.has);
/** Shared original membership semantics. The fixed Server collector admits only
 * data arrays; the generic legacy entry retains its older iterable ABI. */
export function projectReferencesAgent(project,agentId){
 const members=project.members||[],roles=project.teamPlan?.roles||[];
 if(!isArray(members)||!isArray(roles)){
  const ids=new NativeSet([project.poAgent,...members]),preferred=roles.some(role=>role.preferredExistingAgentId===agentId);
  return has(ids,agentId)||preferred;
 }
 let member=project.poAgent===agentId;for(let i=0;i<members.length;i++)if(members[i]===agentId)member=true;
 const preferred=some(roles,role=>role.preferredExistingAgentId===agentId);return member||preferred;
}
export function assertClosedProjectAgentReferences(project){
 if(!isArray(project.members||[])||!isArray(project.teamPlan?.roles||[]))throw Error('SERVER_AGENT_INPUT_UNVERIFIED');
}
