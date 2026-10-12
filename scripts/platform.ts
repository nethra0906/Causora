import { startPlatform } from '../src/platform/server.ts';

await startPlatform(Number(process.env.PORT) || undefined);
console.log('[platform] ready');
