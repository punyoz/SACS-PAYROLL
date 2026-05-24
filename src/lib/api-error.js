const TECHNICAL_PATTERNS = [
  'duplicate key value violates',
  'unique constraint',
  'foreign key constraint',
  'violates check constraint',
  'null value in column',
  'not-null constraint',
  'invalid input syntax',
  'could not find the table',
  'relation "',
  'column "',
  'operator does not exist',
  'syntax error at or near',
  'ERROR: ',
  'DETAIL: ',
  'HINT: ',
  'PGRST',
  'Failed to list users:',
  'Failed to fetch profiles:',
  'Failed to fetch attendance',
];

export function sanitizeError(error, fallback = 'Something went wrong. Please try again.') {
  const msg = typeof error === 'string' ? error : (error?.message || String(error || ''));
  if (!msg) return fallback;
  const lower = msg.toLowerCase();

  if (lower.includes('duplicate key') || (lower.includes('already exists') && lower.includes('constraint'))) {
    return 'A record with this information already exists.';
  }
  if (lower.includes('foreign key constraint')) {
    return 'This action cannot be completed due to related records.';
  }
  if (lower.includes('not-null constraint') || lower.includes('null value in column')) {
    return 'Required information is missing.';
  }
  if (lower.includes('invalid input syntax') || lower.includes('invalid uuid')) {
    return 'Invalid data format. Please check your input.';
  }
  if (lower.includes('permission denied') || lower.includes('row-level security')) {
    return 'You do not have permission to perform this action.';
  }
  if (lower.includes('jwt expired') || lower.includes('invalid jwt')) {
    return 'Your session has expired. Please log in again.';
  }

  const isTechnical = TECHNICAL_PATTERNS.some((p) => msg.includes(p) || lower.includes(p.toLowerCase()));
  if (isTechnical || msg.length > 200) return fallback;

  return msg;
}
