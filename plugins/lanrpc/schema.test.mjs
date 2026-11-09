import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, compileSchema, prepareRequest, validateJson } from './schema.mjs';
import { LIMITS } from './protocol.mjs';

const IDENTITY = {
  instanceId: '123e4567-e89b-12d3-a456-426614174000',
  generation: 7,
  requestId: 'request_1',
};

function nativeRequest(overrides = {}) {
  return { ...IDENTITY, message: 'Do the work.', ...overrides };
}

function throwsCode(code) {
  return error => error?.code === code;
}

test('validateJson measures encoded JSON and accepts plain null-prototype objects', () => {
  const value = Object.assign(Object.create(null), { text: '汉字', count: -0 });
  assert.equal(validateJson(value), Buffer.byteLength(JSON.stringify(value)));
});

test('validateJson rejects custom prototypes, accessors, cycles, and non-JSON numbers', () => {
  assert.throws(() => validateJson(Object.create({ inherited: true })), throwsCode('invalid_json'));

  let getterCalled = false;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'no';
    },
  });
  assert.throws(() => validateJson(accessor), error => (
    error?.code === 'invalid_json' && error.details?.instancePath === '/secret'
  ));
  assert.equal(getterCalled, false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => validateJson(cyclic), error => (
    error?.code === 'invalid_json' && error.details?.instancePath === '/self'
  ));
  assert.throws(() => validateJson({ number: Number.POSITIVE_INFINITY }), throwsCode('invalid_json'));
});

test('validateJson enforces exact container depth and byte boundaries', () => {
  const twoContainers = { one: { value: 1 } };
  assert.equal(validateJson(twoContainers, { maxDepth: 2, maxBytes: 19 }), 19);
  assert.throws(
    () => validateJson({ one: { two: {} } }, { maxDepth: 2, maxBytes: 100 }),
    error => error?.status === 413 && error?.code === 'value_too_large' && error.details?.instancePath === '/one/two',
  );
  assert.throws(
    () => validateJson(twoContainers, { maxDepth: 2, maxBytes: 18 }),
    error => error?.status === 413 && error?.code === 'value_too_large',
  );
});

test('canonicalJSON sorts every object and normalizes equivalent JSON numbers', () => {
  const first = { z: [{ second: 2, first: 1 }], a: -0 };
  const second = { a: 0, z: [{ first: 1, second: 2 }] };
  assert.equal(canonicalJSON(first), '{"a":0,"z":[{"first":1,"second":2}]}');
  assert.equal(canonicalJSON(first), canonicalJSON(second));
});

test('compileSchema supports pattern, patternProperties, and structural uniqueItems', async () => {
  const patterned = await compileSchema({
    type: 'object',
    properties: { slug: { type: 'string', pattern: '^[a-z]+$' } },
    patternProperties: { '^x_': { type: 'integer' } },
    required: ['slug'],
    additionalProperties: false,
  });
  const matching = { slug: 'valid', x_count: 2 };
  assert.equal(await patterned(matching), matching);
  await assert.rejects(patterned({ slug: 'Not-valid' }), throwsCode('schema_validation'));
  await assert.rejects(patterned({ slug: 'valid', x_count: '2' }), throwsCode('schema_validation'));

  const unique = await compileSchema({ type: 'array', uniqueItems: true });
  await assert.rejects(unique([{ id: 1 }, { id: 1 }]), error => (
    error?.status === 422
      && error?.code === 'schema_validation'
      && error.details?.errors[0]?.keyword === 'uniqueItems'
  ));
  const distinct = [{ id: 1 }, { id: 2 }];
  assert.equal(await unique(distinct), distinct);
});

test('compileSchema accepts valid schemas without Ajv strict-lint subset restrictions', async () => {
  const propertiesWithoutType = await compileSchema({
    properties: { x: { type: 'string' } },
  });
  assert.deepEqual(await propertiesWithoutType({ x: 'value' }), { x: 'value' });

  const overlappingPatterns = await compileSchema({
    type: 'object',
    properties: { x: { type: 'string' } },
    patternProperties: { '^x$': { minLength: 2 } },
  });
  assert.deepEqual(await overlappingPatterns({ x: 'ok' }), { x: 'ok' });
  await assert.rejects(overlappingPatterns({ x: 'x' }), throwsCode('schema_validation'));
});

