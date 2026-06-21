import * as pg from 'pg';
import { parse } from 'pg-connection-string';
import { getREDNodes } from '../lib/red';
import { getField } from '../lib/getField';
import { registerTypeParsers } from '../lib/typeMapping';
import type { PostgresDBNodeConfig } from '../lib/types';

export function PostgresDBNode(this: any, n: PostgresDBNodeConfig) {
  const RED = getREDNodes();
  const node = this;
  RED.createNode(node, n);
  node.name = n.name;
  node.host = n.host;
  node.hostFieldType = n.hostFieldType;
  node.port = n.port;
  node.portFieldType = n.portFieldType;
  node.database = n.database;
  node.databaseFieldType = n.databaseFieldType;
  node.ssl = n.ssl;
  node.sslFieldType = n.sslFieldType;
  node.sslmode = n.sslmode;
  node.sslmodeFieldType = n.sslmodeFieldType;
  node.databaseUrl = n.databaseUrl;
  node.databaseUrlFieldType = n.databaseUrlFieldType;
  node.useDatabaseUrl = n.useDatabaseUrl;
  node.statementTimeout = n.statementTimeout;
  node.statementTimeoutFieldType = n.statementTimeoutFieldType;
  node.max = n.max;
  node.maxFieldType = n.maxFieldType;
  node.min = n.min;
  node.minFieldType = n.minFieldType;
  node.idle = n.idle;
  node.idleFieldType = n.idleFieldType;
  node.user = n.user;
  node.userFieldType = n.userFieldType;
  node.password = n.password;
  node.passwordFieldType = n.passwordFieldType;

  node.connectionTimeout = n.connectionTimeout;
  node.connectionTimeoutFieldType = n.connectionTimeoutFieldType;
  node.throwErrors = n.throwErrors;
  node.throwErrorsFieldType = n.throwErrorsFieldType;
  node.debug(`config throwErrors: ${node.throwErrors}`);

  // Schema cache — populated by PostgresIntrospectNode, consumed by editor via HTTP admin
  node._schemaCache = null;
  node._schemaTimestamp = 0;

  // --- SSL config builder ---
  let sslmode = (getField(node, n.sslmodeFieldType as any, n.sslmode) as string) || 'disable';
  const legacySsl = getField(node, n.sslFieldType as any, n.ssl) as boolean;

  // Legacy migration: ssl: true without sslmode → sslmode: require
  if (legacySsl === true && (sslmode === 'disable' || !sslmode)) {
    sslmode = 'require';
  }

  let sslConfig: any = false;
  if (sslmode === 'require') {
    sslConfig = { rejectUnauthorized: false };
  } else if (sslmode === 'verify-ca') {
    sslConfig = {
      rejectUnauthorized: false,
      ca: node.credentials.sslCa,
      key: node.credentials.sslKey,
      cert: node.credentials.sslCert
    };
  } else if (sslmode === 'verify-full') {
    sslConfig = {
      rejectUnauthorized: true,
      ca: node.credentials.sslCa,
      key: node.credentials.sslKey,
      cert: node.credentials.sslCert
    };
  }
  // sslmode === 'disable' → sslConfig stays false

  // --- Connection config: DATABASE_URL or individual fields ---
  let connectionConfig: any;
  const useDbUrl = getField(node, n.useDatabaseUrl as any, n.useDatabaseUrl) === true ||
    String(getField(node, n.useDatabaseUrl as any, n.useDatabaseUrl)).toLowerCase() === 'true';
  const dbUrl = getField(node, n.databaseUrlFieldType as any, n.databaseUrl) as string;

  if (useDbUrl && dbUrl) {
    const parsed = parse(dbUrl);
    connectionConfig = {
      user: parsed.user || getField(node, n.userFieldType as any, node.credentials.user) as string | undefined,
      password: parsed.password || getField(node, n.passwordFieldType as any, node.credentials.password) as string | undefined,
      host: parsed.host || getField(node, n.hostFieldType as any, n.host) as string,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      database: parsed.database || getField(node, n.databaseFieldType as any, n.database) as string
    };
  } else {
    connectionConfig = {
      user: getField(node, n.userFieldType as any, node.credentials.user) as string | undefined,
      password: getField(node, n.passwordFieldType as any, node.credentials.password) as string | undefined,
      host: getField(node, n.hostFieldType as any, n.host) as string,
      port: getField(node, n.portFieldType as any, n.port) as number,
      database: getField(node, n.databaseFieldType as any, n.database) as string
    };
  }

  // --- Pool creation ---
  this.pgPool = new pg.Pool({
    ...connectionConfig,
    ssl: sslConfig,
    max: getField(node, n.maxFieldType as any, n.max) as number,
    idleTimeoutMillis: getField(node, n.idleFieldType as any, n.idle) as number,
    connectionTimeoutMillis: getField(node, n.connectionTimeoutFieldType as any, n.connectionTimeout) as number,
    statement_timeout: getField(node, n.statementTimeoutFieldType as any, n.statementTimeout) as number || undefined
  });

  // --- Type parser registration (no-op stub until plan 02-03) ---
  registerTypeParsers();

  // --- Pool health polling ---
  const pgPool = this.pgPool;

  // Register pool error handler for immediate status update
  pgPool.on('error', (err: Error) => {
    node.status({
      fill: 'red',
      shape: 'ring',
      text: `DB: ${err.message}`
    });
  });

  // Start health poll at 30-second intervals
  this._healthInterval = setInterval(() => {
    const total: number = pgPool.totalCount;
    const idle: number = pgPool.idleCount;
    const waiting: number = pgPool.waitingCount;
    const active: number = total - idle;
    const maxVal: number = parseInt(String(getField(node, n.maxFieldType as any, n.max) || 10), 10);
    const nearLimit = active >= maxVal * 0.8;
    node.status({
      fill: nearLimit ? 'yellow' : 'green',
      shape: 'ring',
      text: `Active: ${active}  Idle: ${idle}  Waiting: ${waiting}  Total: ${total}${nearLimit ? ' ⚠' : ''}`
    });
  }, 30000);

  // --- Close handler ---
  node.on('close', () => {
    if (node._healthInterval) {
      clearInterval(node._healthInterval);
    }
    node.status({});
  });
}
