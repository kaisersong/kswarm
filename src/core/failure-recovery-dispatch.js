export function failureRecoveryTaskIds(result = {}) {
  const taskIds = [];
  if (result.retryDispatched === true && isTaskId(result.retryTaskId)) {
    taskIds.push(result.retryTaskId.trim());
  }
  if (result.replacementDispatched === true && isTaskId(result.taskId)) {
    taskIds.push(result.taskId.trim());
  }
  return [...new Set(taskIds)];
}

function isTaskId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