test('compileSchema supports recursive local references, IDs, anchors, and dynamic references', async () => {
  const recursive = await compileSchema({
    $id: 'https://schemas.example/tree',
    $defs: {
      node: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/$defs/node' } },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
    $ref: '#/$defs/node',
  }, 'tree');
  const tree = { value: 'root', children: [{ value: 'leaf' }] };
  assert.equal(await recursive(tree), tree);
  await assert.rejects(recursive({ value: 'root', children: [{ value: 1 }] }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'schema_validation');
    assert.equal(error.details.errors[0].instancePath, '/children/0/value');
    return true;
  });

  const anchored = await compileSchema({
    $id: 'https://schemas.example/anchored-tree',
    $defs: {
      node: {
        $anchor: 'node',
        type: 'object',
        properties: {
          value: { type: 'integer' },
          children: { type: 'array', items: { $ref: '#node' } },
        },
        required: ['value'],
        additionalProperties: false,
      },
    },
    $ref: '#node',
  }, 'anchoredTree');
  assert.deepEqual(
    await anchored({ value: 1, children: [{ value: 2 }] }),
    { value: 1, children: [{ value: 2 }] },
  );
  await assert.rejects(
    anchored({ value: 1, children: [{ value: 'bad' }] }),
    error => error?.code === 'schema_validation'
      && error.details?.errors[0]?.instancePath === '/children/0/value',
  );

  const dynamic = await compileSchema({
    $dynamicAnchor: 'node',
    type: 'object',
    properties: {
      value: { type: 'integer' },
      next: { $dynamicRef: '#node' },
    },
    required: ['value'],
    additionalProperties: false,
  });
  assert.deepEqual(await dynamic({ value: 1, next: { value: 2 } }), { value: 1, next: { value: 2 } });
  await assert.rejects(dynamic({ value: 1, next: { value: 'bad' } }), throwsCode('schema_validation'));
});

