import test from 'node:test';
import assert from 'node:assert/strict';
import { resultParameters } from './execution.mjs';

test('rpc_result embeds and rebases the caller schema without rewriting annotations', () => {
  const source = {
    $ref: '#/$defs/object',
    $defs: {
      text: { type: 'string' },
      object: {
        type: 'object',
        properties: {
          title: { $ref: '#/$defs/text' },
          metadata: { const: { $ref: '#/$defs/text' } },
        },
        required: ['title'],
      },
    },
    description: 'References such as #/$defs/text in annotations are not schema references.',
  };

  const parameters = resultParameters(source);

  assert.deepEqual(parameters, {
    type: 'object',
    properties: { result: { $ref: '#/$defs/result' } },
    required: ['result'],
    additionalProperties: false,
    $defs: {
      result: {
        $ref: '#/$defs/result/$defs/object',
        $defs: {
          text: { type: 'string' },
          object: {
            type: 'object',
            properties: {
              title: { $ref: '#/$defs/result/$defs/text' },
              metadata: { const: { $ref: '#/$defs/text' } },
            },
            required: ['title'],
          },
        },
        description: 'References such as #/$defs/text in annotations are not schema references.',
      },
    },
  });
  assert.equal(source.$ref, '#/$defs/object');
  assert.equal(source.$defs.object.properties.title.$ref, '#/$defs/text');
});

test('rpc_result preserves boolean caller schemas', () => {
  assert.deepEqual(resultParameters(true).$defs.result, true);
  assert.deepEqual(resultParameters(false).$defs.result, false);
});
