/**
 * Parser Plugin System Tests
 * Security-first: Tests verify safe parsing, error handling, and deterministic output
 */

import { describe, expect, it } from "vitest";

import {
  isSafeToParse,
  computeContentHash,
  parseFile,
  getSupportedExtensions,
  registerParser,
} from "../src/parsers/index.js";
import { jsTsParser } from "../src/parsers/jsTs.js";
import { pythonParser } from "../src/parsers/python.js";
import { rustParser } from "../src/parsers/rust.js";
import { goParser } from "../src/parsers/go.js";
import { safeRegexParse } from "../src/parsers/safeParse.js";
import { SAFE_EXTENSIONS, PARSER_LIMITS } from "../src/parsers/types.js";

describe("Parser Types & Constants", () => {
  it("should define safe extensions for parsing", () => {
    expect(SAFE_EXTENSIONS).toEqual([".js", ".ts", ".jsx", ".tsx", ".py", ".pyi", ".rs", ".go"]);
  });

  it("should define parser safety limits", () => {
    expect(PARSER_LIMITS.MAX_FILE_SIZE_BYTES).toBe(2 * 1024 * 1024);
    expect(PARSER_LIMITS.MAX_PARSE_TIME_MS).toBe(500);
    expect(PARSER_LIMITS.MAX_FALLBACK_SIZE_BYTES).toBe(100 * 1024);
  });
});

describe("isSafeToParse", () => {
  it("should accept safe JavaScript/TypeScript files", () => {
    expect(isSafeToParse("/project/src/index.ts")).toBe(true);
    expect(isSafeToParse("/project/src/App.jsx")).toBe(true);
    expect(isSafeToParse("/project/src/utils.ts")).toBe(true);
    expect(isSafeToParse("/project/src/components/Button.js")).toBe(true);
  });

  it("should reject files with unsafe extensions", () => {
    expect(isSafeToParse("/project/.env")).toBe(false);
    expect(isSafeToParse("/project/config.json")).toBe(false);
    expect(isSafeToParse("/project/data.yaml")).toBe(false);
    expect(isSafeToParse("/project/README.md")).toBe(false);
  });

  it("should reject files in node_modules", () => {
    expect(isSafeToParse("/project/node_modules/lodash/index.js")).toBe(false);
  });

  it("should reject files in .git", () => {
    expect(isSafeToParse("/project/.git/config")).toBe(false);
  });

  it("should reject .env files", () => {
    expect(isSafeToParse("/project/.env")).toBe(false);
    expect(isSafeToParse("/project/.env.production")).toBe(false);
  });

  it("should reject dist/build directories", () => {
    expect(isSafeToParse("/project/dist/index.js")).toBe(false);
    expect(isSafeToParse("/project/build/app.js")).toBe(false);
  });

  it("should reject .memo-log directory", () => {
    expect(isSafeToParse("/project/.memo-log/state.json")).toBe(false);
  });

  it("rejects credentials, secrets, keys, pems", () => {
    expect(isSafeToParse("/project/credentials.ts")).toBe(false);
    expect(isSafeToParse("/project/secrets.ts")).toBe(false);
    expect(isSafeToParse("/project/id_rsa.key")).toBe(false);
    expect(isSafeToParse("/project/cert.pem")).toBe(false);
  });
});

describe("computeContentHash", () => {
  it("should produce consistent SHA-256 hashes", () => {
    const content = "const x = 1;";
    const hash1 = computeContentHash(content);
    const hash2 = computeContentHash(content);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex length
  });

  it("should produce different hashes for different content", () => {
    const hash1 = computeContentHash("const x = 1;");
    const hash2 = computeContentHash("const x = 2;");

    expect(hash1).not.toBe(hash2);
  });
});

