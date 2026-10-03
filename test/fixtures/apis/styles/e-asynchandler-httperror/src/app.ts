import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './errors/http-error.ts';
import { ticketsRouter } from './routes/tickets.ts';
import { sendProblem } from './utils/send-problem.ts';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(ticketsRouter());

  app.use((req: Request, res: Response) => {
    sendProblem(res, 404, `Cannot ${req.method} ${req.path}`);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return sendProblem(res, err.statusCode, err.message);
    if (err instanceof ZodError) return sendProblem(res, 422, err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '));
    if (err instanceof SyntaxError) return sendProblem(res, 400, 'Malformed JSON');
    return sendProblem(res, 500, 'Internal Server Error');
  });

  return app;
}
