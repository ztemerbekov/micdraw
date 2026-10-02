import assert from "node:assert/strict";
import { test } from "node:test";

import { isAllowedRequest } from "../src/request-guard.js";

test("requests from the app's own page are allowed", () => {
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" }), true);
  assert.equal(isAllowedRequest({ host: "localhost:3210", origin: "http://localhost:3210" }), true);
  assert.equal(isAllowedRequest({ host: "[::1]:3210", origin: "http://[::1]:3210" }), true);
  assert.equal(isAllowedRequest({ host: "LOCALHOST:3210", origin: "http://localhost:3210" }), true);
});

test("requests without an Origin header are allowed on a loopback host", () => {
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210" }), true);
  assert.equal(isAllowedRequest({ host: "localhost:3210" }), true);
});

test("requests from another origin are rejected", () => {
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210", origin: "https://example.com" }), false);
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210", origin: "http://127.0.0.1:3000" }), false);
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210", origin: "http://localhost:3210" }), false);
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210", origin: "null" }), false);
  assert.equal(isAllowedRequest({ host: "127.0.0.1:3210", origin: "" }), false);
});

test("requests that name a non-loopback host are rejected", () => {
  assert.equal(isAllowedRequest({ host: "example.com:3210" }), false);
  assert.equal(isAllowedRequest({ host: "example.com:3210", origin: "http://example.com:3210" }), false);
  assert.equal(isAllowedRequest({ host: "192.168.1.20:3210" }), false);
  assert.equal(isAllowedRequest({ host: undefined }), false);
  assert.equal(isAllowedRequest({ host: "" }), false);
});
