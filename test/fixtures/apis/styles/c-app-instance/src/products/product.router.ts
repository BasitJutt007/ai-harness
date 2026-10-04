import { Router } from 'express';
import { conflict, notFound } from '../http/problems.js';
import { NewProduct, Product, ProductPage, ProductParams, ProductPatch, ProductQuery, WriteHeaders } from './product.schemas.js';
import { deleteProduct, findBySku, findProduct, insertProduct, listProducts, rememberReply, replaceProduct, replyFor } from './product.store.js';

export const productRouter = Router();

productRouter.get('/products', (req, res) => {
  const { cursor, limit } = ProductQuery.parse(req.query);
  res.json(ProductPage.parse(listProducts(cursor, limit)));
});

productRouter.post('/products', (req, res) => {
  const key = `POST ${WriteHeaders.parse(req.headers)['idempotency-key']}`;
  const prior = replyFor(key);
  if (prior !== undefined) {
    res.status(201).location(`/v1/products/${prior.id}`).json(Product.parse(prior));
    return;
  }
  const input = NewProduct.parse(req.body);
  if (findBySku(input.sku) !== undefined) throw conflict(`sku ${input.sku} already exists`);
  const product = insertProduct(input);
  rememberReply(key, product);
  res.status(201).location(`/v1/products/${product.id}`).json(Product.parse(product));
});

productRouter.get('/products/:productId', (req, res) => {
  const { productId } = ProductParams.parse(req.params);
  const product = findProduct(productId);
  if (product === undefined) throw notFound(`product ${productId} not found`);
  res.json(Product.parse(product));
});

productRouter.patch('/products/:productId', (req, res) => {
  const { productId } = ProductParams.parse(req.params);
  const key = `PATCH ${productId} ${WriteHeaders.parse(req.headers)['idempotency-key']}`;
  const prior = replyFor(key);
  if (prior !== undefined) {
    res.json(Product.parse(prior));
    return;
  }
  const patch = ProductPatch.parse(req.body);
  const current = findProduct(productId);
  if (current === undefined) throw notFound(`product ${productId} not found`);
  const updated = Product.parse({ ...current, ...patch });
  replaceProduct(updated);
  rememberReply(key, updated);
  res.json(updated);
});

productRouter.delete('/products/:productId', (req, res) => {
  const { productId } = ProductParams.parse(req.params);
  if (!deleteProduct(productId)) throw notFound(`product ${productId} not found`);
  res.sendStatus(204);
});
