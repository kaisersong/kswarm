/** Legacy run journals must not become a second owner of v1 claim recovery. */
export async function recoverProjectsIndependently({projects,recoverProject,onDeferred=()=>{},onError=()=>{}}){
 for(const project of projects){
  if(project.status!=='active')continue;
  if(project.requiredProtocol==='room_workspace_v1'){
   onDeferred(project,project.workspaceMapping?.state==='active'?'workspace_desktop_recovery_owner':'workspace_mapping_required');
   continue;
  }
  try{await recoverProject(project);}catch(error){onError(project,error);}
 }
}