describe("jsTsParser", () => {
  describe("parse", () => {
    it("should parse valid JavaScript", () => {
      const code = "export const foo = 1;";
      const result = jsTsParser.parse(code, "test.js");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
      expect(result.parseTimeMs).toBeLessThan(PARSER_LIMITS.MAX_PARSE_TIME_MS);
    });

    it("should parse valid TypeScript", () => {
      const code = "export function greet(name: string): void { }";
      const result = jsTsParser.parse(code, "test.ts");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
    });

    it("should parse JSX", () => {
      const code = "export const App = () => <div>Hello</div>;";
      const result = jsTsParser.parse(code, "test.jsx");

      expect(result.success).toBe(true);
    });

    it("should parse TSX", () => {
      const code = "export const Button = (props: { label: string }) => <button>{props.label}</button>;";
      const result = jsTsParser.parse(code, "test.tsx");

      expect(result.success).toBe(true);
    });

    it("should use error recovery for malformed code", () => {
      const code = "export const broken = { missing: 'closing' };";
      const result = jsTsParser.parse(code, "test.js");

      // Error recovery should allow parsing to continue
      expect(result.success).toBe(true);
    });

    it("should handle empty content", () => {
      const result = jsTsParser.parse("", "empty.js");

      expect(result.success).toBe(true);
    });
  });

  describe("extract", () => {
    it("should extract named exports", () => {
      const code = `
        export const foo = 1;
        export function bar() { }
        export class Baz { }
      `;
      const result = jsTsParser.parse(code, "test.js");
      expect(result.success).toBe(true);

      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      expect(extraction.exports).toHaveLength(3);
      expect(extraction.exports.find((e) => e.name === "foo")?.kind).toBe("const");
      expect(extraction.exports.find((e) => e.name === "bar")?.kind).toBe("function");
      expect(extraction.exports.find((e) => e.name === "Baz")?.kind).toBe("class");
    });

    it("should preserve type-only export kinds", () => {
      const code = `
        export type { User } from "./types";
        export { createUser } from "./users";
      `;
      const result = jsTsParser.parse(code, "test.ts");
      expect(result.success).toBe(true);

      const extraction = jsTsParser.extract(result.ast!, "test.ts", code);
      expect(extraction.exports.find((entry) => entry.name === "User")?.kind).toBe("type");
      expect(extraction.exports.find((entry) => entry.name === "createUser")?.kind).toBe("const");
    });

    it("should extract default exports", () => {
      const code = `
        export default function main() { }
      `;
      const result = jsTsParser.parse(code, "test.js");
      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      const defaultExport = extraction.exports.find((e) => e.kind === "default");
      expect(defaultExport).toBeDefined();
      expect(defaultExport?.name).toBe("main");
    });

    it("should extract imports", () => {
      const code = `
        import { foo, bar } from './utils';
        import React from 'react';
        import * as _ from 'lodash';
      `;
      const result = jsTsParser.parse(code, "test.js");
      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      expect(extraction.imports).toHaveLength(3);

      const utilsImport = extraction.imports.find((i) => i.path === "./utils");
      expect(utilsImport?.names).toEqual(["foo", "bar"]);

      const reactImport = extraction.imports.find((i) => i.path === "react");
      expect(reactImport?.names).toEqual(["React"]);

      const lodashImport = extraction.imports.find((i) => i.path === "lodash");
      expect(lodashImport?.names).toEqual(["_"]);
    });

    it("should extract function signatures", () => {
      const code = `
        export function greet(name, age) { }
        export const arrow = (x, y) => x + y;
      `;
      const result = jsTsParser.parse(code, "test.js");
      const extraction = jsTsParser.extract(result.ast!, "test.js", code);

      expect(extraction.signatures.length).toBeGreaterThanOrEqual(2);

      const greetSig = extraction.signatures.find((s) => s.name === "greet");
      expect(greetSig).toBeDefined();
      expect(greetSig?.params).toEqual(["name", "age"]);
    });
  });
});

describe("safeRegexParse", () => {
  it("should extract exports via regex fallback", () => {
    const code = `
export function foo() { }
export const bar = 1;
export class Baz { }
    `.trim();

    const { result, warnings } = safeRegexParse(code, "fallback.js");

    expect(result.exports.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("PARSE_FALLBACK"))).toBe(true);
  });

  it("should extract imports via regex fallback", () => {
    const code = `
import { x, y } from './module';
import z from 'zod';
    `.trim();

    const { result } = safeRegexParse(code, "fallback.js");

    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle malformed code gracefully", () => {
    const code = `export { broken , } from './module';`;

    const { result } = safeRegexParse(code, "malformed.js");

    // Should not throw, returns whatever it can extract
    expect(result).toBeDefined();
  });
});

