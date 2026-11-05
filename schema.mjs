import { Buffer } from 'node:buffer';
import Ajv2020 from 'ajv/dist/2020.js';
import { LIMITS, failure, validateId, validateIdentity } from './protocol.mjs';

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REQUEST_FIELDS = new Set([
  'instanceId',
  'generation',
  'requestId',
  'message',
  'responseMode',
  'resultSchema',
  'tools',
  'timeoutMs',
  'toolTimeoutMs',
]);
const TOOL_FIELDS = new Set(['name', 'description', 'inputSchema', 'resultSchema']);
const SCHEMA_KEYWORDS = new Set([
  '$anchor', '$comment', '$defs', '$dynamicAnchor', '$dynamicRef', '$id', '$ref', '$schema', '$vocabulary',
  'additionalProperties', 'allOf', 'anyOf', 'const', 'contains', 'contentEncoding', 'contentMediaType',
  'contentSchema', 'default', 'dependentRequired', 'dependentSchemas', 'deprecated', 'description', 'else',
  'enum', 'examples', 'exclusiveMaximum', 'exclusiveMinimum', 'format', 'if', 'items', 'maxContains',
  'maximum', 'maxItems', 'maxLength', 'maxProperties', 'minContains', 'minimum', 'minItems', 'minLength',
  'minProperties', 'multipleOf', 'not', 'oneOf', 'pattern', 'patternProperties', 'prefixItems', 'properties',
  'propertyNames', 'readOnly', 'required', 'then', 'title', 'type', 'unevaluatedItems',
  'unevaluatedProperties', 'uniqueItems', 'writeOnly',
]);
const MAP_SCHEMA_KEYWORDS = ['$defs', 'properties', 'dependentSchemas'];
const ARRAY_SCHEMA_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SINGLE_SCHEMA_KEYWORDS = [
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const REFERENCE_KEYWORDS = ['$ref'];
const REGEX_SCHEMA_KEYWORDS = ['pattern', 'patternProperties'];
const UNSUPPORTED_REFERENCE_KEYWORDS = ['$id', '$anchor', '$dynamicAnchor', '$dynamicRef'];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const ajv = new Ajv2020({
  addUsedSchema: false,
  allErrors: false,
  allowUnionTypes: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  validateFormats: false,
  strict: true,
  ownProperties: true,
});

const MAX_VALIDATION_WORK = LIMITS.schemaNodes * LIMITS.schemaNodes;

function pointerPart(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPath(path, key) {
  return `${path}/${pointerPart(String(key))}`;
}

function invalidJson(path, message) {
  return failure(400, 'invalid_json', `${path || 'JSON value'} ${message}`, { instancePath: path });
}

function assertLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function inspectJson(value, {
  maxBytes,
  maxDepth,
  sizeCode = 'value_too_large',
  sizeMessage = `JSON value exceeds ${maxBytes} bytes`,
} = {}) {
  assertLimit(maxBytes, 'maxBytes');
  assertLimit(maxDepth, 'maxDepth');

  const active = new WeakSet();
  let bytes = 0;
  let nodes = 0;

  function addBytes(count) {
    bytes += count;
    if (bytes > maxBytes) {
      throw failure(413, sizeCode, sizeMessage, { maxBytes });
    }
  }

  function reflect(operation, path) {
    try {
      return operation();
    } catch {
      throw invalidJson(path, 'cannot be inspected safely');
    }
  }

  function visit(current, depth, path) {
    nodes += 1;
    if (current === null) {
      addBytes(4);
      return;
    }

    switch (typeof current) {
      case 'boolean':
        addBytes(current ? 4 : 5);
        return;
      case 'string':
        addBytes(Buffer.byteLength(JSON.stringify(current)));
        return;
      case 'number':
        if (!Number.isFinite(current)) throw invalidJson(path, 'must not contain a non-finite number');
        addBytes(Buffer.byteLength(JSON.stringify(current)));
        return;
      case 'object':
        break;
      default:
        throw invalidJson(path, `must not contain ${typeof current}`);
    }

    if (depth >= maxDepth) {
      throw failure(413, 'value_too_large', `JSON value exceeds maximum depth ${maxDepth}`, {
        instancePath: path,
        maxDepth,
      });
    }
    if (active.has(current)) throw invalidJson(path, 'must not contain a cycle');

    const prototype = reflect(() => Object.getPrototypeOf(current), path);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) throw invalidJson(path, 'must use the standard Array prototype');
      const keys = reflect(() => Reflect.ownKeys(current), path);
      if (keys.length !== current.length + 1) {
        throw invalidJson(path, 'must be a dense array without extra properties');
      }
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) {
          throw invalidJson(path, 'must be a dense array without extra properties');
        }
      }

      active.add(current);
      addBytes(1);
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) addBytes(1);
        const itemPath = childPath(path, index);
        const descriptor = reflect(() => Object.getOwnPropertyDescriptor(current, String(index)), itemPath);
        if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) {
          throw invalidJson(itemPath, 'must be an enumerable data property');
        }
        visit(descriptor.value, depth + 1, itemPath);
      }
      addBytes(1);
      active.delete(current);
      return;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidJson(path, 'must use a plain object prototype');
    }
    const keys = reflect(() => Reflect.ownKeys(current), path);
    active.add(current);
    addBytes(1);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') throw invalidJson(path, 'must not contain symbol properties');
      const propertyPath = childPath(path, key);
      const descriptor = reflect(() => Object.getOwnPropertyDescriptor(current, key), propertyPath);
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) {
        throw invalidJson(propertyPath, 'must be an enumerable data property');
      }
      if (index > 0) addBytes(1);
      addBytes(Buffer.byteLength(JSON.stringify(key)) + 1);
      visit(descriptor.value, depth + 1, propertyPath);
    }
    addBytes(1);
    active.delete(current);
  }

  visit(value, 0, '');
  return { bytes, nodes };
}

