import { CustomerController } from './controllers/customer.controller.js';
import { InMemoryCustomerRepository } from './repositories/customer.repository.js';
import { CustomerService } from './services/customer.service.js';

export function buildContainer(): { customerController: CustomerController } {
  const service = new CustomerService(new InMemoryCustomerRepository());
  return { customerController: new CustomerController(service) };
}