test('compileSchema rejects invalid regex and unresolved external references without fetching', async () => {
  await assert.rejects(
    compileSchema({ type: 'string', pattern: '[' }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.keyword === 'pattern',
  );
  await assert.rejects(
    compileSchema({ $ref: 'https://example.invalid/unavailable-schema' }),
    error => error?.status === 400
      && error?.code === 'invalid_schema'
      && error.details?.errors[0]?.keyword === '$ref',
  );
});

test('compileSchema rejects executable async schemas but not literal annotation data', async () => {
  await assert.rejects(
    compileSchema({
      type: 'object',
      properties: { value: { $async: true, type: 'string' } },
    }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/properties/value/$async',
  );
  const literal = { $async: true, pattern: 'literal data' };
  const validateLiteral = await compileSchema({ const: literal });
  assert.equal(await validateLiteral(literal), literal);
});

test('compileSchema is strict, treats format as annotation, and bounds schema JSON', async () => {
  await assert.rejects(
    compileSchema({ type: 'object', unknownAssertion: true }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.keyword === 'unknownKeyword',
  );
  await assert.rejects(compileSchema({ type: 'not-a-json-type' }), throwsCode('invalid_schema'));

  const annotated = await compileSchema({ type: 'string', format: 'caller-private-format' });
  assert.equal(await annotated('uninterpreted'), 'uninterpreted');
  await assert.rejects(
    compileSchema({ enum: Array.from({ length: 2_050 }, () => 0) }),
    throwsCode('invalid_schema'),
  );
});

test('validators reject unsafe JSON before isolated schema evaluation', async () => {
  const validate = await compileSchema(true);
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(validate(cyclic), error => (
    error?.status === 422
      && error?.code === 'schema_validation'
      && error.details?.errors[0]?.instancePath === '/self'
      && error.details.errors[0].keyword === 'json'
  ));
});

test('catastrophic regex times out in a killable worker while the main timer progresses', async () => {
  const validate = await compileSchema(
    { type: 'string', pattern: '^(a+)+$' },
    'dangerous',
    { timeoutMs: 500 },
  );
  let timerProgressed = false;
  const timer = setTimeout(() => {
    timerProgressed = true;
  }, 25);
  await assert.rejects(
    validate(`${'a'.repeat(30_000)}!`),
    error => error?.status === 503 && error?.code === 'validation_timeout',
  );
  clearTimeout(timer);
  assert.equal(timerProgressed, true);
});

test('abort and capacity failures kill active work, remove queued jobs, and release capacity', async () => {
  const validate = await compileSchema(
    { type: 'string', pattern: '^(a+)+$' },
    'queued',
    { timeoutMs: 1_000 },
  );
  const controller = new AbortController();
  const hostile = `${'a'.repeat(30_000)}!`;
  const operations = Array.from({ length: 35 }, () => validate(hostile, { signal: controller.signal }));
  await assert.rejects(
    operations.at(-1),
    error => error?.status === 429 && error?.code === 'validation_capacity',
  );
  controller.abort();
  const results = await Promise.allSettled(operations.slice(0, -1));
  assert.equal(results.every(result => (
    result.status === 'rejected' && result.reason?.code === 'validation_aborted'
  )), true);
  assert.equal(await validate('aaaa'), 'aaaa');
});

test('prepareRequest enforces response mode and preserves native raw mode', async () => {
  await assert.rejects(
    prepareRequest(nativeRequest({ resultSchema: true })),
    throwsCode('invalid_request'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ responseMode: 'structured' })),
    throwsCode('invalid_request'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ responseMode: null })),
    throwsCode('invalid_request'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ timeoutMs: null })),
    throwsCode('invalid_request'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ queueTimeoutMs: null })),
    throwsCode('invalid_request'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ tools: null })),
    throwsCode('invalid_tool'),
  );

  const native = await prepareRequest(nativeRequest());
  assert.equal(native.request.responseMode, 'native');
  assert.equal(native.resultValidator, undefined);
  assert.equal(Object.hasOwn(native.request, 'resultSchema'), false);

  const structured = await prepareRequest(nativeRequest({ responseMode: 'structured', resultSchema: false }));
  assert.equal(structured.request.responseMode, 'structured');
  await assert.rejects(structured.resultValidator(null), throwsCode('schema_validation'));
});

test('prepareRequest enforces message and complete body byte limits', async () => {
  await assert.doesNotReject(prepareRequest(nativeRequest({ message: 'x'.repeat(48 * 1024) })));
  await assert.rejects(
    prepareRequest(nativeRequest({ message: 'x'.repeat((48 * 1024) + 1) })),
    throwsCode('invalid_message'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({
      responseMode: 'structured',
      resultSchema: { description: 'x'.repeat(64 * 1024) },
    })),
    error => error?.status === 413 && error?.code === 'body_too_large',
  );
});

test('prepareRequest bounds optional instructions by UTF-8 bytes without trimming task context', async () => {
  const instructions = '界'.repeat(LIMITS.messageBytes / 3);
  const accepted = await prepareRequest(nativeRequest({ instructions }));
  assert.equal(accepted.request.instructions, instructions);
  await assert.rejects(
    prepareRequest(nativeRequest({ instructions: instructions + 'x' })),
    error => error?.status === 400 && error?.code === 'invalid_request',
  );
  for (const instructions of [null, {}]) {
    await assert.rejects(
      prepareRequest(nativeRequest({ instructions })),
      throwsCode('invalid_request'),
    );
  }
  const whitespace = '  \n';
  assert.equal((await prepareRequest(nativeRequest({ instructions: whitespace }))).request.instructions, whitespace);
  await assert.rejects(
    prepareRequest(nativeRequest({ message: 'x'.repeat(32 * 1024), instructions: 'y'.repeat(32 * 1024) })),
    error => error?.status === 413 && error?.code === 'body_too_large',
  );
});

