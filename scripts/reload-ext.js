#!/usr/bin/env node
// Dev helper: tell the loaded extension to reload itself so it picks up code changes.
// Works alongside running sessions (it opens its own session socket).
import { Bridge } from '../mcp/bridge.js';
import { sessionSocket } from '../host/paths.js';
const b = new Bridge(sessionSocket());
await b.listen();
if (!(await b.waitForConnection(8000))) { console.error('extension not connected'); b.close(); process.exit(1); }
console.log((await b.request('reload_extension')).text);
b.close();
