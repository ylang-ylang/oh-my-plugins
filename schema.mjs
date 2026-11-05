import { Buffer } from 'node:buffer';
import { LIMITS, failure, validateId, validateIdentity } from './protocol.mjs';
import { runSchemaOperation } from './schema-runtime.mjs';

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
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

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

function isArrayIndex(key, length) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key.length > 1 && key[0] === '0') return false;
  let index = 0;
  for (let position = 0; position < key.length; position += 1) {
    const digit = key.charCodeAt(position) - 48;
    if (digit < 0 || digit > 9) return false;
    index = (index * 10) + digit;
    if (!Number.isSafeInteger(index)) return false;
  }
  return index < length;
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
        if (key !== 'length' && !isArrayIndex(key, current.length)) {
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

function assertSchemaBounds(schema, label) {
  let nodes;
  try {
    ({ nodes } = inspectJson(schema, { maxBytes: LIMITS.requestBytes, maxDepth: LIMITS.jsonDepth }));
  } catch (error) {
    if (!error?.code) throw error;
    throw schemaFailure(label, error.message, [
      schemaError(error.details?.instancePath ?? '', 'json', error.message),
    ]);
  }
  if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) {
    throw schemaFailure(label, 'must be a boolean or object JSON Schema', [
      schemaError('', 'type', 'must be a boolean or object'),
    ]);
  }
  if (nodes > LIMITS.schemaNodes) {
    throw schemaFailure(label, `exceeds ${LIMITS.schemaNodes} JSON nodes`, [
      schemaError('', 'maxNodes', `must contain at most ${LIMITS.schemaNodes} JSON nodes`),
    ]);
  }
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw failure(400, 'invalid_json', 'JSON value could not be cloned safely');
  }
}

function validationJsonFailure(label, error) {
  const message = error instanceof Error ? error.message : 'value is not bounded JSON';
  return failure(422, 'schema_validation', `${label} data is not bounded JSON`, {
    errors: [schemaError(error?.details?.instancePath ?? '', 'json', message)],
  });
}

function assertSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (signal?.aborted) throw failure(409, 'validation_aborted', 'schema validation operation was aborted');
}

export async function compileSchema(schema, label = 'schema', {
  signal,
  timeoutMs = LIMITS.validationTimeoutMs,
} = {}) {
  assertSignal(signal);
  assertSchemaBounds(schema, label);
  const isolatedSchema = cloneJson(schema);
  await runSchemaOperation(
    { operation: 'compile', schema: isolatedSchema, label },
    { signal, timeoutMs },
  );

  return async function validate(value, { signal: validationSignal } = {}) {
    assertSignal(validationSignal);
    try {
      inspectJson(value, { maxBytes: LIMITS.resultBytes, maxDepth: LIMITS.jsonDepth });
    } catch (error) {
      throw validationJsonFailure(label, error);
    }
    const isolatedValue = cloneJson(value);
    await runSchemaOperation(
      { operation: 'validate', schema: isolatedSchema, data: isolatedValue, label },
      { signal: validationSignal, timeoutMs },
    );
    return value;
  };
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

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isToolName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !isAsciiLetter(value.charCodeAt(0))) {
    return false;
  }
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiLetter(code) && (code < 48 || code > 57) && code !== 95) return false;
  }
  return true;
}

async function compileSchemas(entries, signal) {
  if (entries.length === 0) return [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const operations = entries.map(({ schema, label }) => compileSchema(schema, label, { signal: controller.signal }));
  try {
    return await Promise.all(operations);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(operations);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export async function prepareRequest(body, { reservedToolNames = [], signal } = {}) {
  assertSignal(signal);
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
    if (!isToolName(tool.name) || tool.name.startsWith('rpc_')) {
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

  const schemas = [];
  if (responseMode === 'structured') schemas.push({ schema: source.resultSchema, label: 'resultSchema' });
  for (let index = 0; index < normalizedTools.length; index += 1) {
    const tool = normalizedTools[index];
    schemas.push({ schema: tool.inputSchema, label: `tools[${index}].inputSchema` });
    schemas.push({ schema: tool.resultSchema, label: `tools[${index}].resultSchema` });
  }
  const compiled = await compileSchemas(schemas, signal);
  let compiledIndex = 0;
  const resultValidator = responseMode === 'structured' ? compiled[compiledIndex++] : undefined;
  const toolValidators = new Map();
  for (const tool of normalizedTools) {
    toolValidators.set(tool.name, {
      input: compiled[compiledIndex++],
      result: compiled[compiledIndex++],
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
