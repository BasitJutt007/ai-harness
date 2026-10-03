/**
 * Generality: the standards checks recognise meaning, not our template's syntax.
 * - Five compliant APIs in foreign styles, plus variants of them (status constants, enums,
 *   declared library constants, middleware factories, path constants / templates / `as const`
 *   objects, path-less and nested mounts, middleware arrays, positional validators, ports,
 *   action routes, error classes with field statuses) all read 100% on zod-boundary,
 *   rest-conventions and the static part of problem-json.
 * - Mutated copies with one planted violation each FAIL (or are UNPROVEN) at a precise location.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { extractRouteTable } from '../../plugins/lib/api-ast.ts';
import { diffContracts, extractContract } from '../../plugins/lib/contract.ts';
import { HARNESS_ROOT } from '../../src/core/config.ts';
import { exec } from '../../src/core/exec.ts';
import type { CheckFinding } from '../../src/core/plugin-api.ts';
import { contextFor } from './_ctx.ts';
import { STYLE_NAMES, lineIn, removeStyle, staticFindings, styleCopy } from './_styles.ts';
import type { Edits, StyleName } from './_styles.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeStyle(r);
});

async function run(style: StyleName, edits: Edits = {}): Promise<{ root: string; findings: CheckFinding[]; compact: string; rules: Map<string, { status: string; passed: number; total: number }> }> {
  const root = await styleCopy(style, edits);
  roots.push(root);
  const { findings, report } = await staticFindings(root);
  return { root, findings, compact: report.compact, rules: new Map(report.rules.map((r) => [r.rule, r])) };
}

/** Handler and route units per compliant style (zod-boundary, rest-conventions). */
const UNITS: Record<StyleName, number> = {
  'a-validate-mw': 4,
  'b-controller-service': 5,
  'c-app-instance': 5,
  'd-route-consts': 7,
  'e-asynchandler-httperror': 4,
};

describe('compliant foreign styles', () => {
  it.each(STYLE_NAMES)('%s reads 100% on zod-boundary, rest-conventions and static problem-json', async (style) => {
    const { findings, compact, rules } = await run(style);
    expect(findings.filter((f) => f.status !== 'pass'), compact).toEqual([]);
    expect(rules.get('zod-boundary'), compact).toMatchObject({ status: 'pass', passed: UNITS[style], total: UNITS[style] });
    expect(rules.get('rest-conventions'), compact).toMatchObject({ status: 'pass', passed: UNITS[style], total: UNITS[style] });
    expect(rules.get('problem-json')?.status, compact).toBe('pass');
  });
});

const ORDERS = 'src/routes/orders.ts';
const PRODUCTS = 'src/products/product.router.ts';
const BOOKS = 'src/routes/books.ts';
const TICKETS = 'src/routes/tickets.ts';

const STATUS_CONSTS = 'export const HttpStatus = { OK: 200, CREATED: 201, NO_CONTENT: 204, NOT_FOUND: 404, CONFLICT: 409 } as const;\n';

