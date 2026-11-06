import assert from "node:assert/strict";
import test from "node:test";

import { InitParams, LogParams, RunParams } from "../../extensions/pi-autoresearch/index.ts";
import { initExperimentShape, logExperimentShape, runExperimentShape } from "../../src/mcp/schemas.ts";

const keys = (typeboxObject) => Object.keys(typeboxObject.properties).sort();

test("MCP zod run_experiment params have the same property names as the Pi TypeBox schema", () => {
  assert.deepEqual(Object.keys(runExperimentShape).sort(), keys(RunParams));
});

test("MCP zod init_experiment params have the same property names as the Pi TypeBox schema", () => {
  assert.deepEqual(Object.keys(initExperimentShape).sort(), keys(InitParams));
});

test("MCP zod log_experiment params have the same property names as the Pi TypeBox schema", () => {
  assert.deepEqual(Object.keys(logExperimentShape).sort(), keys(LogParams));
});