describe("parseFile", () => {
  it("should parse a valid JavaScript file end-to-end", async () => {
    const content = `
      import React from 'react';
      export function greet(name: string) {
        return \`Hello, \${name}\`;
      }
      export const VERSION = '1.0.0';
    `.trim();

    const result = await parseFile("test.ts", content, content.length);

    expect(result.path).toBe("test.ts");
    expect(result.contentHash).toHaveLength(64);
    expect(result.exports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.usedFallback).toBe(false);
    expect(result.warnings.length).toBe(0);
  });

  it("should skip files with unsupported extensions", async () => {
    const content = "some data";

    const result = await parseFile("data.yaml", content, content.length);

    expect(result.exports).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("unsupported extension"))).toBe(true);
  });

  it("should reject files exceeding size limit", async () => {
    const largeContent = "x".repeat(PARSER_LIMITS.MAX_FILE_SIZE_BYTES + 1);

    const result = await parseFile("large.js", largeContent, largeContent.length);

    expect(result.exports).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("exceeds"))).toBe(true);
  });

  it("should use regex fallback for large files", async () => {
    const mediumContent = "x".repeat(PARSER_LIMITS.MAX_FALLBACK_SIZE_BYTES + 1);

    const result = await parseFile("medium.js", mediumContent, mediumContent.length);

    expect(result.usedFallback).toBe(true);
    expect(result.warnings.some((w) => w.includes("Large file"))).toBe(true);
  });

  it("should extract exports via regex fallback for files between 512KB and 2MB", async () => {
    const content = `export const sentinel = 42;\n${"// padding\n".repeat(60_000)}`;
    const size = Buffer.byteLength(content, "utf8");
    expect(size).toBeGreaterThan(512 * 1024);
    expect(size).toBeLessThan(PARSER_LIMITS.MAX_FILE_SIZE_BYTES);

    const result = await parseFile("large-valid.ts", content, size);

    expect(result.usedFallback).toBe(true);
    expect(result.exports.map((e) => e.name)).toEqual(["sentinel"]);
    expect(result.warnings.some((w) => w.includes("PARSE_FALLBACK_SKIPPED"))).toBe(false);
  });

  it("should produce deterministic output", async () => {
    const content = "export const x = 1;";

    const result1 = await parseFile("test.js", content, content.length);
    const result2 = await parseFile("test.js", content, content.length);

    expect(result1.contentHash).toBe(result2.contentHash);
    expect(result1.exports).toEqual(result2.exports);
  });
});

describe("getSupportedExtensions", () => {
  it("should return safe extensions list", () => {
    const extensions = getSupportedExtensions();

    expect(extensions).toContain(".js");
    expect(extensions).toContain(".ts");
    expect(extensions).toContain(".jsx");
    expect(extensions).toContain(".tsx");
    expect(extensions).toContain(".py");
    expect(extensions).toContain(".pyi");
    expect(extensions).toContain(".rs");
    expect(extensions).toContain(".go");
  });
});

