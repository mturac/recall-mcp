import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from './db/client.js';
import { gc } from './utils/gc.js';
import { embedder } from './embedding/embedder.js';

export const app = express();
app.use(cors());

// Auth Middleware — require RECALL_AUTH_KEY explicitly, never fall back to a
// shared default secret. A missing key in a non-test environment refuses every
// request rather than silently auto-authenticating ("test_token_123" was a
// production-default-secret hazard).
const NODE_ENV = process.env.NODE_ENV ?? '';
const envToken = process.env.RECALL_AUTH_KEY ?? (NODE_ENV === 'test' ? 'test_token_123' : '');
if (!envToken) {
  // Fail loud on boot rather than mid-request.
  console.error('[recall-mcp] RECALL_AUTH_KEY is not set; the server will refuse every request.');
}

// Constant-time string compare to defeat timing-based token leaks.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  // Query-parameter tokens are still accepted for backwards compatibility,
  // but logged with a deprecation warning — they end up in every proxy /
  // browser-history log line, which leaks the secret.
  const queryToken = (req.query.auth as string | undefined) ?? '';

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice('Bearer '.length).trim();
  } else if (queryToken) {
    token = queryToken;
    console.warn('[recall-mcp] token supplied via ?auth= — prefer Authorization: Bearer to keep the secret out of access logs');
  }

  if (!envToken || !token || !constantTimeEquals(token, envToken)) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  next();
});

// JSON serialiser that survives ``BigInt`` fields returned by ``better-sqlite3``
// for INTEGER columns whose magnitude exceeds 2^53. The default JSON.stringify
// throws ``TypeError: Do not know how to serialize a BigInt`` and crashes the
// MCP server mid-response (critical review finding).
function safeStringify(value: unknown, space: number | undefined = 2): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') {
      // Only coerce to number when the value fits safely; otherwise keep as
      // string so precision is not silently lost.
      return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(v)
        : v.toString();
    }
    return v;
  }, space);
}


// Schemas
const RecallRememberSchema = z.object({
  namespace: z.string().default('global'),
  session_id: z.string().optional(),
  content: z.string(),
  summary: z.string().optional(),
  category: z.enum(['fact', 'preference', 'project', 'episodic', 'instruction', 'general']),
  weight: z.enum(['STRONG', 'MEDIUM', 'WEAK']).default('MEDIUM'),
  source: z.string().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.any()).default({}),
  expires_at: z.string().optional(), // ISO datetime string
});

const RecallSearchSchema = z.object({
  query: z.string(),
  namespace: z.string().default('global'),
  limit: z.number().default(10),
  mode: z.enum(['fts', 'semantic', 'hybrid']).default('hybrid'),
});

const RecallGetSchema = z.object({
  id: z.string(),
});

const RecallForgetSchema = z.object({
  id: z.string(),
  mode: z.enum(['delete', 'weaken']),
});

const RecallDigestSchema = z.object({
  namespace: z.string().default('global'),
});

