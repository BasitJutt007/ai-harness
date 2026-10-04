import type { Request, Response } from 'express';
import {
  createCustomerSchema,
  customerIdParamsSchema,
  customerListSchema,
  customerSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from '../schemas/customer.schema.js';
import type { CustomerService } from '../services/customer.service.js';

export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = listCustomersQuerySchema.parse(req.query);
    const page = await this.service.list(query);
    res.json(customerListSchema.parse(page));
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { customerId } = customerIdParamsSchema.parse(req.params);
    const customer = await this.service.get(customerId);
    res.json(customerSchema.parse(customer));
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const input = createCustomerSchema.parse(req.body);
    const customer = await this.service.create(input);
    res.status(201).location(`${req.baseUrl}/${customer.id}`).json(customerSchema.parse(customer));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { customerId } = customerIdParamsSchema.parse(req.params);
    const patch = updateCustomerSchema.parse(req.body);
    const customer = await this.service.update(customerId, patch);
    res.json(customerSchema.parse(customer));
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { customerId } = customerIdParamsSchema.parse(req.params);
    await this.service.remove(customerId);
    res.status(204).send();
  };
}