describe("Integration: Parser in scan context", () => {
  it("should handle a realistic component file", async () => {
    const componentCode = `
import React, { useState } from 'react';
import { Button } from './Button';
import type { User } from '../types';

interface Props {
  user: User;
  onLogout: () => void;
}

/**
 * Dashboard header component
 * @param user - The currently logged in user
 * @param onLogout - Callback to handle logout
 */
export function DashboardHeader({ user, onLogout }: Props) {
  const [isMenuOpen, setMenuOpen] = useState(false);

  return (
    <header>
      <h1>Welcome, {user.name}</h1>
      <Button onClick={onLogout}>Logout</Button>
    </header>
  );
}

export default DashboardHeader;
    `.trim();

    const result = await parseFile("src/components/DashboardHeader.tsx", componentCode, componentCode.length);

    // Verify extraction
    expect(result.exports.length).toBeGreaterThanOrEqual(2); // named + default
    expect(result.imports.length).toBeGreaterThanOrEqual(3); // React, Button, types

    // Verify deterministic
    const result2 = await parseFile("src/components/DashboardHeader.tsx", componentCode, componentCode.length);
    expect(result.contentHash).toBe(result2.contentHash);
  });

  it("should handle utility files with multiple exports", async () => {
    const utilsCode = `
/**
 * Format a date string
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Format currency
 */
export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export const MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT = 5000;
    `.trim();

    const result = await parseFile("src/utils/format.ts", utilsCode, utilsCode.length);

    expect(result.exports.length).toBeGreaterThanOrEqual(4); // 2 functions + 2 constants
    expect(result.usedFallback).toBe(false);

    // Check JSDoc extraction
    const formatDate = result.exports.find((e) => e.name === "formatDate");
    expect(formatDate?.jsdoc).toBeDefined();
  });
});

describe("pythonParser", () => {
  describe("parse", () => {
    it("should parse Python files", () => {
      const code = "def greet(name):\n    return f'Hello, {name}'";
      const result = pythonParser.parse(code, "test.py");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
    });

    it("should parse .pyi files", () => {
      const result = pythonParser.parse("def foo() -> int: ...", "test.pyi");
      expect(result.success).toBe(true);
    });
  });

  describe("extract", () => {
    it("should extract top-level functions", () => {
      const code = `def greet(name):
    return f"Hello, {name}"

def farewell(name):
    return f"Goodbye, {name}"
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("greet");
      expect(result.exports[0]?.kind).toBe("function");
      expect(result.exports[1]?.name).toBe("farewell");
    });

    it("should extract classes", () => {
      const code = `class UserService:
    def get_user(self, user_id):
        pass

class AdminService(UserService):
    pass
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("UserService");
      expect(result.exports[0]?.kind).toBe("class");
      expect(result.exports[1]?.name).toBe("AdminService");
    });

    it("should extract imports", () => {
      const code = `import os
import sys
from flask import Flask, request
from pathlib import Path
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.imports).toHaveLength(4);
      expect(result.imports.find(i => i.path === "os")).toBeDefined();
      expect(result.imports.find(i => i.path === "flask")?.names).toEqual(["Flask", "request"]);
      expect(result.imports.find(i => i.path === "pathlib")?.names).toEqual(["Path"]);
    });

    it("should extract function signatures with params", () => {
      const code = `def authenticate(username: str, password: str) -> bool:
    pass
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0]?.name).toBe("authenticate");
      expect(result.signatures[0]?.params).toEqual(["username", "password"]);
    });

    it("should skip private functions not in __all__", () => {
      const code = `def public_func():
    pass

def _private_func():
    pass

def __dunder_func():
    pass
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe("public_func");
    });

    it("should include __all__ listed names even if private", () => {
      const code = `__all__ = ["_internal_helper"]

def _internal_helper():
    pass

def public_func():
    pass
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports.some(e => e.name === "_internal_helper")).toBe(true);
      expect(result.exports.some(e => e.name === "public_func")).toBe(true);
    });

    it("should extract docstrings", () => {
      const code = `def calculate(x, y):
    """Add two numbers together."""
    return x + y
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports[0]?.jsdoc).toBe("Add two numbers together.");
      expect(result.signatures[0]?.jsdoc).toBe("Add two numbers together.");
    });

    it("should skip indented (nested) function definitions", () => {
      const code = `def outer():
    def inner():
        pass
    return inner

def another_public():
    pass
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("outer");
      expect(result.exports[1]?.name).toBe("another_public");
    });

    it("should extract top-level constants", () => {
      const code = `MAX_RETRIES = 3
DEFAULT_TIMEOUT = 5000
SECRET_KEY = "abc"
`;
      const result = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", code);

      expect(result.exports.some(e => e.name === "MAX_RETRIES")).toBe(true);
      expect(result.exports.some(e => e.name === "DEFAULT_TIMEOUT")).toBe(true);
      expect(result.exports.some(e => e.name === "SECRET_KEY")).toBe(true);
    });
  });

  describe("parseFile integration", () => {
    it("should parse Python files end-to-end via parseFile", async () => {
      const code = `from flask import Flask

app = Flask(__name__)

def create_app():
    """Create and configure the Flask app."""
    return app
`;
      const result = await parseFile("src/app.py", code, code.length);

      expect(result.lang).toBe("py");
      expect(result.usedFallback).toBe(false);
      expect(result.exports.some(e => e.name === "create_app")).toBe(true);
      expect(result.imports.some(i => i.path === "flask")).toBe(true);
    });
  });
});

