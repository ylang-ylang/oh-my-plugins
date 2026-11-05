import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, compileSchema, prepareRequest, validateJson } from './schema.mjs';

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
      return 'secret';
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

test('compileSchema supports bounded local references and precise validation paths', () => {
  const validate = compileSchema({
    type: 'object',
    $defs: {
      item: { type: 'string', minLength: 2 },
    },
    properties: {
      items: {
        type: 'array',
        items: { $ref: '#/$defs/item' },
      },
    },
    required: ['items'],
    additionalProperties: false,
  }, 'result');

  const valid = { items: ['ok'] };
  assert.equal(validate(valid), valid);
  assert.throws(() => validate({ items: ['x'] }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'schema_validation');
    const detail = error.details.errors.find(item => item.instancePath === '/items/0');
    assert.deepEqual(Object.keys(detail).sort(), ['instancePath', 'keyword', 'message', 'schemaPath']);
    assert.equal(detail.schemaPath, '#/$defs/item/minLength');
    assert.equal(detail.keyword, 'minLength');
    return true;
  });
});

test('compileSchema rejects recursive and combinatorially expanded local references', () => {
  assert.throws(
    () => compileSchema({
      $defs: {
        node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/node' } },
        },
      },
      $ref: '#/$defs/node',
    }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.keyword === '$ref'
      && error.details.errors[0].message.includes('recursive'),
  );

  const $defs = { leaf: { type: 'null' } };
  let previous = 'leaf';
  for (let depth = 0; depth < 12; depth += 1) {
    const name = `level${depth}`;
    $defs[name] = {
      anyOf: [
        { $ref: `#/$defs/${previous}` },
        { $ref: `#/$defs/${previous}` },
      ],
    };
    previous = name;
  }
  assert.throws(
    () => compileSchema({ $defs, $ref: `#/$defs/${previous}` }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.keyword === '$ref'
      && error.details.errors[0].message.includes('expanded validation graph'),
  );
});

test('compileSchema supports only unambiguous local JSON Pointer reference semantics', () => {
  for (const schema of [
    { $id: 'caller-schema', type: 'string' },
    { $anchor: 'item', type: 'string' },
    { $dynamicAnchor: 'item', type: 'string' },
    { $dynamicRef: '#item' },
    { $ref: '#item' },
  ]) {
    assert.throws(() => compileSchema(schema), throwsCode('invalid_schema'));
  }
});

test('compileSchema applies safety policy to schemas reached through literal JSON locations', () => {
  const hazardousTargets = [
    { type: 'string', pattern: '^(a+)+$' },
    { type: 'object', patternProperties: { '^(a+)+$': true } },
    { type: 'array', uniqueItems: true },
    { $dynamicRef: '#item' },
  ];
  for (const target of hazardousTargets) {
    assert.throws(
      () => compileSchema({ $ref: '#/default', default: target }),
      throwsCode('invalid_schema'),
    );
  }

  assert.doesNotThrow(() => compileSchema({
    default: { pattern: 'literal annotation data is not executed' },
  }));
});

test('compileSchema caps aggregate schema-by-data evaluation work before Ajv runs', () => {
  const validate = compileSchema({
    type: 'array',
    items: {
      allOf: Array.from({ length: 500 }, () => ({ const: 0 })),
    },
  });
  assert.throws(
    () => validate(Array.from({ length: 5_000 }, () => 0)),
    error => error?.status === 422
      && error?.code === 'schema_validation'
      && error.details?.errors[0]?.keyword === 'complexity',
  );
});

test('compileSchema rejects quadratic uniqueItems and validates JSON safety before schema evaluation', () => {
  assert.throws(
    () => compileSchema({ type: 'array', uniqueItems: true }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/uniqueItems',
  );
  const allowDuplicates = compileSchema({ type: 'array', uniqueItems: false });
  const item = { id: 1 };
  assert.deepEqual(allowDuplicates([item, item]), [item, item]);

  const validate = compileSchema(true);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => validate(cyclic),
    error => error?.status === 422
      && error?.code === 'schema_validation'
      && error.details?.errors[0]?.instancePath === '/self'
      && error.details.errors[0].keyword === 'json',
  );

  const deep = {};
  let cursor = deep;
  for (let depth = 0; depth < 32; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  assert.throws(
    () => validate(deep),
    error => error?.status === 422
      && error?.code === 'schema_validation'
      && error.details?.errors[0]?.keyword === 'json',
  );
});

test('compileSchema rejects external references without mistaking literal data for schemas', () => {
  assert.throws(
    () => compileSchema({ $ref: 'https://example.invalid/schema' }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/$ref'
      && error.details.errors[0].keyword === '$ref',
  );

  const literal = { $ref: 'https://example.invalid/literal-data' };
  const validateLiteral = compileSchema({ const: literal });
  assert.equal(validateLiteral(literal), literal);
});

test('compileSchema rejects every executable regular-expression keyword before Ajv compilation', () => {
  assert.throws(
    () => compileSchema({
      type: 'object',
      $defs: {
        unsafe: { type: 'string', pattern: '^(a+)+$' },
      },
      properties: { value: { $ref: '#/$defs/unsafe' } },
    }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/$defs/unsafe/pattern'
      && error.details.errors[0].keyword === 'pattern',
  );

  assert.throws(
    () => compileSchema({ type: 'object', patternProperties: {} }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/patternProperties'
      && error.details.errors[0].keyword === 'patternProperties',
  );

  const literal = { pattern: '^(a+)+$', patternProperties: { '^(a+)+$': true } };
  const validateLiteral = compileSchema({ const: literal });
  assert.equal(validateLiteral(literal), literal);
});

test('compileSchema reports invalid schema paths and rejects unknown strict keywords', () => {
  assert.throws(() => compileSchema({
    type: 'object',
    properties: {
      value: { type: 'string', unknownAssertion: true },
    },
  }), error => error?.code === 'invalid_schema'
    && error.details?.errors[0]?.instancePath === '/properties/value/unknownAssertion');

  assert.throws(() => compileSchema({ type: 'not-a-json-type' }), error => (
    error?.code === 'invalid_schema'
      && error.details?.errors.some(detail => detail.instancePath === '/type')
  ));
  assert.throws(
    () => compileSchema({ $async: true, type: 'string' }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/$async',
  );
  assert.throws(
    () => compileSchema({ type: 'string', nullable: true }),
    error => error?.code === 'invalid_schema'
      && error.details?.errors[0]?.instancePath === '/nullable',
  );
});

test('compileSchema treats format as annotation and bounds total schema nodes', () => {
  const validate = compileSchema({ type: 'string', format: 'caller-private-format' });
  assert.equal(validate('uninterpreted'), 'uninterpreted');

  assert.throws(
    () => compileSchema({ enum: Array.from({ length: 2_050 }, () => 0) }),
    throwsCode('invalid_schema'),
  );
});

test('prepareRequest enforces response mode and result schema pairing', () => {
  assert.throws(
    () => prepareRequest(nativeRequest({ resultSchema: true })),
    throwsCode('invalid_request'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ responseMode: 'structured' })),
    throwsCode('invalid_request'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ responseMode: null })),
    throwsCode('invalid_request'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ timeoutMs: null })),
    throwsCode('invalid_request'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ tools: null })),
    throwsCode('invalid_tool'),
  );

  const native = prepareRequest(nativeRequest());
  assert.equal(native.request.responseMode, 'native');
  assert.equal(native.resultValidator, undefined);
  assert.equal(Object.hasOwn(native.request, 'resultSchema'), false);

  const structured = prepareRequest(nativeRequest({ responseMode: 'structured', resultSchema: false }));
  assert.equal(structured.request.responseMode, 'structured');
  assert.throws(() => structured.resultValidator(null), throwsCode('schema_validation'));
});

