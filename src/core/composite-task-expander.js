import { enrichTaskWithExecutionContract } from './execution-contract.js';

export function expandCompositeTasks(taskList = [], context = {}) {
  const expanded = [];
  const composites = [];

  for (const task of taskList) {
    if (!isCompositeTask(task)) {
      expanded.push(enrichTaskWithExecutionContract(task));
      continue;
    }

    const reviewer = chooseReviewer(task, context);
    if (!reviewer) {
      return {
        ok: false,
        error: 'no_independent_reviewer',
        taskId: task.id,
        assignedAgent: task.assignedAgent || null,
      };
    }

    const parentId = task.id;
    const draftId = `${parentId}-draft`;
    const reviewId = `${parentId}-review`;
    const finalId = `${parentId}-final`;
    const dependencies = Array.isArray(task.dependencies) ? [...task.dependencies] : [];

    const parent = enrichTaskWithExecutionContract({
      ...task,
      assignedAgent: null,
      dependencies,
      isCompositeParent: true,
      childTaskIds: [draftId, reviewId, finalId],
      compositeStatus: 'waiting_children',
    });
    const draft = enrichTaskWithExecutionContract({
      ...task,
      id: draftId,
      title: `${task.title || parentId} - 初稿`,
      assignedAgent: task.assignedAgent || null,
      dependencies,
      parentTaskId: parentId,
      compositeRole: 'draft',
      composite: false,
    });
    const review = enrichTaskWithExecutionContract({
      id: reviewId,
      title: `${task.title || parentId} - 独立评审`,
      brief: task.reviewBrief || `独立评审 ${task.title || parentId} 的初稿产物，输出 review-evidence.json。`,
      assignedAgent: reviewer,
      dependencies: [draftId],
      parentTaskId: parentId,
      reviewOfTaskId: draftId,
      compositeRole: 'review',
      phaseId: task.phaseId,
      planItemId: `${task.planItemId || task.id}-review`,
      maxQualityReworks: task.maxQualityReworks ?? 1,
    });
    const final = enrichTaskWithExecutionContract({
      ...task,
      id: finalId,
      title: `${task.title || parentId} - 终版`,
      brief: task.finalBrief || `根据独立评审意见整合 ${task.title || parentId} 的终版产物。`,
      assignedAgent: task.assignedAgent || null,
      dependencies: [reviewId],
      parentTaskId: parentId,
      compositeRole: 'final',
      composite: false,
    });

    expanded.push(parent, draft, review, final);
    composites.push({ parentId, childTaskIds: parent.childTaskIds, reviewer });
  }

  return { ok: true, tasks: expanded, composites };
}

function isCompositeTask(task = {}) {
  return task.composite === true || task.type === 'composite' || task.requiresIndependentReview === true;
}

function chooseReviewer(task = {}, context = {}) {
  if (task.reviewAgent && task.reviewAgent !== task.assignedAgent) return task.reviewAgent;
  const members = (context.members || [])
    .map(member => typeof member === 'string' ? member : member?.id)
    .filter(Boolean);
  return members.find(member => member !== task.assignedAgent && member !== context.poAgent) || null;
}