export function validateJson(value, {
  maxBytes = LIMITS.resultBytes,
  maxDepth = LIMITS.jsonDepth,
} = {}) {
  return inspectJson(value, { maxBytes, maxDepth }).bytes;
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

export function canonicalJSON(value) {
  validateJson(value);
  return canonicalize(value);
}

function schemaFailure(label, message, errors) {
  return failure(400, 'invalid_schema', `${label} ${message}`, errors ? { errors } : undefined);
}

function schemaError(instancePath, keyword, message, schemaPath = '#') {
  return { instancePath, schemaPath, keyword, message };
}

function normalizeAjvErrors(errors) {
  return (errors ?? []).map(error => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? '',
  }));
}

function assertSchemaBounds(schema, label) {
  try {
    inspectJson(schema, { maxBytes: LIMITS.requestBytes, maxDepth: LIMITS.jsonDepth });
  } catch (error) {
    if (!error?.code) throw error;
    throw schemaFailure(label, error.message, [
      schemaError(error.details?.instancePath ?? '', 'json', error.message),
    ]);
  }

  let nodes = 0;
  const pending = [schema];
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > LIMITS.schemaNodes) {
      throw schemaFailure(label, `exceeds ${LIMITS.schemaNodes} JSON nodes`, [
        schemaError('', 'maxNodes', `must contain at most ${LIMITS.schemaNodes} JSON nodes`),
      ]);
    }
    if (current !== null && typeof current === 'object') {
      if (Array.isArray(current)) pending.push(...current);
      else pending.push(...Object.values(current));
    }
  }
  return nodes;
}

