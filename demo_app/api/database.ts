import { Pool, QueryResult } from 'pg'
import * as _ from 'lodash';

/**
 * Required ENV variables to be set:

    PGPORT=5432
    PGDATABASE=
    PGUSER=postgres
    PGHOST=
    PGPASSWORD=
 */

/**
 * Converts SQL field names from snake_case to camelCase.
 * 
 * @param rows Rows from a database query
 * @returns 
 */
export const camelCaseRows = (rows: any[]) => _.map(rows, (row) => 
  _.mapKeys(row, (value, key) => _.camelCase(key)));

/**
 * Escapes single quotes in a string.
 * 
 * @param str String to be escaped
 * @returns escaped string
 */
export const safeString = (str: string) => str?.replace(/'/g, "''") ?? '';

// Add SelectedFacets type (optional but good practice)
export type SelectedFacets = { [key: string]: string[] };

// --- Helper to interpolate query parameters for display ---
export function interpolateQuery(queryText: string, params: any[]): string {
  if (params && params.length == 0) { 
    return queryText; // No params to process for display
  } else {
    let interpolatedQuery = queryText;
    // Handle parameters in reverse order ($10 before $1) to avoid replacing $1 in $10
    for (let i = params.length - 1; i >= 0; i--) {
        const placeholder = `$${i + 1}`;
        const value = params[i];
        let formattedValue: string;

        // Format based on type for SQL literal representation
        if (value === null || typeof value === 'undefined') {
            formattedValue = 'NULL';
        } else if (typeof value === 'string') {
            // Escape single quotes within the string
            formattedValue = `'${value.replace(/'/g, "''")}'`;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            formattedValue = String(value);
        } else if (value instanceof Date) {
            formattedValue = `'${value.toISOString()}'`; // Standard ISO format
        } else if (Array.isArray(value)) {
            // Format as PostgreSQL array literal, handling types within the array
            const arrayValues = value.map(item => {
                if (item === null || typeof item === 'undefined') return 'NULL';
                if (typeof item === 'string') return `'${item.replace(/'/g, "''")}'`;
                if (typeof item === 'number' || typeof item === 'boolean') return String(item);
                if (item instanceof Date) return `'${item.toISOString()}'`;
                // Fallback for other types - might need adjustment
                return `'${String(item).replace(/'/g, "''")}'`;
            }).join(', ');
            formattedValue = `ARRAY[${arrayValues}]`;
        }
        else {
            // Fallback for unknown types (treat as string with escaping)
            formattedValue = `'${String(value).replace(/'/g, "''")}'`;
        }

        // Replace the placeholder - use regex to ensure whole placeholder match
        // Using a regex like /\$N\b/ (word boundary) avoids replacing $1 in $10, $11 etc.
        const placeholderRegex = new RegExp(`\\$${i + 1}\\b`, 'g');
        interpolatedQuery = interpolatedQuery.replace(placeholderRegex, formattedValue);
    }
    return interpolatedQuery;
  }
}

export class Database {
  private pool: Pool;

  constructor() {
    if (!process.env['PGHOST']) {
      throw new Error(`Missing required environment variable: 'PGHOST'`);
    }
    this.pool = new Pool({user: 'postgres'})

    // the pool will emit an error on behalf of any idle clients
    // it contains if a backend error or network partition happens
    this.pool.on('error', (err, client) => {
      console.error('Unexpected error on idle client', err);
    });
  }

  // Query method (for non-parameterized queries like CREATE EXTENSION)
  async query(queryText: string): Promise<any[]> {
    console.log("Running raw query in non-PSV pool:", queryText.substring(0, 100) + "...");
    const client = await this.pool.connect();
    try {
      const res = await client.query(queryText);
      return res.rows;
    } catch (err) {
        console.error(`Error executing raw query: ${queryText.substring(0,100)}...`, err);
        throw err; // Re-throw after logging
    } finally {
      client.release();
    }
  }

  // --- Method for Parameterized Queries ---
  async queryWithParams(queryText: string, params: any[]): Promise<any[]> {
    console.log(`Running parameterized query in non-PSV pool: ${queryText.substring(0, 100)}... with ${params.length} params`);
    const client = await this.pool.connect();
    try {
      const res: QueryResult = await client.query(queryText, params);
      return res.rows;
    } catch (err) {
        console.error(`Error executing parameterized query: ${queryText.substring(0,100)}... with params: ${JSON.stringify(params)}`, err);
        throw err; // Re-throw after logging
    } finally {
      client.release();
    }
  }

  async end() {
    await this.pool.end()
  }
}

export class DatabasePsv {
  private pool: Pool;

  constructor() {
    if (!process.env['PGHOST']) {
      throw new Error(`Missing required environment variable: 'PGHOST'`);
    }
    this.pool = new Pool({user: 'psv_user'})

    // the pool will emit an error on behalf of any idle clients
    // it contains if a backend error or network partition happens
    this.pool.on('error', (err, client) => {
      console.error('Unexpected error on idle client', err);
      throw err;
    })
  }

  async query(query: string) {
    console.log("Running query in PSV pool.")
    const client = await this.pool.connect()
    const res = await client.query(query)
    client.release()
    return res.rows;
  }

  async end() {
    await this.pool.end()
  }
}