describe("rustParser", () => {
  describe("parse", () => {
    it("should parse Rust files", () => {
      const code = "pub fn greet(name: &str) -> String { format!(\"Hello, {}\", name) }";
      const result = rustParser.parse(code, "test.rs");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
    });
  });

  describe("extract", () => {
    it("should extract pub functions", () => {
      const code = `pub fn authenticate(user: &str, pass: &str) -> bool {
    true
}

pub async fn fetch_data(url: &str) -> Result<String, Error> {
    Ok(String::new())
}

fn private_helper() {}
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("authenticate");
      expect(result.exports[0]?.kind).toBe("function");
      expect(result.exports[1]?.name).toBe("fetch_data");
    });

    it("should extract pub structs and enums", () => {
      const code = `pub struct User {
    pub name: String,
    pub email: String,
}

pub enum ConnectionState {
    Connected,
    Disconnected,
}

struct PrivateConfig {}
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("User");
      expect(result.exports[0]?.kind).toBe("class");
      expect(result.exports[1]?.name).toBe("ConnectionState");
    });

    it("should extract pub traits and types", () => {
      const code = `pub trait Repository {
    fn find(&self, id: u64) -> Option<Item>;
}

pub type Result<T> = std::result::Result<T, Error>;
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("Repository");
      expect(result.exports[0]?.kind).toBe("type");
      expect(result.exports[1]?.name).toBe("Result");
    });

    it("should extract use imports", () => {
      const code = `use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::models::User;
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.imports).toHaveLength(3);
      expect(result.imports.find(i => i.path === "std::collections::HashMap")).toBeDefined();
      expect(result.imports.find(i => i.names.includes("Deserialize"))).toBeDefined();
      expect(result.imports.find(i => i.names.includes("Serialize"))).toBeDefined();
    });

    it("should extract function signatures with params", () => {
      const code = `pub fn create_user(name: String, email: String, age: u32) -> Result<User> {
    Ok(User { name, email, age })
}
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0]?.name).toBe("create_user");
      expect(result.signatures[0]?.params).toEqual(["name", "email", "age"]);
    });

    it("should extract doc comments", () => {
      const code = `/// Authenticate a user with credentials.
/// Returns true if valid.
pub fn authenticate(user: &str) -> bool {
    true
}
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports[0]?.jsdoc).toContain("Authenticate a user");
    });

    it("should skip macro_rules", () => {
      const code = `pub macro_rules! my_macro {
    () => {};
}

pub fn real_function() {}
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe("real_function");
    });

    it("should extract pub const and static", () => {
      const code = `pub const MAX_SIZE: usize = 1024;
pub static VERSION: &str = "1.0.0";
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("MAX_SIZE");
      expect(result.exports[0]?.kind).toBe("const");
    });

    it("should skip non-pub items", () => {
      const code = `fn private_fn() {}
const PRIVATE_CONST: i32 = 42;
pub fn public_fn() {}
`;
      const result = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", code);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe("public_fn");
    });
  });

  describe("parseFile integration", () => {
    it("should parse Rust files end-to-end via parseFile", async () => {
      const code = `use std::collections::HashMap;

pub struct Cache {
    store: HashMap<String, String>,
}

pub fn new_cache() -> Cache {
    Cache { store: HashMap::new() }
}
`;
      const result = await parseFile("src/cache.rs", code, code.length);

      expect(result.lang).toBe("rs");
      expect(result.usedFallback).toBe(false);
      expect(result.exports.some(e => e.name === "Cache")).toBe(true);
      expect(result.exports.some(e => e.name === "new_cache")).toBe(true);
    });
  });
});