/** Each variant changes how the code is written, never what it does: every one must stay at 100%. */
const COMPLIANT: Array<{ name: string; style: StyleName; edits: Edits; units?: number }> = [
  {
    name: 'statuses from an `as const` object (HttpStatus.CREATED, sendStatus(HttpStatus.NO_CONTENT))',
    style: 'c-app-instance',
    edits: {
      'src/http/status.ts': STATUS_CONSTS,
      [PRODUCTS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport { HttpStatus } from '../http/status.js';"],
        ['res.status(201)', 'res.status(HttpStatus.CREATED)'],
        ['res.sendStatus(204)', 'res.sendStatus(HttpStatus.NO_CONTENT)'],
      ],
    },
  },
  {
    name: 'statuses from a TS enum',
    style: 'c-app-instance',
    edits: {
      'src/http/status.ts': 'export enum Status {\n  Created = 201,\n  NoContent = 204,\n}\n',
      [PRODUCTS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport { Status } from '../http/status.js';"],
        ['res.status(201)', 'res.status(Status.Created)'],
        ['res.sendStatus(204)', 'res.sendStatus(Status.NoContent)'],
      ],
    },
  },
  {
    name: 'statuses from declared library-style constants (literal types only)',
    style: 'c-app-instance',
    edits: {
      'src/http/codes.ts': 'export declare const CREATED: 201;\nexport declare const NO_CONTENT: 204;\n',
      [PRODUCTS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport * as codes from '../http/codes.js';"],
        ['res.status(201)', 'res.status(codes.CREATED)'],
        ['res.sendStatus(204)', 'res.sendStatus(codes.NO_CONTENT)'],
      ],
    },
  },
  {
    name: 'error middleware and not-found handler registered through factories (app.use(problemHandler()))',
    style: 'c-app-instance',
    edits: {
      'src/http/problems.ts': [
        ['export const routeNotFound: RequestHandler = (req, _res, next) =>', 'export const routeNotFound = (): RequestHandler => (req, _res, next) =>'],
        ['export const problemHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {', 'export const problemHandler = (): ErrorRequestHandler => (err: unknown, req, res, _next) => {'],
      ],
      'src/app.ts': [
        ['app.use(routeNotFound);', 'app.use(routeNotFound());'],
        ['app.use(problemHandler);', 'app.use(problemHandler());'],
      ],
    },
  },
  {
    name: 'literal route paths under a const mount prefix and a path-less nested mount',
    style: 'd-route-consts',
    edits: {
      [BOOKS]: [
        ["import { BOOK, BOOKS } from './paths.js';", "import { BOOKS } from './paths.js';"],
        ['router.get(BOOKS, (req', "router.get('/books', (req"],
        ['router.post(BOOKS, idempotencyKey', "router.post('/books', idempotencyKey"],
        ['router.get(BOOK, (req', "router.get('/books/:bookId', (req"],
      ],
      'src/routes/invoices.ts': [
        ["import { INVOICE, INVOICES } from './paths.js';", "import { INVOICES } from './paths.js';"],
        ['router.route(INVOICES)', "router.route('/v1/invoices')"],
        ['router.route(INVOICE)', "router.route('/v1/invoices/:invoiceId')"],
      ],
    },
  },
  {
    name: 'a literal outer mount over a path-less inner mount',
    style: 'd-route-consts',
    edits: { 'src/app.ts': [["import { API_V1 } from './routes/paths.js';\n", ''], ['app.use(API_V1, v1Router());', "app.use('/v1', v1Router());"]] },
  },
  {
    name: 'the books router mounted directly',
    style: 'd-route-consts',
    edits: {
      'src/app.ts': [
        ["import { v1Router } from './routes/index.js';", "import { booksRouter } from './routes/books.js';"],
        ['app.use(API_V1, v1Router());', 'app.use(API_V1, booksRouter());'],
      ],
    },
  },
  {
    name: 'paths built from an `as const` object with + and templates, and a literal-typed helper',
    style: 'd-route-consts',
    edits: {
      'src/routes/paths.ts': [
        "const SEGMENTS = { v1: '/v1', books: 'books', invoices: 'invoices' } as const;\n",
        'const path = <T extends string>(p: T): T => p;\n',
        'export const API_V1 = SEGMENTS.v1;\n',
        "export const INVOICES = SEGMENTS.v1 + '/' + SEGMENTS.invoices;\n",
        'export const INVOICE = `${INVOICES}/:invoiceId`;\n',
        "export const BOOKS = path('/books');\n",
        'export const BOOK = `/${SEGMENTS.books}/:bookId`;\n',
      ].join(''),
    },
  },
  {
    name: 'middleware passed as an array',
    style: 'a-validate-mw',
    edits: { [ORDERS]: [["router.post('/v1/orders', idempotency(), validate({ body: CreateOrder }), (req, res) => {", "router.post('/v1/orders', [idempotency(), validate({ body: CreateOrder })], (req, res) => {"]] },
  },
  {
    name: 'a validator held in a const',
    style: 'a-validate-mw',
    edits: {
      [ORDERS]: [
        ['  const router = Router();', '  const router = Router();\n  const validateCreate = validate({ body: CreateOrder });'],
        ['idempotency(), validate({ body: CreateOrder }),', 'idempotency(), validateCreate,'],
      ],
    },
  },
  {
    name: 'a positional validator (validateOne(Schema, part)) writing back with defineProperty',
    style: 'a-validate-mw',
    edits: {
      'src/middleware/validate.ts': [
        "import type { RequestHandler } from 'express';",
        "import { z } from 'zod';",
        '',
        "export function validateOne(schema: z.ZodType, part: 'params' | 'query' | 'body'): RequestHandler {",
        '  return (req, _res, next) => {',
        '    Object.defineProperty(req, part, { value: schema.parse(req[part]), writable: true, enumerable: true, configurable: true });',
        '    next();',
        '  };',
        '}',
        '',
      ].join('\n'),
      [ORDERS]: [
        ["import { validate } from '../middleware/validate.ts';", "import { validateOne } from '../middleware/validate.ts';"],
        ['validate({ query: ListOrdersQuery })', "validateOne(ListOrdersQuery, 'query')"],
        ['validate({ body: CreateOrder })', "validateOne(CreateOrder, 'body')"],
        ['validate({ params: OrderParams })', "validateOne(OrderParams, 'params')"],
        ['validate({ params: OrderParams })', "validateOne(OrderParams, 'params')"],
      ],
    },
  },
  {
    name: 'a parse stored in res.locals (the handler never reads the raw body)',
    style: 'a-validate-mw',
    edits: {
      [ORDERS]: [
        ['idempotency(), validate({ body: CreateOrder }), (req, res) => {\n    const order = store.create(req.body);', 'idempotency(), (req, res, next) => {\n    res.locals[\'input\'] = CreateOrder.parse(req.body);\n    next();\n  }, (_req, res) => {\n    const order = store.create(CreateOrder.parse(res.locals[\'input\']));'],
      ],
    },
  },
  {
    name: 'ports with function-typed properties and a method-only type alias are not DTOs',
    style: 'b-controller-service',
    edits: {
      'src/repositories/customer.repository.ts': [
        ['  findByEmail(email: string): Promise<Customer | undefined>;', '  findByEmail: (email: string) => Promise<Customer | undefined>;'],
        ['export class InMemoryCustomerRepository', 'export type Clock = { now(): Date };\n\nexport class InMemoryCustomerRepository'],
      ],
    },
  },
  {
    name: 'an action sub-resource (POST /v1/customers/:customerId/archive responds 200)',
    style: 'b-controller-service',
    units: 6,
    edits: {
      'src/schemas/customer.schema.ts': [['export const customerIdParamsSchema', "export const archiveCustomerSchema = z.object({ reason: z.string().max(200).optional() });\nexport const customerIdParamsSchema"]],
      'src/controllers/customer.controller.ts': [
        ['  createCustomerSchema,', '  archiveCustomerSchema,\n  createCustomerSchema,'],
        ['  remove = async', '  archive = async (req: Request, res: Response): Promise<void> => {\n    const { customerId } = customerIdParamsSchema.parse(req.params);\n    archiveCustomerSchema.parse(req.body);\n    const customer = await this.service.get(customerId);\n    res.json(customerSchema.parse(customer));\n  };\n\n  remove = async'],
      ],
      'src/routes/customer.routes.ts': [["  router.delete('/:customerId', controller.remove);", "  router.delete('/:customerId', controller.remove);\n  router.post('/:customerId/archive', requireIdempotencyKey, controller.archive);"]],
    },
  },
  {
    name: 'error classes whose status is a field initializer',
    style: 'e-asynchandler-httperror',
    edits: {
      'src/errors/http-error.ts': [
        'export abstract class HttpError extends Error {',
        '  abstract readonly statusCode: number;',
        '}',
        '',
        'export class NotFoundError extends HttpError {',
        '  readonly statusCode = 404;',
        '  constructor(resource: string, id: string) {',
        "    super(`${resource} '${id}' not found`);",
        '  }',
        '}',
        '',
        'export class ConflictError extends HttpError {',
        '  readonly statusCode = 409;',
        '}',
        '',
      ].join('\n'),
    },
  },
];

