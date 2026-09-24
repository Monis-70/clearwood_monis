import { defineConsistencySuite } from './helpers/consistencySuite';

// Admin write -> public read, on the cache driver the suite runs with (memory).
defineConsistencySuite('mutation -> read consistency', { enabled: true });
