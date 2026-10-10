// Input validation utilities with enforced limits

export const LIMITS = {
  title: 500,           // characters
  description: 50000,   // characters
  comment: 50000,       // characters
  labels: 50,           // count
  dependencies: 100     // count
};

export class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Validate task title
 * @param {string} title - Task title
 * @throws {ValidationError} If title is invalid
 */
export function validateTitle(title) {
  if (title === undefined || title === null) {
    throw new ValidationError('Title is required', 'title');
  }

  if (typeof title !== 'string') {
    throw new ValidationError('Title must be a string', 'title');
  }

  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Title cannot be empty', 'title');
  }

  if (trimmed.length > LIMITS.title) {
    throw new ValidationError(
      `Title exceeds maximum length of ${LIMITS.title} characters`,
      'title'
    );
  }

  return trimmed;
}

/**
 * Validate task description
 * @param {string|undefined} description - Task description
 * @throws {ValidationError} If description is invalid
 */
export function validateDescription(description) {
  if (description === undefined || description === null) {
    return undefined;
  }

  if (typeof description !== 'string') {
    throw new ValidationError('Description must be a string', 'description');
  }

  if (description.length > LIMITS.description) {
    throw new ValidationError(
      `Description exceeds maximum length of ${LIMITS.description} characters`,
      'description'
    );
  }

  return description;
}

/**
 * Validate comment text
 * @param {string} text - Comment text
 * @throws {ValidationError} If comment is invalid
 */
export function validateComment(text) {
  if (text === undefined || text === null) {
    throw new ValidationError('Comment text is required', 'text');
  }

  if (typeof text !== 'string') {
    throw new ValidationError('Comment text must be a string', 'text');
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Comment cannot be empty', 'text');
  }

  if (trimmed.length > LIMITS.comment) {
    throw new ValidationError(
      `Comment exceeds maximum length of ${LIMITS.comment} characters`,
      'text'
    );
  }

  return trimmed;
}

/**
 * Validate priority value
 * @param {number|undefined} priority - Task priority
 * @throws {ValidationError} If priority is invalid
 */
export function validatePriority(priority) {
  if (priority === undefined || priority === null) {
    return undefined;
  }

  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    throw new ValidationError('Priority must be an integer', 'priority');
  }

  return priority;
}

/**
 * Validate max_retries value
 * @param {number|undefined} maxRetries - Maximum retry attempts
 * @throws {ValidationError} If maxRetries is invalid
 */
export function validateMaxRetries(maxRetries) {
  if (maxRetries === undefined || maxRetries === null) {
    return undefined;
  }

  if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries)) {
    throw new ValidationError('max_retries must be an integer', 'max_retries');
  }

  if (maxRetries < 0) {
    throw new ValidationError('max_retries cannot be negative', 'max_retries');
  }

  if (maxRetries > 100) {
    throw new ValidationError('max_retries cannot exceed 100', 'max_retries');
  }

  return maxRetries;
}

/**
 * Validate labels array
 * @param {Array|undefined} labels - Task labels
 * @throws {ValidationError} If labels are invalid
 */
export function validateLabels(labels) {
  if (labels === undefined || labels === null) {
    return undefined;
  }

  if (!Array.isArray(labels)) {
    throw new ValidationError('Labels must be an array', 'labels');
  }

  if (labels.length > LIMITS.labels) {
    throw new ValidationError(
      `Cannot exceed ${LIMITS.labels} labels`,
      'labels'
    );
  }

  for (const label of labels) {
    if (typeof label !== 'string') {
      throw new ValidationError('All labels must be strings', 'labels');
    }
  }

  return labels;
}

/**
 * Validate dependencies array
 * @param {Array|undefined} deps - Task dependencies
 * @throws {ValidationError} If dependencies are invalid
 */
export function validateDeps(deps) {
  if (deps === undefined || deps === null) {
    return undefined;
  }

  if (!Array.isArray(deps)) {
    throw new ValidationError('Dependencies must be an array', 'depends_on');
  }

  if (deps.length > LIMITS.dependencies) {
    throw new ValidationError(
      `Cannot exceed ${LIMITS.dependencies} dependencies`,
      'depends_on'
    );
  }

  for (const dep of deps) {
    if (typeof dep !== 'string') {
      throw new ValidationError('All dependencies must be strings', 'depends_on');
    }
  }

  return deps;
}