describe('compliant variants of the foreign styles', () => {
  it.each(COMPLIANT.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { findings, compact, rules } = await run(c.style, c.edits);
    expect(findings.filter((f) => f.status !== 'pass'), compact).toEqual([]);
    const units = c.units ?? UNITS[c.style];
    expect(rules.get('zod-boundary'), compact).toMatchObject({ status: 'pass', passed: units, total: units });
    expect(rules.get('rest-conventions'), compact).toMatchObject({ status: 'pass', passed: units, total: units });
    expect(rules.get('problem-json')?.status, compact).toBe('pass');
  });
});

type Rule = 'zod-boundary' | 'rest-conventions' | 'problem-json';
interface Planted {
  name: string;
  style: StyleName;
  edits: Edits;
  /** The rule that must FAIL (or be UNPROVEN) because of the planted violation. */
  rule: Rule;
  status: 'fail' | 'unproven';
  /** [file, needle on the offending line, message substring]; for unproven, matched against the skip reason. */
  at: Array<[string, string, string]>;
}

const PLANTED: Planted[] = [
  {
    name: 'unparsed body in the middleware chain',
    style: 'a-validate-mw',
    rule: 'zod-boundary',
    status: 'fail',
    edits: {
      [ORDERS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport type { RequestHandler } from 'express';"],
        ['export function ordersRouter', "const stampSource: RequestHandler = (req, _res, next) => {\n  req.body = { ...req.body, source: 'api' };\n  next();\n};\n\nexport function ordersRouter"],
        ['validate({ body: CreateOrder })', 'stampSource'],
      ],
    },
    at: [
      [ORDERS, '...req.body', 'POST /v1/orders: req.body is read without <ZodSchema>.parse()'],
      [ORDERS, 'store.create(req.body)', 'POST /v1/orders: req.body is read without <ZodSchema>.parse()'],
      [ORDERS, "router.post('/v1/orders'", 'POST /v1/orders: request body is not parsed'],
    ],
  },
  {
    name: 'a validation-only middleware (no write-back) and a raw body read in the handler',
    style: 'a-validate-mw',
    rule: 'zod-boundary',
    status: 'fail',
    edits: { 'src/middleware/validate.ts': [['req.body = schemas.body.parse(req.body);', 'schemas.body.parse(req.body);']] },
    at: [[ORDERS, 'store.create(req.body)', 'POST /v1/orders: req.body is read without <ZodSchema>.parse()']],
  },
  {
    name: 'a hand-written DTO array alias',
    style: 'c-app-instance',
    rule: 'zod-boundary',
    status: 'fail',
    edits: { 'src/products/product.schemas.ts': [['export type Product = ', 'export type ProductRows = { id: string; sku: string }[];\nexport type Product = ']] },
    at: [['src/products/product.schemas.ts', 'export type ProductRows', 'type ProductRows: hand-written type']],
  },
  {
    name: 'a TS enum duplicating a z.enum',
    style: 'a-validate-mw',
    rule: 'zod-boundary',
    status: 'fail',
    edits: { 'src/schemas.ts': [['export const Order = ', "export enum OrderStatusCode {\n  Pending = 'pending',\n  Paid = 'paid',\n  Cancelled = 'cancelled',\n}\nexport const Order = "]] },
    at: [['src/schemas.ts', 'export enum OrderStatusCode', 'enum OrderStatusCode: duplicates a z.enum']],
  },
  {
    name: 'a hand-written DTO class',
    style: 'b-controller-service',
    rule: 'zod-boundary',
    status: 'fail',
    edits: { 'src/schemas/customer.schema.ts': [['export const customerSchema', 'export class CustomerDto {\n  id = \'\';\n  email = \'\';\n}\n\nexport const customerSchema']] },
    at: [['src/schemas/customer.schema.ts', 'export class CustomerDto', 'class CustomerDto: hand-written DTO class']],
  },
  {
    name: 'a raw 409 error sent with a non-literal status and a schema-parsed body',
    style: 'd-route-consts',
    rule: 'problem-json',
    status: 'fail',
    edits: {
      [BOOKS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport { z } from 'zod';\n\nconst ErrorBody = z.object({ code: z.string(), isbn: z.string() });\nconst STATUS_BY_KIND: Record<string, number> = { conflict: 409 };\nfunction statusFor(kind: string): number {\n  return STATUS_BY_KIND[kind] ?? 500;\n}"],
        ['throw conflict(`isbn ${input.isbn} already exists`);', "{\n      res.status(statusFor('conflict')).json(ErrorBody.parse({ code: 'conflict', isbn: input.isbn }));\n      return;\n    }"],
      ],
    },
    at: [[BOOKS, "res.status(statusFor('conflict'))", "status statusFor('conflict') is not a constant, so this may be an error response"]],
  },
  {
    name: 'a variable-path route with an unparsed body',
    style: 'e-asynchandler-httperror',
    rule: 'zod-boundary',
    status: 'fail',
    edits: {
      [TICKETS]: [
        [
          '  return router;',
          "  const IMPORTS = process.env['TICKET_IMPORTS_PATH'] ?? '/v1/ticket-imports';\n  router.post(\n    IMPORTS,\n    asyncHandler(async (req, res): Promise<void> => {\n      idempotencyHeaders.parse(req.headers);\n      const rows = req.body;\n      res.status(201).json(ticketListResponse.parse({ data: rows, nextCursor: null }));\n    }),\n  );\n\n  return router;",
        ],
      ],
    },
    at: [
      [TICKETS, 'const rows = req.body', 'POST <IMPORTS>: req.body is read without <ZodSchema>.parse()'],
      [TICKETS, 'asyncHandler(async (req, res): Promise<void> => {', 'POST <IMPORTS>: request body is not parsed'],
    ],
  },
  {
    name: 'a variable-path route: its path rules are UNPROVEN, never passed',
    style: 'e-asynchandler-httperror',
    rule: 'rest-conventions',
    status: 'unproven',
    edits: {
      [TICKETS]: [
        [
          '  return router;',
          "  const IMPORTS = process.env['TICKET_IMPORTS_PATH'] ?? '/v1/ticket-imports';\n  router.post(\n    IMPORTS,\n    asyncHandler(async (req, res) => {\n      idempotencyHeaders.parse(req.headers);\n      const body = createTicketBody.parse(req.body);\n      res.status(201).json(ticketSchema.parse({ id: crypto.randomUUID(), status: 'open', ...body }));\n    }),\n  );\n\n  return router;",
        ],
      ],
    },
    at: [[TICKETS, '    IMPORTS,', 'route path IMPORTS is not a constant string']],
  },
  {
    name: 'a mount prefix that is not a constant: the mounted routes are UNPROVEN',
    style: 'd-route-consts',
    rule: 'rest-conventions',
    status: 'unproven',
    edits: { 'src/app.ts': [['app.use(API_V1, v1Router());', "app.use(process.env['API_PREFIX'] ?? API_V1, v1Router());"]] },
    at: [['src/app.ts', "process.env['API_PREFIX']", 'mount prefix process.env']],
  },
  {
    name: 'an idempotency middleware that never reads the Idempotency-Key header',
    style: 'b-controller-service',
    rule: 'rest-conventions',
    status: 'fail',
    edits: {
      'src/middleware/idempotency.ts': "import type { RequestHandler } from 'express';\n\nexport const requireIdempotencyKey: RequestHandler = (_req, _res, next) => {\n  next();\n};\n",
    },
    at: [
      ['src/routes/customer.routes.ts', "router.post('/'", 'POST /v1/customers: no idempotency'],
      ['src/routes/customer.routes.ts', "router.patch('/:customerId'", 'PATCH /v1/customers/:customerId: no idempotency'],
    ],
  },
  {
    name: 'problem objects (typed) missing detail and instance',
    style: 'b-controller-service',
    rule: 'problem-json',
    status: 'fail',
    edits: {
      'src/schemas/problem.schema.ts': [['  detail: z.string(),\n  instance: z.string(),\n', '']],
      'src/middleware/error-handler.ts': [[', status, detail, instance });', ', status });']],
    },
    at: [
      ['src/middleware/error-handler.ts', "const body = problem(404", 'problem(...) does not supply detail, instance'],
      ['src/middleware/error-handler.ts', 'res.status(404)', 'status 404 is sent with a non-problem body (missing detail, instance)'],
      ['src/middleware/error-handler.ts', 'res.status(body.status)', 'status body.status is not a constant'],
    ],
  },
  {
    name: 'a problem literal missing instance',
    style: 'e-asynchandler-httperror',
    rule: 'problem-json',
    status: 'fail',
    edits: { 'src/utils/send-problem.ts': [[', detail, instance: res.req.originalUrl });', ', detail });']] },
    at: [['src/utils/send-problem.ts', '  res\n    .status(status)', 'status status is not a constant, so this may be an error response, and its body is not a problem (missing instance)']],
  },
  {
    name: 'a permissive record schema as the response',
    style: 'c-app-instance',
    rule: 'zod-boundary',
    status: 'fail',
    edits: {
      [PRODUCTS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport { z } from 'zod';"],
        ['  res.json(Product.parse(product));\n});\n\nproductRouter.patch', '  res.json(z.record(z.string(), z.unknown()).parse(product));\n});\n\nproductRouter.patch'],
      ],
    },
    at: [[PRODUCTS, 'res.json(z.record(', 'GET /v1/products/:productId: response schema z.record(z.string(), z.unknown()) accepts anything']],
  },
  {
    name: 'an empty passthrough object as the request body schema',
    style: 'c-app-instance',
    rule: 'zod-boundary',
    status: 'fail',
    edits: { 'src/products/product.schemas.ts': [["export const NewProduct = Product.omit({ id: true });", 'export const NewProduct = z.object({}).passthrough();']] },
    at: [[PRODUCTS, 'NewProduct.parse(req.body)', 'POST /v1/products: NewProduct accepts anything']],
  },
  {
    name: 'a status enum member outside the allowed set',
    style: 'c-app-instance',
    rule: 'rest-conventions',
    status: 'fail',
    edits: {
      'src/http/status.ts': 'export enum Status {\n  Teapot = 418,\n}\n',
      [PRODUCTS]: [
        ["import { Router } from 'express';", "import { Router } from 'express';\nimport { Status } from '../http/status.js';"],
        ['  res.json(Product.parse(product));\n});\n\nproductRouter.patch', '  res.status(Status.Teapot).json(Product.parse(product));\n});\n\nproductRouter.patch'],
      ],
    },
    at: [[PRODUCTS, 'res.status(Status.Teapot)', 'status 418 is not in the allowed set']],
  },
  {
    name: 'an error class the error middleware does not handle (client gets a 500)',
    style: 'e-asynchandler-httperror',
    rule: 'problem-json',
    status: 'fail',
    edits: {
      'src/errors/http-error.ts': [['export class NotFoundError', 'export class MissingTicketError extends Error {\n  readonly statusCode = 404;\n}\n\nexport class NotFoundError']],
      [TICKETS]: [
        ["import { ConflictError, NotFoundError } from '../errors/http-error.ts';", "import { ConflictError, MissingTicketError, NotFoundError } from '../errors/http-error.ts';"],
        ["      if (!ticket) throw new NotFoundError('ticket', ticketId);", '      if (!ticket) throw new MissingTicketError();'],
      ],
    },
    at: [[TICKETS, 'throw new MissingTicketError()', 'GET /v1/tickets/:ticketId: new MissingTicketError(...) is not a problem']],
  },
  {
    name: 'an error middleware branch that only forwards the error class does not make it a problem',
    style: 'e-asynchandler-httperror',
    rule: 'problem-json',
    status: 'fail',
    edits: {
      'src/app.ts': [['_next: NextFunction) => {\n    if (err instanceof HttpError) return sendProblem(res, err.statusCode, err.message);', 'next: NextFunction) => {\n    if (err instanceof HttpError) return next(err);']],
    },
    at: [[TICKETS, "if (!ticket) throw new NotFoundError('ticket', ticketId)", 'GET /v1/tickets/:ticketId: new NotFoundError(...) is not a problem']],
  },
  {
    name: 'the unhandled error class leaves GET :ticketId without a 404 path',
    style: 'e-asynchandler-httperror',
    rule: 'rest-conventions',
    status: 'fail',
    edits: {
      'src/errors/http-error.ts': [['export class NotFoundError', 'export class MissingTicketError extends Error {\n  readonly statusCode = 404;\n}\n\nexport class NotFoundError']],
      [TICKETS]: [
        ["import { ConflictError, NotFoundError } from '../errors/http-error.ts';", "import { ConflictError, MissingTicketError, NotFoundError } from '../errors/http-error.ts';"],
        ["      if (!ticket) throw new NotFoundError('ticket', ticketId);", '      if (!ticket) throw new MissingTicketError();'],
      ],
    },
    at: [[TICKETS, "  router.get(\n    '/v1/tickets/:ticketId'", 'GET /v1/tickets/:ticketId: no 404 path']],
  },
  {
    name: 'a sub-collection POST after an id is not an action: it must respond 201',
    style: 'b-controller-service',
    rule: 'rest-conventions',
    status: 'fail',
    edits: {
      'src/controllers/customer.controller.ts': [['  remove = async', '  addNote = async (req: Request, res: Response): Promise<void> => {\n    const { customerId } = customerIdParamsSchema.parse(req.params);\n    const input = updateCustomerSchema.parse(req.body);\n    const customer = await this.service.update(customerId, input);\n    res.json(customerSchema.parse(customer));\n  };\n\n  remove = async']],
      'src/routes/customer.routes.ts': [["  router.delete('/:customerId', controller.remove);", "  router.delete('/:customerId', controller.remove);\n  router.post('/:customerId/notes', requireIdempotencyKey, controller.addNote);"]],
    },
    at: [['src/controllers/customer.controller.ts', 'res.json(customerSchema.parse(customer));\n  };\n\n  remove', 'POST /v1/customers/:customerId/notes: creating a resource must respond res.status(201)']],
  },
  {
    name: 'an action segment is only exempt from plural on POST',
    style: 'b-controller-service',
    rule: 'rest-conventions',
    status: 'fail',
    edits: { 'src/routes/customer.routes.ts': [["  router.delete('/:customerId', controller.remove);", "  router.delete('/:customerId', controller.remove);\n  router.get('/:customerId/archive', controller.getById);"]] },
    at: [['src/routes/customer.routes.ts', "router.get('/:customerId/archive'", 'segment "archive" is not a plural noun']],
  },
];