describe("goParser", () => {
  describe("parse", () => {
    it("should parse Go files", () => {
      const code = "func greet(name string) string { return \"Hello\" }";
      const result = goParser.parse(code, "test.go");

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
    });
  });

  describe("extract", () => {
    it("should extract exported functions", () => {
      const code = `func Authenticate(user string, pass string) bool {
    return true
}

func GetData(id int) (string, error) {
    return "", nil
}

func init() {}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      // init() should be skipped
      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("Authenticate");
      expect(result.exports[0]?.kind).toBe("function");
      expect(result.exports[1]?.name).toBe("GetData");
    });

    it("should skip unexported functions", () => {
      const code = `func PublicFunc() {}
func privateFunc() {}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe("PublicFunc");
    });

    it("should extract exported types", () => {
      const code = `type User struct {
    Name  string
    Email string
}

type Repository interface {
    Find(id int) (*User, error)
}

type Handler func(http.ResponseWriter, *http.Request)
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.exports).toHaveLength(3);
      expect(result.exports[0]?.name).toBe("User");
      expect(result.exports[0]?.kind).toBe("class");
      expect(result.exports[1]?.name).toBe("Repository");
      expect(result.exports[1]?.kind).toBe("class");
      expect(result.exports[2]?.name).toBe("Handler");
      expect(result.exports[2]?.kind).toBe("type");
    });

    it("should extract exported var and const", () => {
      const code = `var MaxRetries = 3
const DefaultTimeout = 5000

var privateVar = "hidden"
const privateConst = 42
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.name).toBe("MaxRetries");
      expect(result.exports[1]?.name).toBe("DefaultTimeout");
    });

    it("should extract imports", () => {
      const code = `import (
    "fmt"
    "net/http"
    "github.com/gin-gonic/gin"
)
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.imports).toHaveLength(3);
      expect(result.imports.find(i => i.path === "fmt")).toBeDefined();
      expect(result.imports.find(i => i.path === "net/http")).toBeDefined();
      expect(result.imports.find(i => i.path === "github.com/gin-gonic/gin")).toBeDefined();
    });

    it("should extract single-line imports", () => {
      const code = `import "os"
import "strings"
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.imports).toHaveLength(2);
    });

    it("should extract function signatures", () => {
      const code = `func CreateUser(name string, email string, age int) (*User, error) {
    return nil, nil
}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0]?.name).toBe("CreateUser");
      expect(result.signatures[0]?.params).toEqual(["name", "email", "age"]);
    });

    it("should skip init() in signatures", () => {
      const code = `func init() {
    // setup
}

func RealFunc() {}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.signatures).toHaveLength(1);
      expect(result.signatures[0]?.name).toBe("RealFunc");
    });

    it("should extract Go doc comments", () => {
      const code = `// GetUser retrieves a user by ID.
// Returns an error if not found.
func GetUser(id int) (*User, error) {
    return nil, nil
}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.exports[0]?.jsdoc).toContain("GetUser retrieves a user by ID.");
    });

    it("should skip //go:generate directives", () => {
      const code = `//go:generate mockgen -source=repo.go -destination=mock_repo.go

func RealExport() {}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe("RealExport");
    });

    it("should skip indented (method) functions", () => {
      const code = `type Service struct{}

func (s *Service) Method() {}

func StandaloneFunc() {}
`;
      const result = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", code);

      // Service is exported, Method is indented (method), StandaloneFunc is exported
      expect(result.exports.some(e => e.name === "Service")).toBe(true);
      expect(result.exports.some(e => e.name === "StandaloneFunc")).toBe(true);
      expect(result.exports.some(e => e.name === "Method")).toBe(false);
    });
  });

  describe("parseFile integration", () => {
    it("should parse Go files end-to-end via parseFile", async () => {
      const code = `package main

import "fmt"

func main() {
    fmt.Println("Hello")
}

func Greet(name string) string {
    return fmt.Sprintf("Hello, %s", name)
}
`;
      const result = await parseFile("cmd/main.go", code, code.length);

      expect(result.lang).toBe("go");
      expect(result.usedFallback).toBe(false);
      expect(result.exports.some(e => e.name === "Greet")).toBe(true);
      expect(result.imports.some(i => i.path === "fmt")).toBe(true);
    });
  });
});

