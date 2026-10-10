import { z } from 'zod';

/*
 * Runs before any other client code (Next's instrumentation-client convention).
 *
 * The CSP has no 'unsafe-eval' in production (@udemy/web-auth/csp). Zod's JIT probes
 * `new Function` when the first object schema is created (at module evaluation of the
 * contracts); the attempt is caught, but the browser still reports a CSP violation. Run zod
 * without its JIT in the browser: same validation results, no eval.
 */
z.config({ jitless: true });
