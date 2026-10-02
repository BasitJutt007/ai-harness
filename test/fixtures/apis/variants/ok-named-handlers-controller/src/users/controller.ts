import type { Request, Response } from 'express';
import { notFound } from '../lib/problem.ts';
import { CreateUserBody, ListUsersQuery, UpdateUserBody, User, UserPage, UserParams } from './schemas.ts';
import type { UserService } from './service.ts';

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;

export async function listUsers(req: Request, res: Response): Promise<void> {
  const query = ListUsersQuery.parse(req.query);
  const page = UserPage.parse(service().list(query));
  res.json(page);
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const input = CreateUserBody.parse(req.body);
  const user = service().create(input);
  const body = User.parse(user);
  res.location(`/v1/users/${body.id}`);
  res.status(HTTP_CREATED).json(body);
}

export class UsersController {
  constructor(private readonly users: UserService) {}

  getUser = async (req: Request, res: Response): Promise<void> => {
    const { userId } = UserParams.parse(req.params);
    const user = this.users.get(userId);
    if (user === undefined) throw notFound(`user ${userId} does not exist`);
    res.json(User.parse(user));
  };

  updateUser = async (req: Request, res: Response): Promise<void> => {
    const { userId } = UserParams.parse(req.params);
    const changes = UpdateUserBody.parse(req.body);
    const user = this.users.update(userId, changes);
    if (user === undefined) throw notFound(`user ${userId} does not exist`);
    const dto = User.parse(user);
    res.status(200).json(dto);
  };

  async deleteUser(req: Request, res: Response): Promise<void> {
    const { userId } = UserParams.parse(req.params);
    if (!this.users.remove(userId)) throw notFound(`user ${userId} does not exist`);
    res.status(HTTP_NO_CONTENT).end();
  }
}

let current: UserService | undefined;
export function bindService(s: UserService): void {
  current = s;
}
function service(): UserService {
  if (current === undefined) throw new Error('UserService not bound');
  return current;
}