export function createMcpServer() {
  const mcpServer = new Server({
    name: 'recall-mcp-v2',
    version: '2.0.0',
  }, {
    capabilities: {
      tools: {}
    }
  });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'recall_remember',
        description: 'Insert a new memory',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            session_id: { type: 'string' },
            content: { type: 'string' },
            summary: { type: 'string' },
            category: { type: 'string', enum: ['fact', 'preference', 'project', 'episodic', 'instruction', 'general'] },
            weight: { type: 'string', enum: ['STRONG', 'MEDIUM', 'WEAK'] },
            source: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            metadata: { type: 'object' },
            expires_at: { type: 'string' },
          },
          required: ['content', 'category']
        }
      },
      {
        name: 'recall_search',
        description: 'Search memories by query',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            namespace: { type: 'string' },
            limit: { type: 'number' },
            mode: { type: 'string', enum: ['fts', 'semantic', 'hybrid'] },
          },
          required: ['query']
        }
      },
      {
        name: 'recall_get',
        description: 'Get memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          },
          required: ['id']
        }
      },
      {
        name: 'recall_forget',
        description: 'Forget or weaken a memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            mode: { type: 'string', enum: ['delete', 'weaken'] }
          },
          required: ['id', 'mode']
        }
      },
      {
        name: 'recall_digest',
        description: 'Get a markdown digest of strong/medium memories in a namespace',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' }
          }
        }
      }
    ]
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case 'recall_remember': {
        const args = RecallRememberSchema.parse(request.params.arguments);
        const id = nanoid();
        
        const embedding = await embedder.embed(args.content);
        const float32Array = new Float32Array(embedding);
        const vectorBuffer = Buffer.from(float32Array.buffer);

        const insertMemory = db.transaction(() => {
          const stmt = db.prepare(`
            INSERT INTO memories (id, namespace, session_id, content, summary, category, weight, source, tags, metadata, expires_at)
            VALUES (@id, @namespace, @session_id, @content, @summary, @category, @weight, @source, @tags, @metadata, @expires_at)
          `);
          
          const result = stmt.run({
            id,
            namespace: args.namespace,
            session_id: args.session_id || null,
            content: args.content,
            summary: args.summary || null,
            category: args.category,
            weight: args.weight,
            source: args.source || null,
            tags: JSON.stringify(args.tags),
            metadata: JSON.stringify(args.metadata),
            expires_at: args.expires_at || null
          });

          // SQLite rowid is returned as number | bigint. Handled dynamically to bypass sqlite-vec Node binding issues
          const rowid = typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid;
          db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(rowid, vectorBuffer);
          return id;
        });

        const newId = insertMemory();

        return { content: [{ type: 'text', text: safeStringify({ success: true, id: newId }) }] };
      }

      case 'recall_search': {
        const args = RecallSearchSchema.parse(request.params.arguments);
        // Use a parameterised filter instead of interpolating the namespace
        // into the SQL string. The old `'${ns.replace(/'/g, "''")}'` pattern
        // was fragile (review critical SQL injection finding).
        const hasNsFilter = args.namespace !== 'global';
        const namespaceFilter = hasNsFilter ? 'AND namespace = ?' : '';
        const nsParams: string[] = hasNsFilter ? [args.namespace] : [];
        const limit = args.limit;
        let results: Array<{ id: string, score: number, data: any }> = [];

        if (args.mode === 'fts') {
          const ftsQuery = `"${args.query.replace(/"/g, '""')}"`;
          const rows = db.prepare(`SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, limit) as any;

          const rowIds = rows.map((r: any) => Number(r.rowid));
          if (rowIds.length > 0) {
            const placeholders = rowIds.map(() => '?').join(',');
            const mems = db.prepare(`SELECT rowid, * FROM memories WHERE rowid IN (${placeholders}) ${namespaceFilter}`).all(...rowIds, ...nsParams) as any[];
            
            const memMap = new Map();
            mems.forEach(m => memMap.set(Number(m.rowid), m));

            for (const r of rows) {
              const numRId = Number(r.rowid);
              if (memMap.has(numRId) && results.length < limit) {
                results.push({ id: memMap.get(numRId).id, score: r.rank, data: memMap.get(numRId) });
              }
            }
          }
        } 
        else if (args.mode === 'semantic') {
          const embedding = await embedder.embed(args.query);
          const buffer = Buffer.from(new Float32Array(embedding).buffer);
          
          const rows = db.prepare(`
            SELECT rowid, distance 
            FROM memories_vec 
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
          `).all(buffer, limit * 2) as any;
          
          const rowIds = rows.map((r: any) => Number(r.rowid));
          if (rowIds.length > 0) {
            const placeholders = rowIds.map(() => '?').join(',');
            const mems = db.prepare(`SELECT rowid, * FROM memories WHERE rowid IN (${placeholders}) ${namespaceFilter}`).all(...rowIds, ...nsParams) as any[];

            const memMap = new Map();
            mems.forEach(m => memMap.set(Number(m.rowid), m));

            for (const r of rows) {
              const numRId = Number(r.rowid);
              if (memMap.has(numRId) && results.length < limit) {
                results.push({ id: memMap.get(numRId).id, score: r.distance, data: memMap.get(numRId) });
              }
            }
          }
        }
        else if (args.mode === 'hybrid') {
          const ftsQuery = `"${args.query.replace(/"/g, '""')}"`;
          const ftsRows = db.prepare(`SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?`).all(ftsQuery) as any;
          
          const embedding = await embedder.embed(args.query);
          const buffer = Buffer.from(new Float32Array(embedding).buffer);
          const vecRows = db.prepare(`SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`).all(buffer, limit * 2) as any;

          const k_rrf = 60;
          const rrf = new Map<number, number>();
          
          ftsRows.forEach((row: any, idx: number) => {
            rrf.set(Number(row.rowid), 1 / (k_rrf + idx + 1));
          });
          
          vecRows.forEach((row: any, idx: number) => {
            const numRid = Number(row.rowid);
            const current = rrf.get(numRid) || 0;
            rrf.set(numRid, current + (1 / (k_rrf + idx + 1)));
          });

          const sortedRowIds = Array.from(rrf.entries())
            .sort((a, b) => b[1] - a[1])
            .map(e => e[0])
            .slice(0, limit * 2);
            
          if (sortedRowIds.length > 0) {
            const placeholders = sortedRowIds.map(() => '?').join(',');
            const mems = db.prepare(`SELECT rowid, * FROM memories WHERE rowid IN (${placeholders}) ${namespaceFilter}`).all(...sortedRowIds, ...nsParams) as any[];
            
            const memMap = new Map();
            mems.forEach(m => memMap.set(Number(m.rowid), m));
            
            for (const rid of sortedRowIds) {
              if (memMap.has(rid) && results.length < limit) {
                results.push({ id: memMap.get(rid).id, score: rrf.get(rid) || 0, data: memMap.get(rid) });
              }
            }
          }
        }

        if (results.length > 0) {
          // Parameterise the IN-clause. The previous build wrapped every id
          // in quotes and concatenated them straight into the SQL — a real
          // SQL-injection vector even though nanoid is alphanumeric, because
          // future schema changes or direct DB edits could let arbitrary
          // text reach this query.
          const ids = results.map(r => r.id);
          const placeholders = ids.map(() => '?').join(',');
          db.prepare(
            `UPDATE memories SET access_count = access_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
          ).run(...ids);
        }

        return { content: [{ type: 'text', text: safeStringify(results) }] };
      }

      case 'recall_get': {
        const args = RecallGetSchema.parse(request.params.arguments);
        const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(args.id);
        return { content: [{ type: 'text', text: mem ? safeStringify(mem) : safeStringify({ error: 'Memory not found' }) }] };
      }

      case 'recall_forget': {
        const args = RecallForgetSchema.parse(request.params.arguments);
        if (args.mode === 'delete') {
          db.prepare('DELETE FROM memories WHERE id = ?').run(args.id);
        } else {
          const mem = db.prepare('SELECT weight FROM memories WHERE id = ?').get(args.id) as { weight: string } | undefined;
          if (mem) {
            let nextWeight = mem.weight;
            if (mem.weight === 'STRONG') nextWeight = 'MEDIUM';
            else if (mem.weight === 'MEDIUM') nextWeight = 'WEAK';
            db.prepare('UPDATE memories SET weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextWeight, args.id);
          }
        }
        return { content: [{ type: 'text', text: safeStringify({ success: true, id: args.id, mode: args.mode }) }] };
      }

      case 'recall_digest': {
        const args = RecallDigestSchema.parse(request.params.arguments);
        const mems = db.prepare(`
          SELECT * FROM memories 
          WHERE namespace = ? AND weight IN ('STRONG', 'MEDIUM') 
          ORDER BY category, weight DESC, updated_at DESC
        `).all(args.namespace) as any[];

        let markdown = `# Memory Digest: ${args.namespace}\n\n`;
        const byCategory = mems.reduce((acc, mem) => {
          if (!acc[mem.category]) acc[mem.category] = [];
          acc[mem.category].push(mem);
          return acc;
        }, {} as Record<string, any[]>);

        if (Object.keys(byCategory).length === 0) {
          markdown += "No core memories found.";
        } else {
          for (const [cat, items] of Object.entries(byCategory)) {
            markdown += `## ${cat.toUpperCase()}\n`;
            for (const item of items as any[]) {
              markdown += `- [${item.weight}] ${item.summary || item.content.substring(0, 100) + '...'}\n`;
            }
            markdown += '\n';
          }
        }

        return { content: [{ type: 'text', text: markdown }] };
      }

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true
    };
  }
});

return mcpServer;
} // Close createMcpServer()

const transports = new Map<string, SSEServerTransport>();

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  // Re-define mcpServer inside route scope so it has a reference?
  // No, just instantiate and connect
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);

  // Use the sessionId assigned by SSEServerTransport
  transports.set(transport.sessionId, transport);

  res.on('close', () => {
    transports.delete(transport.sessionId);
    transport.close();
  });

  console.log(`[SSE] Client connected: ${transport.sessionId}`);
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err: any) {
    console.error('[SSE POST Error]', err);
    res.status(500).json({ error: 'Failed handling message' });
  }
});


export async function runServer() {
  await embedder.init();
  gc.start();

  const HTTP_PORT = process.env.PORT || 3000;
  return app.listen(HTTP_PORT, () => {
    console.log(`[Express] Model Context Protocol SSE Server running on http://localhost:${HTTP_PORT}`);
    console.log(`[Express] Endpoints: GET /sse  --- POST /message`);
    console.log(`[Express] Protected via Bearer token -> ${process.env.RECALL_AUTH_KEY ? 'Active' : 'Missing!!!'}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  runServer().catch(err => {
    console.error('[Server Error]', err);
    process.exit(1);
  });
}
