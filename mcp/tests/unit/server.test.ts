/**
 * Unit tests for SudocodeMCPServer initialization checks and scope handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SudocodeMCPServer } from "../../src/server.js";
import * as fs from "fs";
import * as path from "path";
import { getToolsForScopes } from "../../src/tool-registry.js";
import { expandScopes, getUsableScopes } from "../../src/scopes.js";

// Mock fs and path modules
vi.mock("fs");
vi.mock("path");

// Mock the client
vi.mock("../../src/client.js", () => ({
  SudocodeClient: vi.fn().mockImplementation((config) => ({
    workingDir: config?.workingDir || "/test/working/dir",
    exec: vi.fn(),
  })),
}));

// Mock MCP SDK
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(),
    connect: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

describe("SudocodeMCPServer", () => {
  let consoleErrorSpy: any;
  let mockExistsSync: any;
  let mockJoin: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExistsSync = vi.mocked(fs.existsSync);
    mockJoin = vi.mocked(path.join);

    // Default mock for path.join - just concatenate with /
    mockJoin.mockImplementation((...args: string[]) => args.join("/"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
  });

  describe("checkForInit", () => {
    it("reports initialized without side effects when store-path says so", async () => {
      const server = new SudocodeMCPServer();
      const mockExec = vi.fn().mockResolvedValue({ initialized: true });
      (server as any).client.exec = mockExec;

      const result = await (server as any).checkForInit();

      // Only the read-only store-path probe runs; no init.
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec).toHaveBeenCalledWith(["store-path"]);
      expect(result).toEqual({ initialized: true, sudocodeExists: true });
    });

    it("auto-inits when the store is not yet set up, then re-verifies", async () => {
      const server = new SudocodeMCPServer();
      const mockExec = vi
        .fn()
        .mockResolvedValueOnce({ initialized: false }) // store-path (before)
        .mockResolvedValueOnce({ success: true }) // init
        .mockResolvedValueOnce({ initialized: true }); // store-path (after)
      (server as any).client.exec = mockExec;

      const result = await (server as any).checkForInit();

      expect(mockExec).toHaveBeenNthCalledWith(1, ["store-path"]);
      expect(mockExec).toHaveBeenNthCalledWith(2, ["init"]);
      expect(mockExec).toHaveBeenNthCalledWith(3, ["store-path"]);
      expect(result).toEqual({
        initialized: true,
        sudocodeExists: true,
        message: "Initialized sudocode",
      });
    });

    it("reports failure when init does not produce a usable store", async () => {
      const server = new SudocodeMCPServer();
      const mockExec = vi
        .fn()
        .mockResolvedValueOnce({ initialized: false }) // store-path (before)
        .mockResolvedValueOnce({ success: true }) // init
        .mockResolvedValueOnce({ initialized: false }); // store-path (after)
      (server as any).client.exec = mockExec;

      const result = await (server as any).checkForInit();

      expect(result).toEqual({
        initialized: false,
        sudocodeExists: false,
        message: "init did not produce a usable store",
      });
    });

    it("handles a CLI failure gracefully", async () => {
      const server = new SudocodeMCPServer();
      const mockExec = vi.fn().mockRejectedValue(new Error("boom"));
      (server as any).client.exec = mockExec;

      const result = await (server as any).checkForInit();

      expect(result).toEqual({
        initialized: false,
        sudocodeExists: false,
        message: "boom",
      });
    });
  });

  describe("checkInitialization", () => {
    // store-path already reports an initialized store.
    const execInitialized = () => vi.fn().mockResolvedValue({ initialized: true });
    // store-path false → init → store-path true (successful auto-init).
    const execAutoInit = () =>
      vi
        .fn()
        .mockResolvedValueOnce({ initialized: false })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ initialized: true });
    // store-path false → init → store-path still false (init failed to produce).
    const execInitFails = () =>
      vi
        .fn()
        .mockResolvedValueOnce({ initialized: false })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ initialized: false });

    it("should set isInitialized to true when initialized", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = execInitialized();
      await (server as any).checkInitialization();

      expect((server as any).isInitialized).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "✓ sudocode initialized successfully"
      );
    });

    it("should set isInitialized to false when init cannot produce a store", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = execInitFails();
      await (server as any).checkInitialization();

      expect((server as any).isInitialized).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "⚠️  WARNING: sudocode is not initialized"
      );
    });

    it("should display init command when no store can be produced", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = execInitFails();
      await (server as any).checkInitialization();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("No .sudocode directory found.")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("$ sudocode init")
      );
    });

    it("should auto-init when the project has no store yet", async () => {
      const server = new SudocodeMCPServer();
      const mockExec = execAutoInit();
      (server as any).client.exec = mockExec;

      await (server as any).checkInitialization();

      expect(mockExec).toHaveBeenCalledWith(["init"]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "sudocode not initialized here — running init..."
      );
      expect((server as any).isInitialized).toBe(true);
    });

    it("should surface the init success message", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = execAutoInit();
      await (server as any).checkInitialization();

      expect((server as any).isInitialized).toBe(true);
      expect(consoleErrorSpy).toHaveBeenCalledWith("  Initialized sudocode");
    });
  });

  describe("tool handler with isInitialized check", () => {
    const execInitFails = () =>
      vi
        .fn()
        .mockResolvedValueOnce({ initialized: false })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ initialized: false });

    it("should return error when isInitialized is false and project still not initialized", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = execInitFails();
      await (server as any).checkInitialization();

      expect((server as any).isInitialized).toBe(false);

      const expectedErrorPattern = /sudocode is not initialized/;
      const workingDir = (server as any).client.workingDir || process.cwd();
      const errorMessage = `⚠️  sudocode is not initialized in this directory.\n\nWorking directory: ${workingDir}\n\nPlease run 'sudocode init' in your project root first.`;

      expect(errorMessage).toMatch(expectedErrorPattern);
      expect(errorMessage).toContain(workingDir);
    });

    it("should allow tools to proceed when isInitialized is true", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = vi.fn().mockResolvedValue({ initialized: true });
      await (server as any).checkInitialization();

      expect((server as any).isInitialized).toBe(true);
    });

    it("should re-check and update isInitialized when project is initialized after server start", async () => {
      const server = new SudocodeMCPServer();
      // First: init cannot produce a store → not initialized.
      (server as any).client.exec = execInitFails();
      await (server as any).checkInitialization();
      expect((server as any).isInitialized).toBe(false);

      // Later: store now resolves as initialized.
      (server as any).client.exec = vi.fn().mockResolvedValue({ initialized: true });
      const result = await (server as any).checkForInit();
      expect(result.initialized).toBe(true);
      if (result.initialized) {
        (server as any).isInitialized = true;
      }
      expect((server as any).isInitialized).toBe(true);
    });
  });

  describe("run method", () => {
    it("should call checkInitialization before starting server", async () => {
      const server = new SudocodeMCPServer();
      (server as any).client.exec = vi.fn().mockResolvedValue({ initialized: true });
      const checkInitSpy = vi.spyOn(server as any, "checkInitialization");

      // Mock the connect method to prevent actual connection
      (server as any).server.connect = vi.fn().mockResolvedValue(undefined);

      await server.run();

      expect(checkInitSpy).toHaveBeenCalled();
      // The banner includes the version (e.g. "sudocode MCP server 0.3.1 running on stdio").
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("running on stdio")
      );
    });
  });
});

describe("Scope-based tool filtering", () => {
  describe("default scope", () => {
    it("provides only CLI-wrapped tools without server URL", () => {
      const enabledScopes = expandScopes(["default"]);
      const usableScopes = getUsableScopes(enabledScopes, undefined);
      const tools = getToolsForScopes(usableScopes);

      expect(tools).toHaveLength(14);
      expect(tools.map((t) => t.name)).toContain("ready");
      expect(tools.map((t) => t.name)).toContain("list_issues");
      expect(tools.map((t) => t.name)).not.toContain("list_executions");
    });
  });

  describe("extended scopes without server URL", () => {
    it("filters out extended scopes when server URL is not provided", () => {
      const enabledScopes = expandScopes(["default", "executions"]);
      const usableScopes = getUsableScopes(enabledScopes, undefined);
      const tools = getToolsForScopes(usableScopes);

      // Only default tools should be available
      expect(tools).toHaveLength(14);
      expect(tools.every((t) => t.scope === "default")).toBe(true);
    });
  });

  describe("extended scopes with server URL", () => {
    it("includes execution tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["default", "executions"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("ready"); // default
      expect(names).toContain("list_executions"); // executions:read
      expect(names).toContain("start_execution"); // executions:write
    });

    it("includes inspection tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["inspection"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      // Note: execution_trajectory is disabled (not yet implemented)
      expect(names).toContain("execution_changes");
      expect(names).toContain("execution_chain");
    });

    it("includes workflow tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["workflows"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("list_workflows");
      expect(names).toContain("create_workflow");
      expect(names).toContain("start_workflow");
    });

    it("includes overview tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["overview"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      expect(tools.map((t) => t.name)).toContain("project_status");
    });
  });

  describe("project-assistant meta-scope", () => {
    it("expands to all assistant-related scopes", () => {
      const enabledScopes = expandScopes(["project-assistant"]);

      expect(enabledScopes.has("overview")).toBe(true);
      expect(enabledScopes.has("executions")).toBe(true);
      expect(enabledScopes.has("executions:read")).toBe(true);
      expect(enabledScopes.has("executions:write")).toBe(true);
      expect(enabledScopes.has("inspection")).toBe(true);
      expect(enabledScopes.has("workflows")).toBe(true);
      expect(enabledScopes.has("workflows:read")).toBe(true);
      expect(enabledScopes.has("workflows:write")).toBe(true);
      // Default is NOT included in project-assistant
      expect(enabledScopes.has("default")).toBe(false);
    });

    it("provides all extended tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["project-assistant"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);

      // Overview tools
      expect(names).toContain("project_status");

      // Execution tools
      expect(names).toContain("list_executions");
      expect(names).toContain("show_execution");
      expect(names).toContain("start_execution");
      expect(names).toContain("cancel_execution");

      // Inspection tools (note: execution_trajectory is disabled)
      expect(names).toContain("execution_changes");
      expect(names).toContain("execution_chain");

      // Workflow tools
      expect(names).toContain("list_workflows");
      expect(names).toContain("create_workflow");

      // Should NOT include default tools
      expect(names).not.toContain("ready");
      expect(names).not.toContain("list_issues");
    });
  });

  describe("all meta-scope", () => {
    it("expands to all scopes including default", () => {
      const enabledScopes = expandScopes(["all"]);

      expect(enabledScopes.has("default")).toBe(true);
      expect(enabledScopes.has("overview")).toBe(true);
      expect(enabledScopes.has("executions")).toBe(true);
      expect(enabledScopes.has("inspection")).toBe(true);
      expect(enabledScopes.has("workflows")).toBe(true);
    });

    it("provides all tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["all"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);

      // Default tools
      expect(names).toContain("ready");
      expect(names).toContain("list_issues");

      // Extended tools (note: execution_trajectory is disabled)
      expect(names).toContain("project_status");
      expect(names).toContain("list_executions");
      expect(names).toContain("list_workflows");
    });

    it("only provides default tools when server URL is not provided", () => {
      const enabledScopes = expandScopes(["all"]);
      const usableScopes = getUsableScopes(enabledScopes, undefined);
      const tools = getToolsForScopes(usableScopes);

      // Only default tools should be available
      expect(tools).toHaveLength(14);
      expect(tools.every((t) => t.scope === "default")).toBe(true);
    });
  });

  describe("granular scopes", () => {
    it("allows executions:read without executions:write", () => {
      const enabledScopes = expandScopes(["executions:read"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("list_executions");
      expect(names).toContain("show_execution");
      expect(names).not.toContain("start_execution");
      expect(names).not.toContain("cancel_execution");
    });

    it("allows workflows:read without workflows:write", () => {
      const enabledScopes = expandScopes(["workflows:read"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("list_workflows");
      expect(names).toContain("show_workflow");
      expect(names).toContain("workflow_status");
      expect(names).not.toContain("create_workflow");
      expect(names).not.toContain("start_workflow");
    });
  });
});
