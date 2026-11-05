import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestTools,
  isolatedParameters,
  parameterProjection,
  resultParameters,
} from './execution.mjs';

test('host parameter projection never carries caller validation programs', () => {
  const source = {
    type: 'object',
    properties: {
      text: { type: 'string', pattern: '^(a+)+$' },
      count: { type: 'number', minimum: 1 },
      optional: { type: 'array', uniqueItems: true },
      referenced: { $ref: '#/$defs/value' },
      ['__proto__']: { type: 'boolean' },
    },
    patternProperties: { '^(x+)+$': { type: 'string' } },
    required: ['text', 'count', 'referenced', '__proto__'],
    additionalProperties: false,
    $defs: { value: { type: 'string', minLength: 1 } },
  };

  assert.deepEqual(parameterProjection(source), {
    type: 'object',
    properties: {
      text: { type: ['string'] },
      count: { type: ['number'] },
      referenced: {},
      ['__proto__']: { type: ['boolean'] },
    },
    required: ['text', 'count', 'referenced', '__proto__'],
    additionalProperties: true,
  });
  assert.equal(source.properties.text.pattern, '^(a+)+$');
  assert.equal(source.patternProperties['^(x+)+$'].type, 'string');
  assert.equal(Object.hasOwn(parameterProjection(source).properties, '__proto__'), true);
});

test('host schema adapter advertises only the safe projection and performs only an object check', () => {
  const source = {
    type: 'object',
    properties: { text: { type: 'string', pattern: '^(a+)+$' } },
    required: ['text'],
    additionalProperties: false,
  };
  const parameters = isolatedParameters(source);
  const valueRejectedByCallerSchema = { text: 'not a run of a characters' };

  assert.equal(typeof parameters, 'function');
  assert.strictEqual(parameters(valueRejectedByCallerSchema), valueRejectedByCallerSchema);
  assert.deepEqual(parameters.toJsonSchema(), {
    type: 'object',
    properties: { text: { type: ['string'] } },
    required: ['text'],
    additionalProperties: false,
  });
  assert.throws(() => parameters([]), /must be a JSON object/);
  assert.equal(source.properties.text.pattern, '^(a+)+$');
});

test('rpc_result projection does not rewrite caller reference namespaces', () => {
  const source = {
    $id: 'https://schemas.example.test/result',
    $anchor: 'root',
    $ref: '#/$defs/object',
    $defs: {
      object: {
        type: 'object',
        properties: { next: { $dynamicRef: '#root' } },
      },
    },
  };

  assert.deepEqual(resultParameters(source), {
    type: 'object',
    properties: { result: {} },
    required: ['result'],
    additionalProperties: false,
  });
  assert.equal(source.$id, 'https://schemas.example.test/result');
  assert.equal(source.$ref, '#/$defs/object');
  assert.equal(source.$defs.object.properties.next.$dynamicRef, '#root');
});

test('rpc_result safely projects direct shapes and boolean schemas', () => {
  assert.deepEqual(resultParameters({ type: 'string', pattern: '^(a+)+$' }).properties.result, {
    type: ['string'],
  });
  assert.deepEqual(resultParameters({ type: 'array', uniqueItems: true }).properties.result, {
    type: ['array'],
  });
  assert.deepEqual(resultParameters({ type: 'object', patternProperties: { '^(x+)+$': true } }).properties.result, {
    type: ['object'],
  });
  assert.deepEqual(resultParameters(true).properties.result, {});
  assert.deepEqual(resultParameters(false).properties.result, {});
});

test('rpc_result awaits isolated validation before acknowledging submission', async () => {
  let release;
  const submitted = new Promise(resolve => { release = resolve; });
  let currentChecks = 0;
  const tools = buildRequestTools({
    request: { tools: [], responseMode: 'structured', resultSchema: { type: 'string', pattern: '^ok$' } },
    capabilities: { artifacts: false },
    submitResult: async () => submitted,
  }, () => { currentChecks += 1; });
  const rpcResult = tools.find(tool => tool.name === 'rpc_result');

  let settled = false;
  const execution = rpcResult.execute('call-id', { result: 'ok' }, undefined, undefined).then(value => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release({ accepted: true });
  const result = await execution;

  assert.equal(currentChecks, 2);
  assert.deepEqual(result.details, { accepted: true });
  assert.match(rpcResult.description, /\{"type":"string","pattern":"\^ok\$"\}/);
});

test('isolated validation failures remain correctable model tool errors', async () => {
  const validationError = Object.assign(new Error('input did not match'), {
    status: 422,
    code: 'schema_validation',
    details: { errors: [{ instancePath: '/text', keyword: 'pattern', message: 'must match pattern' }] },
  });
  const tools = buildRequestTools({
    request: {
      tools: [{
        name: 'caller_tool',
        description: 'Call a remote tool.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', pattern: '^ok$' } }, required: ['text'] },
      }],
      responseMode: 'native',
    },
    capabilities: { artifacts: false },
    invokeTool: async () => { throw validationError; },
  }, () => {});

  await assert.rejects(
    tools[0].execute('call-id', { text: 'wrong' }, undefined, undefined),
    error => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'schema_validation');
      assert.strictEqual(error.details, validationError.details);
      assert.match(error.message, /schema_validation: input did not match/);
      assert.match(error.message, /must match pattern/);
      return true;
    },
  );
  assert.match(tools[0].description, /\{"type":"object".*"pattern":"\^ok\$"/);
});