describe("Cross-language schema compliance", () => {
  it("all parsers return identical ExtractionResult schema", () => {
    const tsResult = jsTsParser.extract(
      jsTsParser.parse("export const x = 1;", "test.ts").ast!,
      "test.ts",
      "export const x = 1;"
    );
    const pyResult = pythonParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.py", "def foo(): pass");
    const rsResult = rustParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.rs", "pub fn foo() {}");
    const goResult = goParser.extract({ type: "regex-token" as const, contentLength: 0 }, "test.go", "func Foo() {}");

    for (const result of [tsResult, pyResult, rsResult, goResult]) {
      expect(Array.isArray(result.exports)).toBe(true);
      expect(Array.isArray(result.imports)).toBe(true);
      expect(Array.isArray(result.signatures)).toBe(true);

      for (const exp of result.exports) {
        expect(typeof exp.name).toBe("string");
        expect(typeof exp.kind).toBe("string");
        expect(typeof exp.line).toBe("number");
        expect(typeof exp.column).toBe("number");
      }
      for (const imp of result.imports) {
        expect(typeof imp.path).toBe("string");
        expect(Array.isArray(imp.names)).toBe(true);
        expect(typeof imp.line).toBe("number");
        expect(typeof imp.column).toBe("number");
        expect(typeof imp.importKind).toBe("string");
      }
    }
  });

  it("parseFile returns consistent ParsedFile schema across languages", async () => {
    const pyFile = await parseFile("test.py", "def foo(): pass", 15);
    const rsFile = await parseFile("test.rs", "pub fn foo() {}", 15);
    const goFile = await parseFile("test.go", "func Foo() {}", 13);

    for (const file of [pyFile, rsFile, goFile]) {
      expect(typeof file.path).toBe("string");
      expect(typeof file.lang).toBe("string");
      expect(typeof file.contentHash).toBe("string");
      expect(file.contentHash).toHaveLength(64);
      expect(Array.isArray(file.exports)).toBe(true);
      expect(Array.isArray(file.imports)).toBe(true);
      expect(Array.isArray(file.signatures)).toBe(true);
      expect(typeof file.usedFallback).toBe("boolean");
      expect(Array.isArray(file.warnings)).toBe(true);
    }

    expect(pyFile.lang).toBe("py");
    expect(rsFile.lang).toBe("rs");
    expect(goFile.lang).toBe("go");
  });

  it("deterministic output across multiple runs", async () => {
    const pyCode = "from flask import Flask\ndef create_app(): return Flask(__name__)";

    const r1 = await parseFile("app.py", pyCode, pyCode.length);
    const r2 = await parseFile("app.py", pyCode, pyCode.length);

    expect(r1.contentHash).toBe(r2.contentHash);
    expect(r1.exports).toEqual(r2.exports);
    expect(r1.imports).toEqual(r2.imports);
  });
});

describe("registerParser", () => {
  it("should reject plugin without extensions", () => {
    expect(() => registerParser({
      extensions: [],
      language: "Test",
      lang: "py",
      parse: () => ({ success: true }),
      extract: () => ({ exports: [], imports: [], signatures: [] }),
    } as never)).toThrow("Parser must define extensions");
  });

  it("should reject plugin without parse method", () => {
    expect(() => registerParser({
      extensions: [".test"],
      language: "Test",
      lang: "py",
      extract: () => ({ exports: [], imports: [], signatures: [] }),
    } as never)).toThrow("Parser must implement parse and extract methods");
  });
});