test('prepareRequest rejects unknown fields and normalizes explicit defaults', async () => {
  await assert.rejects(
    prepareRequest(nativeRequest({ unexpected: true })),
    error => error?.code === 'invalid_request' && error.details?.field === 'unexpected',
  );

  const omitted = (await prepareRequest(nativeRequest())).request;
  const explicit = (await prepareRequest({
    message: 'Do the work.',
    instructions: '',
    requestId: 'request_1',
    generation: 7,
    instanceId: IDENTITY.instanceId,
    responseMode: 'native',
    tools: [],
    queueTimeoutMs: 3_600_000,
    timeoutMs: 300_000,
    toolTimeoutMs: 60_000,
  })).request;
  assert.equal(canonicalJSON(omitted), canonicalJSON(explicit));

  const capped = (await prepareRequest(nativeRequest({ timeoutMs: 2_000 }))).request;
  assert.equal(capped.toolTimeoutMs, 2_000);
});

test('prepareRequest validates queue timeout independently across exact bounds', async () => {
  for (const queueTimeoutMs of [999, 86_400_001, 1_000.5]) {
    await assert.rejects(
      prepareRequest(nativeRequest({ queueTimeoutMs })),
      error => error?.code === 'invalid_request' && error.message.includes('queueTimeoutMs'),
    );
  }

  const minimum = (await prepareRequest(nativeRequest({
    queueTimeoutMs: 1_000,
    timeoutMs: 300_000,
    toolTimeoutMs: 60_000,
  }))).request;
  assert.equal(minimum.queueTimeoutMs, 1_000);
  assert.equal(minimum.toolTimeoutMs, 60_000);
  assert.equal((await prepareRequest(nativeRequest({ queueTimeoutMs: 86_400_000 }))).request.queueTimeoutMs, 86_400_000);
});

test('prepareRequest compiles caller tool schemas and isolates the normalized clone', async () => {
  const body = nativeRequest({
    tools: [{
      name: 'lookup_item',
      description: 'Look up an item.',
      inputSchema: {
        type: 'object',
        $defs: { identifier: { type: 'integer', minimum: 1 } },
        properties: { id: { $ref: '#/$defs/identifier' } },
        required: ['id'],
        additionalProperties: false,
      },
      resultSchema: {
        type: 'object',
        properties: { title: { type: 'string', pattern: '^.+$' } },
        required: ['title'],
        additionalProperties: false,
      },
    }],
  });
  const prepared = await prepareRequest(body);
  body.tools[0].inputSchema.properties.id = true;

  assert.notEqual(prepared.request.tools[0].inputSchema, body.tools[0].inputSchema);
  await assert.rejects(
    prepared.toolValidators.get('lookup_item').input({ id: 0 }),
    error => error?.code === 'schema_validation'
      && error.details?.errors.some(detail => detail.instancePath === '/id'),
  );
  assert.deepEqual(
    await prepared.toolValidators.get('lookup_item').result({ title: 'Found' }),
    { title: 'Found' },
  );
});

test('prepareRequest rejects tool name collisions, reserved prefixes, and non-object inputs', async () => {
  const tool = {
    name: 'lookup_item',
    description: 'Look up an item.',
    inputSchema: { type: 'object' },
    resultSchema: true,
  };
  await assert.rejects(
    prepareRequest(nativeRequest({ tools: [tool] }), { reservedToolNames: ['lookup_item'] }),
    throwsCode('invalid_tool'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ tools: [{ ...tool, name: 'rpc_hidden' }] })),
    throwsCode('invalid_tool'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ tools: [tool, tool] })),
    throwsCode('invalid_tool'),
  );
  await assert.rejects(
    prepareRequest(nativeRequest({ tools: [{ ...tool, inputSchema: { type: 'string' } }] })),
    throwsCode('invalid_tool'),
  );
});

test('prepareRequest forwards cancellation to isolated schema compilation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareRequest(nativeRequest({ responseMode: 'structured', resultSchema: true }), { signal: controller.signal }),
    error => error?.status === 409 && error?.code === 'validation_aborted',
  );
});
