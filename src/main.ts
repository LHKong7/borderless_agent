/**
 * main.ts - Root launcher for the CLI agent.
 *
 * Run from TypeScript project root:
 *   npx ts-node src/main.ts
 *   node dist/main.js  (after build)
 */

import { main } from './cli/main';

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