function assertLocalSchemas(schema, label, path = '') {
  if (typeof schema === 'boolean') return;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;

  for (const keyword of REGEX_SCHEMA_KEYWORDS) {
    if (!hasOwn(schema, keyword)) continue;
    const instancePath = childPath(path, keyword);
    throw schemaFailure(label, `uses unsupported regular-expression keyword "${keyword}" at ${instancePath}`, [
      schemaError(instancePath, keyword, 'is unsupported because regular-expression evaluation cannot be bounded'),
    ]);
  }

  for (const keyword of UNSUPPORTED_REFERENCE_KEYWORDS) {
    if (!hasOwn(schema, keyword)) continue;
    const instancePath = childPath(path, keyword);
    throw schemaFailure(label, `uses unsupported reference keyword "${keyword}" at ${instancePath}`, [
      schemaError(instancePath, keyword, 'is unsupported by the bounded local-reference subset'),
    ]);
  }

  if (schema.uniqueItems === true) {
    const instancePath = childPath(path, 'uniqueItems');
    throw schemaFailure(label, `uses unsupported uniqueItems assertion at ${instancePath}`, [
      schemaError(instancePath, 'uniqueItems', 'is unsupported because object comparison work cannot be bounded'),
    ]);
  }

  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      const instancePath = childPath(path, key);
      throw schemaFailure(label, `contains unknown keyword "${key}" at ${instancePath}`, [
        schemaError(instancePath, 'unknownKeyword', 'must be a supported draft 2020-12 keyword'),
      ]);
    }
  }

  for (const keyword of REFERENCE_KEYWORDS) {
    if (!hasOwn(schema, keyword)) continue;
    const reference = schema[keyword];
    if (typeof reference !== 'string' || (reference !== '#' && !reference.startsWith('#/'))) {
      const instancePath = childPath(path, keyword);
      throw schemaFailure(label, `contains unsupported ${keyword} at ${instancePath}`, [
        schemaError(instancePath, keyword, 'must be a local JSON Pointer reference'),
      ]);
    }
  }

  for (const keyword of MAP_SCHEMA_KEYWORDS) {
    const entries = schema[keyword];
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [key, child] of Object.entries(entries)) {
      assertLocalSchemas(child, label, childPath(childPath(path, keyword), key));
    }
  }


  for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    for (let index = 0; index < children.length; index += 1) {
      assertLocalSchemas(children[index], label, childPath(childPath(path, keyword), index));
    }
  }

  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (typeof child === 'boolean' || (child !== null && typeof child === 'object' && !Array.isArray(child))) {
      assertLocalSchemas(child, label, childPath(path, keyword));
    }
  }
}

function forEachSchemaChild(schema, path, visit) {
  for (const keyword of MAP_SCHEMA_KEYWORDS) {
    const entries = schema[keyword];
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [key, child] of Object.entries(entries)) {
      visit(child, childPath(childPath(path, keyword), key));
    }
  }

  for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    for (let index = 0; index < children.length; index += 1) {
      visit(children[index], childPath(childPath(path, keyword), index));
    }
  }

  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (typeof child === 'boolean' || (child !== null && typeof child === 'object' && !Array.isArray(child))) {
      visit(child, childPath(path, keyword));
    }
  }
}

function decodePointerPart(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '~') {
      decoded += value[index];
      continue;
    }
    const escape = value[index + 1];
    if (escape !== '0' && escape !== '1') return undefined;
    decoded += escape === '0' ? '~' : '/';
    index += 1;
  }
  return decoded;
}

function resolveLocalPointer(root, reference, label, instancePath) {
  if (reference === '#') return { target: root, targetPath: '' };

  let pointer;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    pointer = undefined;
  }
  if (pointer === undefined || !pointer.startsWith('/')) {
    throw schemaFailure(label, `contains invalid local reference at ${instancePath}`, [
      schemaError(instancePath, '$ref', 'must contain a valid URI-encoded JSON Pointer'),
    ]);
  }

  let target = root;
  for (const encodedPart of pointer.slice(1).split('/')) {
    const part = decodePointerPart(encodedPart);
    if (part === undefined || target === null || typeof target !== 'object' || !hasOwn(target, part)) {
      throw schemaFailure(label, `contains unresolved local reference at ${instancePath}`, [
        schemaError(instancePath, '$ref', `must resolve to an existing schema: ${reference}`),
      ]);
    }
    target = target[part];
  }

  if (typeof target !== 'boolean' && (target === null || typeof target !== 'object' || Array.isArray(target))) {
    throw schemaFailure(label, `contains non-schema local reference at ${instancePath}`, [
      schemaError(instancePath, '$ref', `must resolve to a boolean or object schema: ${reference}`),
    ]);
  }
  return { target, targetPath: pointer };
}

function jsonNodeCount(value) {
  let nodes = 0;
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (current !== null && typeof current === 'object') {
      if (Array.isArray(current)) pending.push(...current);
      else pending.push(...Object.values(current));
    }
  }
  return nodes;
}

