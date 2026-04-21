import Redis, { type Cluster } from 'ioredis';
import type { Driver } from './types';
/**
 * redis driver implementation using ioredis
 * multi-server production driver backed by redis
 * works with standalone redis, sentinel, and redis cluster.
 * leverages native key expiry for reservations, set indexes for fast lookups
 */
export declare function createRedisDriver(options?: RedisDriverOptions): Driver;
/** options for creating a redis driver */
export type RedisDriverOptions = {
    /**
     * an existing ioredis client instance (Redis or Cluster).
     * if provided, url is ignored.
     */
    client?: Redis | Cluster;
    /** redis connection url, defaults to $GATHO_REDIS_URL or redis://localhost:6379. ignored if client is provided. */
    url?: string;
    /**
     * key prefix for namespacing, defaults to "gatho:{gatho}:".
     * the {gatho} hash tag ensures all keys land on the same redis cluster slot,
     * while the leading "gatho:" keeps keys human-readable in redis-cli and GUIs.
     * if you override this, include a {hashtag} segment for cluster compatibility,
     * e.g. "myapp:{myapp}:".
     */
    prefix?: string;
};
