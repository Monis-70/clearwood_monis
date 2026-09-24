import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { createApp } from '../../src/app';
import { disconnectPrisma } from '../../src/config/prisma';
import { cache, closeDrivers } from '../../src/container';

/**
 * The HTTP server tests/perf-baseline.test.ts loads, forked into its own process so the load
 * generator does not share its CPU, heap or event loop. It answers the parent over IPC with
 * memory, CPU, event-loop delay and cache lookups since the last `mark`.
 */

const lookups = { hits: 0, misses: 0 };
const get = cache.get.bind(cache);
cache.get = (async (key: string) => {
  const value = await get(key);
  if (value === null) lookups.misses += 1;
  else lookups.hits += 1;
  return value;
}) as typeof cache.get;

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let cpuSince = process.cpuUsage();

const app = createApp();
const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'ready', port: (server.address() as AddressInfo).port });
});

process.on('message', (message: { type: string }) => {
  if (message.type === 'mark') {
    cpuSince = process.cpuUsage();
    lookups.hits = 0;
    lookups.misses = 0;
    loopDelay.reset();
    process.send?.({ type: 'marked' });
  } else if (message.type === 'sample') {
    const memory = process.memoryUsage();
    process.send?.({ type: 'sample', rss: memory.rss, heapUsed: memory.heapUsed });
  } else if (message.type === 'gc') {
    (globalThis as { gc?: () => void }).gc?.();
    const memory = process.memoryUsage();
    process.send?.({ type: 'gc', rss: memory.rss, heapUsed: memory.heapUsed });
  } else if (message.type === 'report') {
    const cpu = process.cpuUsage(cpuSince);
    process.send?.({
      type: 'report',
      cpuMs: (cpu.user + cpu.system) / 1000,
      loopDelayP99Ms: loopDelay.percentile(99) / 1e6,
      loopDelayMaxMs: loopDelay.max / 1e6,
      ...lookups,
    });
  } else if (message.type === 'stop') {
    server.close(() => {
      void closeDrivers()
        .then(() => disconnectPrisma())
        .finally(() => process.exit(0));
    });
  }
});
