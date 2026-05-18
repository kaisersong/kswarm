/**
 * KSwarm — artifact block extraction tests
 *
 * Run: node test/artifact-extractor.test.js
 */

import assert from 'node:assert/strict';
import { extractDeclaredArtifacts } from '../src/core/artifact-extractor.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('extracts declared artifact blocks and removes them from report content', () => {
  const input = `# Work summary

Here is the work.

~~~artifact path=story_revised_v2.md
# Story

This is the revised story.
~~~

More notes.

\`\`\`artifact path=data/raw-trends.json
{"items":[{"name":"exports","value":42}]}
\`\`\`
`;

  const result = extractDeclaredArtifacts(input, { taskId: 'task-1' });

  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[0].filename, 'story_revised_v2.md');
  assert.match(result.artifacts[0].content, /This is the revised story/);
  assert.equal(result.artifacts[1].filename, 'raw-trends.json');
  assert.match(result.artifacts[1].content, /"exports"/);
  assert.doesNotMatch(result.cleanedContent, /artifact path=/);
  assert.match(result.cleanedContent, /Here is the work/);
  assert.match(result.cleanedContent, /More notes/);
});

test('sanitizes unsafe artifact filenames', () => {
  const input = `~~~artifact path=../../.secret/../report<draft>.csv
a,b
1,2
~~~`;

  const result = extractDeclaredArtifacts(input, { taskId: 'task-unsafe' });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, 'report_draft_.csv');
});

test('deduplicates artifact filenames without losing content', () => {
  const input = `~~~artifact path=result.md
one
~~~

~~~artifact path=result.md
two
~~~`;

  const result = extractDeclaredArtifacts(input, { taskId: 'task-dupe' });

  assert.deepEqual(result.artifacts.map(a => a.filename), ['result.md', 'result-2.md']);
  assert.equal(result.artifacts[0].content, 'one');
  assert.equal(result.artifacts[1].content, 'two');
});

test('extracts a trailing unclosed artifact block to EOF', () => {
  const input = `Summary before file.

~~~artifact path=story.md
# Story

The model forgot to close the fence.`;

  const result = extractDeclaredArtifacts(input, { taskId: 'task-unclosed' });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, 'story.md');
  assert.match(result.artifacts[0].content, /forgot to close/);
  assert.doesNotMatch(result.cleanedContent, /artifact path=/);
  assert.match(result.cleanedContent, /Summary before file/);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) {
  console.log(`\n${passed}/${tests.length} artifact extractor tests passed`);
}
