import { HttpProblem, typeUri } from '../lib/problem.ts';

export class UserNotFoundError extends HttpProblem {
  constructor(userId: string) {
    super({ type: typeUri('user-not-found'), title: 'User Not Found', status: 404, detail: `User ${userId} does not exist.` });
  }
}

export class EmailAlreadyRegisteredError extends HttpProblem {
  constructor(email: string) {
    super({ type: typeUri('email-taken'), title: 'Email Already Registered', status: 409, detail: `${email} is already registered.` });
  }
}