function assertReferenceComplexity(root, label, baseNodes) {
  let expandedNodes = baseNodes;

  function visit(schema, path, chain) {
    if (typeof schema === 'boolean') return;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;

    if (hasOwn(schema, '$ref')) {
      const instancePath = childPath(path, '$ref');
      const { target, targetPath } = resolveLocalPointer(root, schema.$ref, label, instancePath);
      assertLocalSchemas(target, label, targetPath);
      if (chain.has(target)) {
        throw schemaFailure(label, `contains recursive local reference at ${instancePath}`, [
          schemaError(instancePath, '$ref', 'must not create a recursive reference cycle'),
        ]);
      }

      expandedNodes += jsonNodeCount(target);
      if (expandedNodes > LIMITS.schemaNodes) {
        throw schemaFailure(label, `expanded local references exceed ${LIMITS.schemaNodes} JSON nodes`, [
          schemaError(instancePath, '$ref', `expanded validation graph must contain at most ${LIMITS.schemaNodes} JSON nodes`),
        ]);
      }

      if (target !== null && typeof target === 'object') chain.add(target);
      visit(target, targetPath, chain);
      if (target !== null && typeof target === 'object') chain.delete(target);
    }

    forEachSchemaChild(schema, path, (child, childInstancePath) => {
      visit(child, childInstancePath, chain);
    });
  }

  const chain = new Set();
  if (root !== null && typeof root === 'object') chain.add(root);
  visit(root, '', chain);
  return expandedNodes;
}

export function compileSchema(schema, label = 'schema') {
  const schemaNodes = assertSchemaBounds(schema, label);
  if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) {
    throw schemaFailure(label, 'must be a boolean or object JSON Schema', [
      schemaError('', 'type', 'must be a boolean or object'),
    ]);
  }
  assertLocalSchemas(schema, label);
  const validationNodes = assertReferenceComplexity(schema, label, schemaNodes);

  if (!ajv.validateSchema(schema)) {
    throw schemaFailure(label, 'is not a valid draft 2020-12 schema', normalizeAjvErrors(ajv.errors));
  }

  let compiled;
  try {
    compiled = ajv.compile(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown compilation error';
    throw schemaFailure(label, `cannot be compiled: ${message}`, [
      schemaError('', 'compile', message),
    ]);
  }

  return function validate(value) {
    let dataNodes;
    try {
      ({ nodes: dataNodes } = inspectJson(value, {
        maxBytes: LIMITS.resultBytes,
        maxDepth: LIMITS.jsonDepth,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'value is not bounded JSON';
      throw failure(422, 'schema_validation', `${label} data is not bounded JSON`, {
        errors: [schemaError(error?.details?.instancePath ?? '', 'json', message)],
      });
    }
    if (validationNodes > Math.floor(MAX_VALIDATION_WORK / dataNodes)) {
      throw failure(422, 'schema_validation', `${label} data exceeds validation complexity limit`, {
        errors: [schemaError('', 'complexity', `schema and data may require more than ${MAX_VALIDATION_WORK} validation steps`)],
      });
    }

    let valid;
    try {
      valid = compiled(value);
    } catch {
      throw failure(422, 'schema_validation', `${label} could not be validated safely`, {
        errors: [schemaError('', 'validation', 'schema evaluation did not complete')],
      });
    }
    if (!valid) {
      throw failure(422, 'schema_validation', `${label} does not match its schema`, {
        errors: normalizeAjvErrors(compiled.errors),
      });
    }
    return value;
  };
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw failure(400, 'invalid_json', 'JSON value could not be cloned safely');
  }
}

function rejectUnknownFields(value, allowed, code, label) {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) {
    throw failure(400, code, `${label} contains unknown field "${unknown}"`, { field: unknown });
  }
}

function normalizeTimeout(value, fallback, maximum, label) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1_000 || normalized > maximum) {
    throw failure(400, 'invalid_request', `${label} must be a safe integer from 1000 through ${maximum}`);
  }
  return normalized;
}

function declaresObjectSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.type === 'object') return true;
  return Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'object';
}

