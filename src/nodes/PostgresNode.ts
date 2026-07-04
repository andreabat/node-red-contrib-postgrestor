import mustache from 'mustache';
import { getREDNodes } from '../lib/red';
import type { PostgresNodeConfig } from '../lib/types';
import { bindNamedParams } from '../lib/params';
import { formatError } from '../lib/errorFormatter';
import { buildQueryTypes } from '../lib/typeMapping';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export function PostgresNode(this: any, config: PostgresNodeConfig) {
  const RED = getREDNodes();
  const node = this;
  RED.createNode(node, config);
  node.topic = config.topic;
  node.config = RED.getNode(config.PostgresDBNode);

  node.on('input', (msg: any) => {
    const query = mustache.render(config.query, { msg });

    const useNamedParams = config.useNamedParams === true || config.useNamedParams === 'true';
    const isParamsObject = typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params);
    const resolvedParams = useNamedParams && isParamsObject
      ? bindNamedParams(query, msg.params)
      : (Array.isArray(msg.params) ? msg.params : []);

    const transactionMode = config.transactionMode === true || config.transactionMode === 'true';
    const cursorMode = config.cursorMode === true || config.cursorMode === 'true';
    const copyMode = config.copyMode === true || config.copyMode === 'true';
    const retryEnabled = config.retryEnabled === true || config.retryEnabled === 'true';
    const cursorBatchSize = parseInt(String(config.cursorBatchSize || 100), 10);
    const maxRetries = parseInt(String(config.maxRetries || 3), 10);
    const retryBaseDelay = parseInt(String(config.retryBaseDelay || 100), 10);

    const TRANSIENT_CODES = new Set([
      '40P01', '40001', '57P01', '57P02', '57P03',
      '08003', '08006', '08001'
    ]);
    const CONNECTION_ERROR_PATTERNS: RegExp[] = [
      /connection (reset|refused|terminated)/i,
      /ECONNREFUSED/i,
      /ECONNRESET/i,
    ];
    function isTransientError(err: any): boolean {
      if (err.code && TRANSIENT_CODES.has(err.code)) return true;
      if (err.message && CONNECTION_ERROR_PATTERNS.some(p => p.test(err.message))) return true;
      return false;
    }

    const asyncQuery = async () => {
      let client: any = null;
      const timeoutMs = parseInt(String(config.queryTimeout || 0), 10);
      try {
        node.debug(`Connecting to database with query: ${query}`);
        client = await node.config.pgPool.connect();
        node.log('Connected to database');

        if (timeoutMs > 0) {
          try {
            await client.query(`SET statement_timeout = ${timeoutMs}`);
          } catch (setErr: any) {
            node.warn(`Could not set statement_timeout: ${setErr.message}`);
          }
        }

        // COPY path (no retry, D-10)
        if (copyMode && query.trim().toUpperCase().startsWith('COPY')) {
          // Detect COPY direction: FROM STDIN vs TO STDOUT.
          // Use targeted regex rather than a loose includes('FROM') which
          // falsely matches FROM inside COPY (subquery) TO STDOUT.
          if (/\bFROM\s+STDIN\b/i.test(query)) {
            // Defensive: CopyFromQueryStream lacks handleCopyData; if pg events
            // leak through (e.g. a misrouted COPY TO query), this prevents a crash.
            const fromStream = copyFrom(query);
            (fromStream as unknown as Record<string, (...args: unknown[]) => void>).handleCopyData = () => {};
            (fromStream as unknown as Record<string, (...args: unknown[]) => void>).handleCopyOutResponse = () => {};
            const ingestStream = client.query(fromStream);
            const csvData = Readable.from([String(msg.payload || '')]);
            await pipeline(csvData, ingestStream);
            msg.payload = { message: 'COPY FROM complete' };
            node.status({ fill: 'green', shape: 'ring', text: 'COPY import complete' });
          } else {
            const chunks: Buffer[] = [];
            // Defensive: CopyToQueryStream hijacks the pg parser via _attach(),
            // but if CopyData events leak through, this prevents a crash.
            const toStream = copyTo(query);
            (toStream as unknown as Record<string, (...args: unknown[]) => void>).handleCopyData = () => {};
            (toStream as unknown as Record<string, (...args: unknown[]) => void>).handleCopyOutResponse = () => {};
            const copyStream = client.query(toStream);
            await pipeline(copyStream, async function* (source: AsyncIterable<unknown>) {
              for await (const chunk of source) { chunks.push(Buffer.from(chunk as Uint8Array)); }
            });
            msg.payload = Buffer.concat(chunks).toString('utf8');
            node.status({ fill: 'green', shape: 'ring', text: 'COPY export complete' });
          }
          return;
        }

        // Cursor path via DECLARE/FETCH (no retry, D-10)
        if (cursorMode && query.trim().toUpperCase().startsWith('SELECT')) {
          const cursorName = 'gsd_' + Math.random().toString(36).substring(2, 10);
          await client.query('BEGIN');
          await client.query(`DECLARE ${cursorName} CURSOR FOR ${query}`);
          let batchIndex = 0;
          let totalRows = 0;
          let rows;
          while ((rows = await client.query(`FETCH ${cursorBatchSize} FROM ${cursorName}`)).rows.length > 0) {
            totalRows += rows.rows.length;
            node.send({
              payload: rows.rows,
              batch: { index: batchIndex, rows: rows.rows.length, total: totalRows },
              topic: msg.topic,
              _msgid: msg._msgid
            });
            batchIndex++;
          }
          await client.query('COMMIT');
          node.send({
            payload: [],
            complete: true,
            total: totalRows,
            topic: msg.topic,
            _msgid: msg._msgid
          });
          node.status({ fill: 'green', shape: 'ring', text: `Cursor complete. ${totalRows} rows streamed` });
          return;
        }

        // Transaction + single-query paths with retry
        let retryAttempt = 0;
        const effectiveMaxRetries = retryEnabled ? maxRetries : 0;

        retry_loop:
        while (true) {
          try {
            if (transactionMode && Array.isArray(msg.payload)) {
              await client.query('BEGIN');
              let outputResult: any = null;
              for (const entry of msg.payload) {
                const entryQuery = mustache.render(entry.query, { msg });
                const entryParams = useNamedParams && entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params)
                  ? bindNamedParams(entryQuery, entry.params)
                  : (Array.isArray(entry.params) ? entry.params : []);
                const result = await client.query(entryQuery, entryParams);
                if (entry.output && !outputResult) {
                  outputResult = result;
                }
              }
              await client.query('COMMIT');
              msg.payload = outputResult ? outputResult.rows : [];
              node.status({ fill: 'green', shape: 'ring', text: 'Transaction committed' });
            } else {
              const disableAll = !(config.mapNumeric === true || config.mapNumeric === 'true') &&
                                 !(config.mapTimestamptz === true || config.mapTimestamptz === 'true') &&
                                 (config.parseJsonb === false || config.parseJsonb === 'false');
              const disableJsonb = config.parseJsonb === false || config.parseJsonb === 'false';
              const queryTypes = buildQueryTypes({ disableAll, disableJsonb });

              msg.payload = await client.query({
                text: query,
                values: resolvedParams,
                types: queryTypes
              });
              node.status({
                fill: 'green',
                shape: 'ring',
                text: `Query ok. ${msg.payload.rowCount} rows returned`
              });
            }
            break; // success — exit retry loop
          } catch (err: any) {
            if (!retryEnabled || retryAttempt >= effectiveMaxRetries || !isTransientError(err)) {
              throw err; // non-transient or max retries exhausted — propagate to outer catch
            }
            if (client) {
              try { client.release(); } catch { /* best-effort */ }
              client = null;
            }
            const delay = Math.min(5000, retryBaseDelay * Math.pow(2, retryAttempt)) * Math.random();
            retryAttempt++;
            node.log(`Retry ${retryAttempt}/${effectiveMaxRetries} after ${Math.round(delay)}ms: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
            client = await node.config.pgPool.connect();
            if (timeoutMs > 0) {
              try { await client.query(`SET statement_timeout = ${timeoutMs}`); } catch { /* best-effort */ }
            }
            continue;
          }
        }
      } catch (err: any) {
        const structuredError = formatError(err);

        if (transactionMode && Array.isArray(msg.payload)) {
          try { await client.query('ROLLBACK'); } catch (rollbackErr: any) {
            node.warn(`ROLLBACK failed: ${rollbackErr.message}`);
          }
          msg.payload = undefined;
        }

        if (structuredError.code === '57014') {
          structuredError.message = `Query timeout after ${timeoutMs}ms`;
        }

        node.status({
          fill: 'red',
          shape: 'ring',
          text: `Error: ${structuredError.code || '--'} — ${structuredError.message}`
        });

        if (config.throwErrors) {
          node.error(structuredError, msg);
          msg = null;
        } else {
          node.error(structuredError);
          msg.error = structuredError;
        }
      } finally {
        if (client) {
          try {
            if (timeoutMs > 0) {
              try {
                await client.query('SET statement_timeout = 0');
              } catch (resetErr: any) {
                node.warn(`Could not reset statement_timeout: ${resetErr.message}`);
              }
            }
            client.release();
            node.debug('Connection released');
          } catch (releaseError: any) {
            node.error(`Error releasing connection: ${releaseError.message}`);
          }
        }
        node.send(msg);
      }
    };

    asyncQuery().catch((unhandledError: any) => {
      node.error(`Unhandled error: ${unhandledError.message}`);
    });
  });

  node.on('close', () => {
    node.status({});
  });
}
