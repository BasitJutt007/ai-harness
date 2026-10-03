import express from 'express';
import { problemHandler, routeNotFound } from './http/problems.js';
import { productRouter } from './products/product.router.js';

export const app = express();

app.disable('x-powered-by');
app.use(express.json());
app.use('/v1', productRouter);
app.use(routeNotFound);
app.use(problemHandler);
