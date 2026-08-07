import fs from "node:fs/promises";

import { runMonitor } from "./monitor-core.mjs";
import { runTradifiMonitor } from "./tradifi-monitor.mjs";
import { runOvernightTradifiMonitor } from "./overnight-tradifi-monitor.mjs";

const stateUrl = new URL("./monitor-state.json", import.meta.url);
let state;

try {
  state = JSON.parse(await fs.readFile(stateUrl, "utf8"));
} catch {
  state = { alerts: {} };
}

if (!process.env.PUSHPLUS_TOKEN) {
  throw new Error("PUSHPLUS_TOKEN is not configured");
}

const env = {
  PUSHPLUS_TOKEN: process.env.PUSHPLUS_TOKEN,
  MONITOR_STATE: {
    async get(_key, type) {
      return type === "json" ? state : JSON.stringify(state);
    },
    async put(_key, value) {
      state = JSON.parse(value);
      await fs.writeFile(stateUrl, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    },
  },
};

const result = await runMonitor(env);
console.log(JSON.stringify(result));
const tradifiResult = await runTradifiMonitor(env);
console.log(JSON.stringify({ tradifi: tradifiResult }));
const overnightTradifiResult = await runOvernightTradifiMonitor(env);
console.log(JSON.stringify({ overnightTradifi: overnightTradifiResult }));
