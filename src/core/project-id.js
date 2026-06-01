import { randomUUID } from 'node:crypto';

export function createProjectInstanceId() {
  return `proj-${randomUUID()}`;
}
