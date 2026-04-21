import type { Driver } from './types';
/**
 * An in-memory driver.
 * good for local development, tests, and situationally onebox dev environments.
 * note that you must pass the same driver object to both the server and sdk in order for them to see each other's state.
 */
export declare function createMemoryDriver(): Driver;
