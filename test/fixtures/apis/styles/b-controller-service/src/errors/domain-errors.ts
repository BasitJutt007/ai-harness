/** Domain errors thrown by services. They know nothing about HTTP; the error middleware maps them. */
export class DomainError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EntityNotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`, 'not_found');
  }
}

export class DuplicateEntityError extends DomainError {
  constructor(entity: string, field: string) {
    super(`a ${entity} with this ${field} already exists`, 'duplicate');
  }
}

export class InvalidCursorError extends DomainError {
  constructor() {
    super('cursor is invalid or expired', 'invalid_cursor');
  }
}
