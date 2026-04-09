import { ZodError } from 'zod';

/**
 * Creates an Express middleware that validates req.body against a Zod schema.
 * Returns 422 with field-level error details on failure.
 *
 * @param {import('zod').ZodSchema} schema
 */
export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.errors.map((e) => ({
          field:   e.path.join('.'),
          message: e.message,
        }));
        return res.status(422).json({
          success: false,
          message: 'Validation failed',
          errors,
        });
      }
      next(err);
    }
  };
}
