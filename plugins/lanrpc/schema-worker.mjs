import Ajv2020 from 'ajv/dist/2020.js';
import { LIMITS } from './protocol.mjs';

const MAX_REQUEST_FRAME_BYTES = LIMITS.requestBytes + LIMITS.resultBytes + (16 * 1024);
const MAX_RESPONSE_FRAME_BYTES = LIMITS.resultBytes;
const MAP_SCHEMA_KEYWORDS = ['$defs', 'properties', 'patternProperties', 'dependentSchemas'];
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

function pointerPart(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPath(path, key) {
  return `${path}/${pointerPart(String(key))}`;
}

function schemaError(instancePath, keyword, message, schemaPath = '#') {
  return { instancePath, schemaPath, keyword, message };
}

function makeFailure(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, ...(details === undefined ? {} : { details }) });
}

function schemaFailure(label, message, errors) {
  return makeFailure(400, 'invalid_schema', `${label} ${message}`, { errors });
}

function normalizedAjvErrors(errors) {
  return (errors ?? []).map(error => ({
    instancePath: error.instancePath ?? '',
    schemaPath: error.schemaPath ?? '#',
    keyword: error.keyword ?? 'schema',
    message: error.message ?? '',
  }));
}

function forEachSubschema(schema, path, visit) {
  for (const keyword of MAP_SCHEMA_KEYWORDS) {
    const entries = schema[keyword];
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [key, child] of Object.entries(entries)) {
      visit(child, childPath(childPath(path, keyword), key));
    }
  }
  for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
    const entries = schema[keyword];
    if (!Array.isArray(entries)) continue;
    for (let index = 0; index < entries.length; index += 1) {
      visit(entries[index], childPath(childPath(path, keyword), index));
    }
  }
  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (typeof child === 'boolean' || (child !== null && typeof child === 'object' && !Array.isArray(child))) {
      visit(child, childPath(path, keyword));
    }
  }
}

function rejectAsyncSchemas(schema, label) {
  function visit(current, path) {
    if (typeof current === 'boolean' || current === null || typeof current !== 'object' || Array.isArray(current)) return;
    if (Object.hasOwn(current, '$async')) {
      const instancePath = childPath(path, '$async');
      throw schemaFailure(label, `uses unsupported $async at ${instancePath}`, [
        schemaError(instancePath, '$async', 'must not enable executable asynchronous schema extensions'),
      ]);
    }
    forEachSubschema(current, path, visit);
  }
  visit(schema, '');
}

function classifyCompilationError(error) {
  const message = error instanceof Error ? error.message : 'unknown compilation error';
  const normalized = message.toLowerCase();
  if (error?.name === 'MissingRefError' || normalized.includes("can't resolve reference")) {
    return schemaError('', '$ref', message);
  }
  if (normalized.includes('invalid regular expression')) return schemaError('', 'pattern', message);
  if (normalized.includes('unknown keyword')) return schemaError('', 'unknownKeyword', message);
  return schemaError('', 'compile', message);
}

function createAjv() {
  const ajv = new Ajv2020({
    addUsedSchema: false,
    allErrors: false,
    allowMatchingProperties: true,
    allowUnionTypes: true,
    coerceTypes: false,
    logger: false,
    ownProperties: true,
    removeAdditional: false,
    strictRequired: false,
    strictSchema: true,
    strictTuples: false,
    strictTypes: false,
    useDefaults: false,
    validateFormats: false,
  });
  ajv.addKeyword({ keyword: '$anchor', schemaType: 'string', valid: true });
  return ajv;
}

function compile(schema, label) {
  rejectAsyncSchemas(schema, label);
  const ajv = createAjv();
  let validSchema;
  try {
    validSchema = ajv.validateSchema(schema);
  } catch (error) {
    throw schemaFailure(label, 'is not a valid draft 2020-12 schema', [classifyCompilationError(error)]);
  }
  if (!validSchema) {
    throw schemaFailure(
      label,
      'is not a valid draft 2020-12 schema',
      normalizedAjvErrors(ajv.errors),
    );
  }
  try {
    return ajv.compile(schema);
  } catch (error) {
    const detail = classifyCompilationError(error);
    throw schemaFailure(label, `cannot be compiled: ${detail.message}`, [detail]);
  }
}

async function readFrame() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_FRAME_BYTES + 4) throw new Error('request frame exceeded limit');
    chunks.push(chunk);
  }
  const frame = Buffer.concat(chunks, bytes);
  if (frame.length < 4) throw new Error('request frame was truncated');
  const length = frame.readUInt32BE(0);
  if (length > MAX_REQUEST_FRAME_BYTES || frame.length !== length + 4) {
    throw new Error('request frame was invalid');
  }
  return JSON.parse(frame.subarray(4).toString('utf8'));
}

async function writeFrame(value) {
  let payload = Buffer.from(JSON.stringify(value));
  if (payload.length > MAX_RESPONSE_FRAME_BYTES) {
    payload = Buffer.from(JSON.stringify({
      ok: false,
      error: {
        status: 503,
        code: 'validation_worker_failed',
        message: 'schema validation worker response exceeded its limit',
      },
    }));
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  await new Promise((resolve, reject) => {
    process.stdout.write(frame, error => (error ? reject(error) : resolve()));
  });
}

function publicError(error) {
  if (Number.isInteger(error?.status) && typeof error?.code === 'string' && typeof error?.message === 'string') {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    status: 503,
    code: 'validation_worker_failed',
    message: 'schema validation worker could not complete the operation',
  };
}

async function main() {
  try {
    const request = await readFrame();
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid request');
    const label = typeof request.label === 'string' ? request.label : 'schema';
    const validate = compile(request.schema, label);
    if (request.operation === 'validate') {
      let valid;
      try {
        valid = validate(request.data);
      } catch {
        throw makeFailure(422, 'schema_validation', `${label} could not be validated safely`, {
          errors: [schemaError('', 'validation', 'schema evaluation did not complete')],
        });
      }
      if (valid && typeof valid.then === 'function') {
        throw schemaFailure(label, 'uses unsupported asynchronous evaluation', [
          schemaError('', '$async', 'must not enable executable asynchronous schema extensions'),
        ]);
      }
      if (!valid) {
        throw makeFailure(422, 'schema_validation', `${label} does not match its schema`, {
          errors: normalizedAjvErrors(validate.errors),
        });
      }
    } else if (request.operation !== 'compile') {
      throw new Error('unsupported operation');
    }
    await writeFrame({ ok: true });
  } catch (error) {
    await writeFrame({ ok: false, error: publicError(error) });
  }
}

await main();
