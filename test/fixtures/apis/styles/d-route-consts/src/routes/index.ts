import { Router } from 'express';
import { booksRouter } from './books.js';

/** Version-1 resources that are mounted under API_V1. */
export function v1Router(): Router {
  const v1 = Router();
  v1.use(booksRouter());
  return v1;
}