test('prepareRequest enforces message and complete body byte limits', () => {
  assert.doesNotThrow(() => prepareRequest(nativeRequest({ message: 'x'.repeat(48 * 1024) })));
  assert.throws(
    () => prepareRequest(nativeRequest({ message: 'x'.repeat((48 * 1024) + 1) })),
    throwsCode('invalid_message'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({
      responseMode: 'structured',
      resultSchema: { description: 'x'.repeat(64 * 1024) },
    })),
    error => error?.status === 413 && error?.code === 'body_too_large',
  );
});

test('prepareRequest rejects unknown fields and normalizes explicit defaults for deduplication', () => {
  assert.throws(
    () => prepareRequest(nativeRequest({ unexpected: true })),
    error => error?.code === 'invalid_request' && error.details?.field === 'unexpected',
  );

  const omitted = prepareRequest(nativeRequest()).request;
  const explicit = prepareRequest({
    message: 'Do the work.',
    requestId: 'request_1',
    generation: 7,
    instanceId: IDENTITY.instanceId,
    responseMode: 'native',
    tools: [],
    timeoutMs: 300_000,
    toolTimeoutMs: 60_000,
  }).request;
  assert.equal(canonicalJSON(omitted), canonicalJSON(explicit));

  const capped = prepareRequest(nativeRequest({ timeoutMs: 2_000 })).request;
  assert.equal(capped.toolTimeoutMs, 2_000);
});

test('prepareRequest compiles caller tool schemas and isolates the normalized clone', () => {
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
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    }],
  });
  const prepared = prepareRequest(body);
  body.tools[0].inputSchema.properties.id = true;

  assert.notEqual(prepared.request.tools[0].inputSchema, body.tools[0].inputSchema);
  assert.throws(
    () => prepared.toolValidators.get('lookup_item').input({ id: 0 }),
    error => error?.code === 'schema_validation'
      && error.details?.errors.some(detail => detail.instancePath === '/id'),
  );
  assert.deepEqual(
    prepared.toolValidators.get('lookup_item').result({ title: 'Found' }),
    { title: 'Found' },
  );
});

test('prepareRequest rejects tool name collisions, reserved prefixes, and non-object inputs', () => {
  const tool = {
    name: 'lookup_item',
    description: 'Look up an item.',
    inputSchema: { type: 'object' },
    resultSchema: true,
  };
  assert.throws(
    () => prepareRequest(nativeRequest({ tools: [tool] }), { reservedToolNames: ['lookup_item'] }),
    throwsCode('invalid_tool'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ tools: [{ ...tool, name: 'rpc_hidden' }] })),
    throwsCode('invalid_tool'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ tools: [tool, tool] })),
    throwsCode('invalid_tool'),
  );
  assert.throws(
    () => prepareRequest(nativeRequest({ tools: [{ ...tool, inputSchema: { type: 'string' } }] })),
    throwsCode('invalid_tool'),
  );
});
