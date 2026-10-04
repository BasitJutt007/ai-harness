import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { idempotencyKey } from '../lib/idempotency.js';
import { paginate } from '../lib/paginate.js';
import { conflict, notFound } from '../lib/problem.js';
import { BookListQuerySchema, BookPageSchema, BookParamsSchema, BookSchema, CreateBookSchema } from '../schemas/book.js';
import type { Book } from '../schemas/book.js';
import { BOOK, BOOKS } from './paths.js';

export function booksRouter(): Router {
  const books = new Map<string, Book>();
  const router = Router();

  router.get(BOOKS, (req, res) => {
    const q = BookListQuerySchema.parse(req.query);
    res.json(BookPageSchema.parse(paginate([...books.values()], q.cursor, q.limit)));
  });

  router.post(BOOKS, idempotencyKey, (req, res) => {
    const input = CreateBookSchema.parse(req.body);
    if ([...books.values()].some((b) => b.isbn === input.isbn)) throw conflict(`isbn ${input.isbn} already exists`);
    const book: Book = { id: randomUUID(), ...input };
    books.set(book.id, book);
    res.status(201).location(`/v1${BOOKS}/${book.id}`).json(BookSchema.parse(book));
  });

  router.get(BOOK, (req, res) => {
    const { bookId } = BookParamsSchema.parse(req.params);
    const book = books.get(bookId);
    if (book === undefined) throw notFound(`book ${bookId} does not exist`);
    res.json(BookSchema.parse(book));
  });

  return router;
}