describe('planted violations in the foreign styles', () => {
  it.each(PLANTED.map((p) => [p.name, p] as const))('%s', async (_name, p) => {
    const { root, findings, compact, rules } = await run(p.style, p.edits);
    expect(rules.get(p.rule)?.status, compact).toBe(p.status);
    const mine = findings.filter((f) => f.rule === p.rule);
    for (const [file, needle, message] of p.at) {
      const line = await lineIn(root, file, needle);
      if (p.status === 'fail') {
        const hit = mine.flatMap((f) => f.violations).some((v) => v.location.startsWith(`${file}:${line}:`) && v.message.includes(message));
        expect(hit, `${file}:${line} ${message}\n${compact}`).toBe(true);
      } else {
        const hit = mine.some((f) => f.status === 'skip' && (f.skipReason ?? '').startsWith(`${file}:${line}:`) && (f.skipReason ?? '').includes(message));
        expect(hit, `${file}:${line} ${message}\n${JSON.stringify(mine.filter((f) => f.status === 'skip'))}`).toBe(true);
      }
    }
  });
});

describe('the contract follows the middleware chain', () => {
  it('style a: request slots come from validate({...}) with the call-site schema, and a breaking body change is caught', async () => {
    const before = await styleCopy('a-validate-mw');
    const after = await styleCopy('a-validate-mw', {
      'src/schemas.ts': [['quantity: z.number().int().min(1).max(1000),', 'quantity: z.number().int().min(1).max(10),\n  customerId: z.string(),']],
    });
    roots.push(before, after);
    const ctx = await contextFor(before);
    const post = extractRouteTable(ctx.program(), ctx.root, ctx.sourceFiles).routes.find((r) => r.method === 'post');
    expect(post?.parses.map((p) => [p.target, p.schema.module, p.schema.exportName])).toEqual([
      ['headers', undefined, undefined], // a module-local schema in the idempotency middleware: static fallback
      ['body', 'src/schemas.ts', 'CreateOrder'],
    ]);
    const a = await extractContract({ apiRoot: before, harnessRoot: HARNESS_ROOT, exec, trusted: () => true });
    const b = await extractContract({ apiRoot: after, harnessRoot: HARNESS_ROOT, exec, trusted: () => true });
    expect(a.endpoints.map((e) => `${e.method} ${e.path} ${Object.keys(e.request).sort().join(',')}`)).toEqual([
      'GET /v1/orders query',
      'POST /v1/orders body,headers',
      'DELETE /v1/orders/:orderId params',
      'GET /v1/orders/:orderId params',
    ]);
    const breaking = diffContracts(a, b).breaking.map((c) => c.location);
    expect(breaking.some((l) => l.startsWith('POST /v1/orders body')), JSON.stringify(breaking)).toBe(true);
  });
});