export function prepareRequest(body, { reservedToolNames = [] } = {}) {
  inspectJson(body, {
    maxBytes: LIMITS.requestBytes,
    maxDepth: LIMITS.jsonDepth,
    sizeCode: 'body_too_large',
    sizeMessage: `request body exceeds ${LIMITS.requestBytes} bytes`,
  });
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw failure(400, 'invalid_request', 'request body must be a JSON object');
  }

  const source = cloneJson(body);
  rejectUnknownFields(source, REQUEST_FIELDS, 'invalid_request', 'request');
  validateIdentity(source);
  validateId(source.requestId);

  if (typeof source.message !== 'string' || source.message.trim().length === 0 || Buffer.byteLength(source.message) > LIMITS.messageBytes) {
    throw failure(400, 'invalid_message', `message must be nonblank and at most ${LIMITS.messageBytes} UTF-8 bytes`);
  }

  const responseMode = source.responseMode === undefined ? 'native' : source.responseMode;
  if (responseMode !== 'native' && responseMode !== 'structured') {
    throw failure(400, 'invalid_request', 'responseMode must be "native" or "structured"');
  }
  if (responseMode === 'native' && hasOwn(source, 'resultSchema')) {
    throw failure(400, 'invalid_request', 'resultSchema is forbidden in native response mode');
  }
  if (responseMode === 'structured' && !hasOwn(source, 'resultSchema')) {
    throw failure(400, 'invalid_request', 'resultSchema is required in structured response mode');
  }

  const timeoutMs = normalizeTimeout(source.timeoutMs, LIMITS.timeoutMs, LIMITS.maxTimeoutMs, 'timeoutMs');
  const requestedToolTimeout = normalizeTimeout(
    source.toolTimeoutMs,
    LIMITS.toolTimeoutMs,
    LIMITS.maxToolTimeoutMs,
    'toolTimeoutMs',
  );
  const toolTimeoutMs = Math.min(requestedToolTimeout, timeoutMs);

  const tools = source.tools === undefined ? [] : source.tools;
  if (!Array.isArray(tools) || tools.length > LIMITS.tools) {
    throw failure(400, 'invalid_tool', `tools must be an array containing at most ${LIMITS.tools} entries`);
  }

  const reserved = new Set(reservedToolNames);
  const names = new Set();
  const normalizedTools = tools.map((tool, index) => {
    const label = `tools[${index}]`;
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
      throw failure(400, 'invalid_tool', `${label} must be an object`);
    }
    rejectUnknownFields(tool, TOOL_FIELDS, 'invalid_tool', label);
    for (const field of TOOL_FIELDS) {
      if (!hasOwn(tool, field)) throw failure(400, 'invalid_tool', `${label}.${field} is required`);
    }
    if (typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name) || tool.name.startsWith('rpc_')) {
      throw failure(400, 'invalid_tool', `${label}.name is invalid or reserved`);
    }
    if (names.has(tool.name) || reserved.has(tool.name)) {
      throw failure(400, 'invalid_tool', `${label}.name collides with another tool`);
    }
    if (typeof tool.description !== 'string') {
      throw failure(400, 'invalid_tool', `${label}.description must be a string`);
    }
    if (!declaresObjectSchema(tool.inputSchema)) {
      throw failure(400, 'invalid_tool', `${label}.inputSchema must declare type "object"`);
    }
    names.add(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      resultSchema: tool.resultSchema,
    };
  });

  const resultValidator = responseMode === 'structured'
    ? compileSchema(source.resultSchema, 'resultSchema')
    : undefined;
  const toolValidators = new Map();
  for (let index = 0; index < normalizedTools.length; index += 1) {
    const tool = normalizedTools[index];
    toolValidators.set(tool.name, {
      input: compileSchema(tool.inputSchema, `tools[${index}].inputSchema`),
      result: compileSchema(tool.resultSchema, `tools[${index}].resultSchema`),
    });
  }

  const request = {
    instanceId: source.instanceId,
    generation: source.generation,
    requestId: source.requestId,
    message: source.message,
    responseMode,
    ...(responseMode === 'structured' ? { resultSchema: source.resultSchema } : {}),
    tools: normalizedTools,
    timeoutMs,
    toolTimeoutMs,
  };

  return { request, resultValidator, toolValidators };
}
