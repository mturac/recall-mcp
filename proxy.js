#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * RECALL-MCP v2 Proxy Bridge
 * This script runs on the host and converts Stdio communication from the Agent
 * into SSE communication for the Dockerized RECALL-MCP server.
 */

const RECALL_URL = process.env.RECALL_URL || 'http://localhost:4000/sse';
const RECALL_TOKEN = process.env.RECALL_TOKEN || 'secure_token_12345';

async function runProxy() {
    // 1. Connect to the SSE Server as a Client
    const url = new URL(RECALL_URL);
    url.searchParams.set('auth', RECALL_TOKEN);
    
    const transport = new SSEClientTransport(url, {
        // GET /sse (EventSource) often has trouble with headers in some polyfills, 
        // so we use the query param above.
        // POST /message (fetch) works fine with headers.
        requestInit: {
            headers: {
                'Authorization': `Bearer ${RECALL_TOKEN}`
            }
        }
    });


    const client = new Client({
        name: "recall-proxy",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    try {
        await client.connect(transport);
        console.error(`[Proxy] Connected to RECALL-MCP at ${RECALL_URL}`);

        // 2. Create a local Server that communicates via Stdio
        // We will proxy all requests from the Agent to the Client we just created
        const server = new Server({
            name: "recall-bridge",
            version: "1.0.0"
        }, {
            capabilities: {
                tools: {} // We will proxy these
            }
        });

        const { 
            ListToolsRequestSchema, ListToolsResultSchema, 
            CallToolRequestSchema, CallToolResultSchema 
        } = await import('@modelcontextprotocol/sdk/types.js');

        // Proxy Tool Listing
        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            console.error("[Proxy] Forwarding tools/list");
            // forward the request to the client
            const result = await client.request({
                method: "tools/list",
                params: request.params
            }, ListToolsResultSchema);
            return result;
        });

        // Proxy Tool Execution
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            console.error(`[Proxy] Forwarding tools/call (${request.params.name})`);
            const result = await client.request({
                method: "tools/call",
                params: request.params
            }, CallToolResultSchema);
            return result;
        });

        // Use Stdio transport for the Agent
        const stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);
        
        console.error("[Proxy] Bridge established and ready.");
    } catch (error) {
        console.error(`[Proxy Fatal] Failed to connect: ${error.message}`);
        process.exit(1);
    }
}

runProxy().catch(err => {
    console.error(err);
    process.exit(1);
});
