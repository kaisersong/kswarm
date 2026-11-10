import {IntrinsicMap,IntrinsicSet} from './intrinsic-collections.js';
const freeze=Object.freeze,keys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn;
function deepFreeze(value){if(value&&typeof value==='object'){const names=keys(value);for(let i=0;i<names.length;i++){const row=descriptor(value,names[i]);if(!row||!own(row,'value'))throw Error('HUB_PRODUCER_REGISTRATION_INVALID');deepFreeze(row.value);}freeze(value);}return value;}
/** Original Hub boundary registration. Metadata narrows entry routing; no
 * descriptor replaces the original Source, protocol, state or budget gate. */
export const HUB_PRODUCER_REGISTRATION=deepFreeze({
  "schemaVersion": 1,
  "requiredRuntimeCases": [
    "actual Hub rejects an unregistered alias before the original mutation callback on DSH work",
    "existing original ordinary user creation and mutation remain usable",
    "actual original Hub denies an unregistered new port before its callback",
    "actual original Hub denies an unregistered known port new method before its callback",
    "ordinary-looking arg0 cannot launder an unknown producer with another DSH target",
    "private metadata is the exact original constructor surface and rejects foreign identities without getters"
  ],
  "publicKeys": [
    "serverObservation",
    "planningMigration",
    "migrateDefaultDispatchWriter",
    "createProject",
    "submitTaskResult",
    "setProjectTeamPlan",
    "attachTeamOperationMembers",
    "invalidateTeamPlansForAgent",
    "updateProjectExecutionMode",
    "handleApprove",
    "activateAndStartProject",
    "handleRetryPlan",
    "handleHumanAddTasks",
    "handleCloseProject",
    "deleteProject",
    "handleCreateTasks",
    "handleAssignTask",
    "handleReassignTask",
    "handleRequestDispatch",
    "handleMarkDone",
    "handleRework",
    "handleDeliver",
    "registerFinalDeliverable",
    "approveFinalDeliverable",
    "submitReviewConditionEvidence",
    "resolveReviewConditionEntry",
    "handleSubmitPlan",
    "handleRevisePlan",
    "handleQualityReview",
    "handleAcceptTask",
    "handleProgress",
    "handleWorkerFailure",
    "handleSubmitResult",
    "handleRecoverSubmission",
    "handleResetTaskForRecovery",
    "handleResumeTaskForRecovery",
    "handleSuspendActiveRuns",
    "handleResumeSuspendedRuns",
    "handleTaskFail",
    "handleContinueProject",
    "handleResolveProjectIntervention",
    "createWorkflowProposal",
    "cancelWorkflowProposal",
    "createScriptWorkflowProposal",
    "startWorkflowRunFromProposal",
    "startScriptWorkflowRunFromProposal",
    "beginWorkflowScriptParallelGroup",
    "dispatchWorkflowScriptAgentNode",
    "retryWorkflowScriptAgentNode",
    "completeScriptWorkflowRun",
    "startProjectDiagnoseWorkflow",
    "startAgentReviewSmokeWorkflow",
    "handleWorkflowNodeResult",
    "handleWorkflowNodeReview",
    "handleWorkflowRuntimeUnavailable",
    "handleWorkflowProgressBatch",
    "cancelWorkflowRun",
    "recoverInterruptedTaskWorkflows",
    "readInitialPlanAcceptanceHead",
    "applyOrdinaryTaskMetadataInput",
    "applyOrdinaryProjectInput",
    "readOrdinaryProjectOperation",
    "readOrdinaryProjectFollowupContext",
    "readInitialPlanInputs",
    "claimInitialPlanInputs",
    "voidOrdinaryPlanInput",
    "commitInitialPlan",
    "inspectDefaultDispatchWriter",
    "prepareDshAdmissionOwnerWriter",
    "applyDshWorkModeFence",
    "readDshAdmissionReceiptBasis",
    "readDshDomain",
    "prepareDshOwnerWriter",
    "applyDshScopeFence",
    "applyDshOwnerCommand",
    "applyDshNarrowingCommand",
    "stageDshDraft",
    "commitDshDraft",
    "readDshDraft",
    "prepareDshDraftSlot",
    "readDshOperation",
    "readDshDraftSlot",
    "readDshWork",
    "prepareInitialPlanAcceptanceWriter",
    "prepareFreshInitialPlanAcceptanceWriter",
    "prepareDefaultDispatchWriter",
    "prepareDurableDispatchWriter",
    "prepareDurableDispatchRuntimeWriter",
    "readDefaultDispatchBirths",
    "readDefaultDispatchPlan",
    "captureDefaultDispatchOperation",
    "readDefaultDispatchOperation",
    "readDefaultDispatchChild",
    "prepareOrdinaryTaskInputWriter",
    "getProjectProtocolBinding",
    "checkProjectExecutionStart",
    "readProjectExecutionStart",
    "getProject",
    "mutateProjectState",
    "getProjectActivityIdentity",
    "getWorkspaceProtocolBaseline",
    "applyWorkspaceMapping",
    "getWorkspaceMapping",
    "dispatchWorkspaceTask",
    "submitWorkspaceTaskResult",
    "authorizeWorkspaceDelivery",
    "getBoard",
    "getEventLog",
    "listProjects",
    "findReusableProjectForCreateRequest",
    "getProjectActivity",
    "readScopedProjectActivity",
    "readProjectSourceActivity",
    "subscribeProjectActivity",
    "getRoomEventOutbox",
    "flushRoomEventOutbox",
    "retryRoomEventOutbox",
    "getRoomEventOutboxHealth",
    "listRoomMemberBlockers",
    "getDispatchPlan",
    "getExecutionGraph",
    "getProjectLifecycle",
    "listFinalDeliverables",
    "listReviewGateDecisions",
    "listReviewConditions",
    "getProjectHealth",
    "getProjectGateSnapshot",
    "getProjectIntervention",
    "listResumableScriptWorkflowRuns",
    "deriveScriptWorkflowIntervention",
    "listProjectWorkflowRuns",
    "getWorkflowRun",
    "getHumanActions",
    "persistState",
    "getPersistenceHealth",
    "closePersistence"
  ],
  "ports": {
    "serverObservation": [
      "health",
      "projects",
      "project",
      "tasks",
      "projectListView",
      "projectDetailView",
      "subscribe"
    ],
    "planningMigration": [
      "createProject",
      "readInputs",
      "claim",
      "commit"
    ]
  },
  "mutations": [
    "createProject",
    "submitTaskResult",
    "setProjectTeamPlan",
    "attachTeamOperationMembers",
    "invalidateTeamPlansForAgent",
    "updateProjectExecutionMode",
    "handleApprove",
    "activateAndStartProject",
    "handleRetryPlan",
    "handleHumanAddTasks",
    "handleCloseProject",
    "deleteProject",
    "handleCreateTasks",
    "handleAssignTask",
    "handleReassignTask",
    "handleRequestDispatch",
    "handleMarkDone",
    "handleRework",
    "handleDeliver",
    "registerFinalDeliverable",
    "approveFinalDeliverable",
    "submitReviewConditionEvidence",
    "resolveReviewConditionEntry",
    "handleSubmitPlan",
    "handleRevisePlan",
    "handleQualityReview",
    "handleAcceptTask",
    "handleProgress",
    "handleWorkerFailure",
    "handleSubmitResult",
    "handleRecoverSubmission",
    "handleResetTaskForRecovery",
    "handleResumeTaskForRecovery",
    "handleSuspendActiveRuns",
    "handleResumeSuspendedRuns",
    "handleTaskFail",
    "handleContinueProject",
    "handleResolveProjectIntervention",
    "createWorkflowProposal",
    "cancelWorkflowProposal",
    "createScriptWorkflowProposal",
    "startWorkflowRunFromProposal",
    "startScriptWorkflowRunFromProposal",
    "beginWorkflowScriptParallelGroup",
    "dispatchWorkflowScriptAgentNode",
    "retryWorkflowScriptAgentNode",
    "completeScriptWorkflowRun",
    "startProjectDiagnoseWorkflow",
    "startAgentReviewSmokeWorkflow",
    "handleWorkflowNodeResult",
    "handleWorkflowNodeReview",
    "handleWorkflowRuntimeUnavailable",
    "handleWorkflowProgressBatch",
    "cancelWorkflowRun",
    "recoverInterruptedTaskWorkflows"
  ],
  "executionStart": [
    "handleApprove",
    "activateAndStartProject",
    "handleRequestDispatch",
    "handleRework",
    "handleRetryPlan",
    "startWorkflowRunFromProposal",
    "startScriptWorkflowRunFromProposal",
    "dispatchWorkflowScriptAgentNode",
    "retryWorkflowScriptAgentNode",
    "startProjectDiagnoseWorkflow",
    "startAgentReviewSmokeWorkflow"
  ],
  "recovery": [
    "handleRecoverSubmission",
    "handleResetTaskForRecovery",
    "handleResumeTaskForRecovery",
    "handleResumeSuspendedRuns",
    "recoverInterruptedTaskWorkflows"
  ],
  "migrationSafe": [
    "stageDshDraft",
    "commitDshDraft",
    "readDshDraft",
    "readDshDomain",
    "prepareDshAdmissionOwnerWriter",
    "applyDshWorkModeFence",
    "readDshAdmissionReceiptBasis",
    "prepareDshOwnerWriter",
    "applyDshScopeFence",
    "applyDshOwnerCommand",
    "applyDshNarrowingCommand",
    "prepareDshDraftSlot",
    "readDshOperation",
    "readDshDraftSlot",
    "readDshWork",
    "inspectDefaultDispatchWriter",
    "prepareInitialPlanAcceptanceWriter",
    "prepareFreshInitialPlanAcceptanceWriter",
    "prepareDefaultDispatchWriter",
    "prepareDurableDispatchRuntimeWriter",
    "prepareOrdinaryTaskInputWriter",
    "readInitialPlanInputs",
    "readInitialPlanAcceptanceHead",
    "getProjectProtocolBinding",
    "checkProjectExecutionStart",
    "readProjectExecutionStart",
    "readDefaultDispatchChild",
    "flushRoomEventOutbox",
    "retryRoomEventOutbox"
  ],
  "restoreProtocols": [
    "room_workspace_v1",
    "dsh_owner_v1",
    "dsh_owner_admission_v1"
  ],
  "ordinarySpecialMutations": [
    "mutateProjectState",
    "dispatchWorkspaceTask",
    "applyWorkspaceMapping",
    "submitWorkspaceTaskResult"
  ],
  "requirementRefs": [
    "plan-block:0504",
    "plan-block:0604",
    "plan-block:0649"
  ],
  "positiveTests": [
    "test/hub-producer-registration.test.js",
    "test/project-protocol-create.test.js"
  ],
  "negativeTests": [
    "test/hub-producer-registration.test.js",
    "test/dsh-owner-foundation.test.js"
  ],
  "producers": [
    {
      "name": "serverObservation",
      "surfaces": [
        "public"
      ],
      "target": "none",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "planningMigration",
      "surfaces": [
        "public"
      ],
      "target": "none",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "migrateDefaultDispatchWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "createProject",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "submitTaskResult",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "setProjectTeamPlan",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "attachTeamOperationMembers",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "invalidateTeamPlansForAgent",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "updateProjectExecutionMode",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleApprove",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "kswarm_direct",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "activateAndStartProject",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "kswarm_direct",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleRetryPlan",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "kswarm_direct",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleHumanAddTasks",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleCloseProject",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "deleteProject",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleCreateTasks",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleAssignTask",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleReassignTask",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleRequestDispatch",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "kswarm_direct",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleMarkDone",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleRework",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "kswarm_direct",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleDeliver",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "registerFinalDeliverable",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "approveFinalDeliverable",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "submitReviewConditionEvidence",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "resolveReviewConditionEntry",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleSubmitPlan",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleRevisePlan",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleQualityReview",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleAcceptTask",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleProgress",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleWorkerFailure",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleSubmitResult",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleRecoverSubmission",
      "surfaces": [
        "public",
        "mutation",
        "recovery"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleResetTaskForRecovery",
      "surfaces": [
        "public",
        "mutation",
        "recovery"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleResumeTaskForRecovery",
      "surfaces": [
        "public",
        "mutation",
        "recovery"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleSuspendActiveRuns",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleResumeSuspendedRuns",
      "surfaces": [
        "public",
        "mutation",
        "recovery"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleTaskFail",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleContinueProject",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleResolveProjectIntervention",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "createWorkflowProposal",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "cancelWorkflowProposal",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "workflow_proposal_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "createScriptWorkflowProposal",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "startWorkflowRunFromProposal",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "workflow_proposal_arg0",
      "dsh": "deny",
      "executionClass": "workflow_root",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "startScriptWorkflowRunFromProposal",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "workflow_proposal_arg0",
      "dsh": "deny",
      "executionClass": "workflow_root",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "beginWorkflowScriptParallelGroup",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "workflow_run_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "dispatchWorkflowScriptAgentNode",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "workflow_run_arg0",
      "dsh": "deny",
      "executionClass": "workflow_root",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "retryWorkflowScriptAgentNode",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "workflow_run_arg0",
      "dsh": "deny",
      "executionClass": "workflow_root",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "completeScriptWorkflowRun",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "workflow_run_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "startProjectDiagnoseWorkflow",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "workflow_root",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "startAgentReviewSmokeWorkflow",
      "surfaces": [
        "public",
        "mutation",
        "execution_start"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "workflow_root",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleWorkflowNodeResult",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "object_workflow_run_id",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleWorkflowNodeReview",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "object_workflow_run_id",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleWorkflowRuntimeUnavailable",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "object_workflow_run_id",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "handleWorkflowProgressBatch",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "workflow_run_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "cancelWorkflowRun",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "workflow_run_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "recoverInterruptedTaskWorkflows",
      "surfaces": [
        "public",
        "mutation",
        "recovery"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readInitialPlanAcceptanceHead",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyOrdinaryTaskMetadataInput",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyOrdinaryProjectInput",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readOrdinaryProjectOperation",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readOrdinaryProjectFollowupContext",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readInitialPlanInputs",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "claimInitialPlanInputs",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "voidOrdinaryPlanInput",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "commitInitialPlan",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "inspectDefaultDispatchWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareDshAdmissionOwnerWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyDshWorkModeFence",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDshAdmissionReceiptBasis",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDshDomain",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareDshOwnerWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyDshScopeFence",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyDshOwnerCommand",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyDshNarrowingCommand",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "stageDshDraft",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "commitDshDraft",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDshDraft",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareDshDraftSlot",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDshOperation",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDshDraftSlot",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDshWork",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareInitialPlanAcceptanceWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareFreshInitialPlanAcceptanceWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareDefaultDispatchWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareDurableDispatchWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareDurableDispatchRuntimeWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDefaultDispatchBirths",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDefaultDispatchPlan",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "captureDefaultDispatchOperation",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDefaultDispatchOperation",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readDefaultDispatchChild",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "prepareOrdinaryTaskInputWriter",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_owner",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectProtocolBinding",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "checkProjectExecutionStart",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readProjectExecutionStart",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProject",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "mutateProjectState",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectActivityIdentity",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getWorkspaceProtocolBaseline",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "applyWorkspaceMapping",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getWorkspaceMapping",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "dispatchWorkspaceTask",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "submitWorkspaceTaskResult",
      "surfaces": [
        "public",
        "mutation"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "authorizeWorkspaceDelivery",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getBoard",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getEventLog",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listProjects",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "findReusableProjectForCreateRequest",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectActivity",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readScopedProjectActivity",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "readProjectSourceActivity",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "subscribeProjectActivity",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getRoomEventOutbox",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "flushRoomEventOutbox",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "retryRoomEventOutbox",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getRoomEventOutboxHealth",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listRoomMemberBlockers",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getDispatchPlan",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getExecutionGraph",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectLifecycle",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listFinalDeliverables",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listReviewGateDecisions",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listReviewConditions",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectHealth",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectGateSnapshot",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getProjectIntervention",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listResumableScriptWorkflowRuns",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "deriveScriptWorkflowIntervention",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "listProjectWorkflowRuns",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getWorkflowRun",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getHumanActions",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "persistState",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "getPersistenceHealth",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "closePersistence",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.health",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.projects",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.project",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.tasks",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.projectListView",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.projectDetailView",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "serverObservation.subscribe",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "original_reader",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "planningMigration.createProject",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "planningMigration.readInputs",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "planningMigration.claim",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    },
    {
      "name": "planningMigration.commit",
      "surfaces": [
        "public"
      ],
      "target": "project_arg0",
      "dsh": "deny",
      "executionClass": "control",
      "requirementRefs": [
        "plan-block:0504",
        "plan-block:0604",
        "plan-block:0649"
      ],
      "positiveTests": [
        "test/hub-producer-registration.test.js"
      ],
      "negativeTests": [
        "test/hub-producer-registration.test.js",
        "test/dsh-owner-foundation.test.js"
      ]
    }
  ]
});
const byName=new IntrinsicMap();
for(let i=0;i<HUB_PRODUCER_REGISTRATION.producers.length;i++){const row=HUB_PRODUCER_REGISTRATION.producers[i];if(byName.has(row.name))throw Error('HUB_PRODUCER_REGISTRATION_DUPLICATE');byName.set(row.name,row);}
export function readHubProducerDescriptor(name){return typeof name==='string'?byName.get(name)??null:null;}
