#!/usr/bin/env node
// FitAI MCP Server (Model Context Protocol)
// Provides full access to FitAI: Workout Planning, Exercise History,
// Weight/Rep Tracking, Nutrition/Calories, Bio/Body Stats, and Coach Memory.

const readline = require('readline');
const { FitAIClient, logDebug } = require('./client');
const { registerTools } = require('./tools');

const SERVER_NAME = 'fitai-coach-mcp';
const SERVER_VERSION = '1.0.0';

class McpServer {
  constructor() {
    this.client = new FitAIClient();
    this.tools = registerTools(this.client);
    this.toolsMap = new Map(this.tools.map((t) => [t.name, t]));
  }

  start() {
    logDebug(`Spouštím ${SERVER_NAME} v${SERVER_VERSION}...`);
    logDebug(`Registrováno ${this.tools.length} nástrojů pro kouče.`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const message = JSON.parse(trimmed);
        await this.handleMessage(message);
      } catch (err) {
        logDebug('Chyba při parsování JSON-RPC:', err.message);
        this.sendError(null, -32700, 'Parse error: ' + err.message);
      }
    });

    rl.on('close', () => {
      logDebug('MCP Server ukončen (stdin closed).');
      process.exit(0);
    });

    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }

  send(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  sendResult(id, result) {
    this.send({
      jsonrpc: '2.0',
      id,
      result
    });
  }

  sendError(id, code, message, data) {
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {})
      }
    });
  }

  async handleMessage(msg) {
    // Notifications (no id)
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/initialized') {
        logDebug('Klient odeslal notifications/initialized.');
      }
      return;
    }

    const { id, method, params } = msg;

    switch (method) {
      case 'initialize': {
        logDebug('Zpracovávám initialize request...');
        this.sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          }
        });
        break;
      }

      case 'ping': {
        this.sendResult(id, {});
        break;
      }

      case 'tools/list': {
        logDebug(`tools/list vyžádáno, vracím ${this.tools.length} nástrojů.`);
        const exposedTools = this.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }));
        this.sendResult(id, { tools: exposedTools });
        break;
      }

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        logDebug(`Volání nástroje "${toolName}" s argumenty:`, JSON.stringify(toolArgs));

        const tool = this.toolsMap.get(toolName);
        if (!tool) {
          logDebug(`Nástroj "${toolName}" nenalezen.`);
          this.sendResult(id, {
            content: [
              {
                type: 'text',
                text: `Chyba: Nástroj "${toolName}" neexistuje v tomto MCP serveru.`
              }
            ],
            isError: true
          });
          return;
        }

        try {
          const res = await tool.handler(toolArgs);
          const textRes = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
          this.sendResult(id, {
            content: [
              {
                type: 'text',
                text: textRes
              }
            ],
            isError: false
          });
        } catch (err) {
          logDebug(`Chyba při běhu nástroje "${toolName}":`, err.message);
          this.sendResult(id, {
            content: [
              {
                type: 'text',
                text: `Chyba při provádění nástroje: ${err.message}`
              }
            ],
            isError: true
          });
        }
        break;
      }

      default: {
        logDebug(`Neznámá metoda: ${method}`);
        this.sendError(id, -32601, `Method not found: ${method}`);
        break;
      }
    }
  }
}

const server = new McpServer();
server.start();
