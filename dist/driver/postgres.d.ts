import type { Sql } from 'postgres';
import type { Driver } from './types';
/**
 * postgres driver implementation using porsager/postgres
 * multi-server production driver backed by postgresql
 * uses UNLOGGED tables (ephemeral data, no WAL overhead),
 * LISTEN/NOTIFY for waitForRoom, and row-level leader election.
 */
export declare function createPostgresDriver(options?: PostgresDriverOptions): Promise<Driver>;
/** options for creating a postgres driver */
export type PostgresDriverOptions = {
    /**
     * an existing postgres.js sql instance.
     * if provided, url is ignored.
     */
    sql?: Sql;
    /**
     * postgres connection url, defaults to $GATHO_POSTGRES_URL or postgresql://localhost:5432/gatho.
     * ignored if sql is provided.
     */
    url?: string;
    /**
     * postgres schema name used to namespace all gatho tables.
     * defaults to "gatho". analogous to the redis driver's `prefix` option.
     */
    schema?: string;
};
