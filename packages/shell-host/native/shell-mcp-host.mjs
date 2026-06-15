#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arch,
  homedir,
  hostname,
  platform,
  release as osRelease,
  tmpdir,
  type as osType,
  version as osVersion,
} from 'node:os';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

// Resolve package root from this script's location (native/ -> package root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Ensure child processes can find node and project binaries via PATH.
// Chrome-launched native hosts inherit a minimal PATH that often excludes
// Homebrew/nvm/fnm directories, breaking #!/usr/bin/env node shebangs.
const nodeBinDir = dirname(process.execPath);
const localBinDirs = [
  resolve(PROJECT_ROOT, 'node_modules', '.bin'),
  resolve(PROJECT_ROOT, '..', '..', 'node_modules', '.bin'),
].filter(existsSync);
const PATH_SEPARATOR = platform() === 'win32' ? ';' : ':';
const currentPath = getEnvironmentPath(process.env) || (platform() === 'win32' ? '' : '/usr/bin:/bin');
const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
const userBinDirs = platform() === 'win32'
  ? [resolve(localAppData, 'OfficeCLI')]
  : [
      resolve(homedir(), '.local', 'bin'),
      resolve(homedir(), '.pyenv', 'shims'),
      resolve(homedir(), 'miniconda3', 'bin'),
      resolve(homedir(), 'anaconda3', 'bin'),
      resolve(homedir(), 'miniforge3', 'bin'),
      resolve(homedir(), 'mambaforge', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ];
const managedPathDirs = new Set([nodeBinDir, ...localBinDirs, ...userBinDirs]);
const existingPathDirs = splitPath(currentPath).filter(d => !managedPathDirs.has(d));
const hostPath = dedupePathDirs([
  nodeBinDir,
  ...userBinDirs,
  ...readWindowsUserMachinePathDirs(),
  ...existingPathDirs,
  ...localBinDirs,
]).join(PATH_SEPARATOR);
setEnvironmentPath(process.env, hostPath);

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 128_000;
const DEFAULT_PYTHON_TIMEOUT_MS = 10_000;
const MAX_PYTHON_TIMEOUT_MS = 60_000;
const MAX_PYTHON_CODE_BYTES = 60_000;
const MAX_PYTHON_OUTPUT_BYTES = 64_000;
const PYTHON_PACKAGE_CHECKS = ['numpy', 'pandas', 'sympy'];
const DEFAULT_SHELL = platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
const WINDOWS_POWERSHELL_UTF8_PREAMBLE = [
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
  'try { chcp.com 65001 > $null } catch {}',
].join('; ');

const TOOL_DEFINITIONS = [
  {
    name: 'shell_exec',
    title: 'Execute Shell Command',
    description: 'Execute a command in the shell reported by shell_status. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to user home.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Additional environment variables to set.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Timeout in milliseconds. Default 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { operation: 'write', risk: 'high' },
  },
  {
    name: 'shell_status',
    title: 'Shell Host Status',
    description: 'Report host health, platform, shell, current working directory, and Node.js version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { operation: 'read', risk: 'low' },
  },
  {
    name: 'python_status',
    title: 'Python Interpreter Status',
    description: 'Report whether a local Python interpreter is available and which quick-validation packages can be imported.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { operation: 'read', risk: 'low' },
  },
  {
    name: 'python_exec',
    title: 'Execute Python Code',
    description: 'Run short Python code for calculation, reasoning checks, and small data transformations. Do not install packages, access sensitive local files, or use network access.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Short Python code to execute. Keep it focused on computation or validation.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_PYTHON_TIMEOUT_MS, description: 'Timeout in milliseconds. Default 10000, max 60000.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    annotations: { operation: 'execute', risk: 'high' },
  },
  {
    name: 'shell_read_image',
    title: 'Read Local Image',
    description: 'Read a local image file and return base64-encoded data with metadata so the model can analyze the image contents. Use when the user asks you to look at, describe, or analyze an image on their computer.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { operation: 'read', risk: 'high' },
  },
  {
    name: 'shell_analyze_image',
    title: 'Analyze Image Content',
    description: 'Use Python/Pillow to perform real image analysis: dimensions, format, color stats, dominant colors, brightness, and OCR text extraction if available. Returns a comprehensive text description of what the image actually contains. Use this AFTER shell_read_image when you need to understand the content of an image.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image file.' },
        extract_text: { type: 'boolean', description: 'Whether to attempt OCR text extraction. Default true.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { operation: 'read', risk: 'high' },
  },
  {
    name: 'shell_upload_file',
    title: 'Upload Local File',
    description: 'Upload a local file to the current conversation as a native attachment. Supports PDF, DOC/DOCX, XLSX/XLS, PPT/PPTX, images, plain text, and code files. After a successful upload, read the attached file directly on the next turn instead of parsing it with shell or Python libraries.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { operation: 'read', risk: 'high' },
  },
];

// --- Native messaging framing (4-byte LE length prefix) ---

let buffer = Buffer.alloc(0);
let messageResolve = null;
const messageQueue = [];

function onStdinData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
}

function drainBuffer() {
  while (true) {
    if (buffer.length < 4) return;
    const len = buffer.readUInt32LE(0);
    if (len === 0 || len > 10 * 1024 * 1024) {
      process.stderr.write(`[shell-mcp-host] Invalid message length: ${len}\n`);
      process.exit(1);
    }
    if (buffer.length < 4 + len) return;
    const json = buffer.subarray(4, 4 + len).toString('utf8');
    buffer = buffer.subarray(4 + len);
    try {
      const msg = JSON.parse(json);
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
        r(msg);
      } else {
        messageQueue.push(msg);
      }
    } catch (err) {
      process.stderr.write(`[shell-mcp-host] JSON parse error: ${err.message}\n`);
    }
  }
}

let stdinEnded = false;
const EOF = Symbol('EOF');

function readMessage() {
  if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
  if (stdinEnded) return Promise.resolve(EOF);
  return new Promise((resolve) => { messageResolve = resolve; });
}

process.stdin.on('data', onStdinData);
process.stdin.on('end', () => {
  stdinEnded = true;
  if (messageResolve) {
    const r = messageResolve;
    messageResolve = null;
    r(EOF);
  }
});
process.stdin.on('error', () => {
  stdinEnded = true;
  if (messageResolve) {
    const r = messageResolve;
    messageResolve = null;
    r(EOF);
  }
});

function writeNativeMessage(message) {
  return new Promise((resolve) => {
    const json = JSON.stringify(message);
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(header);
    process.stdout.write(body, resolve);
  });
}

// --- JSON-RPC helpers ---

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

// --- Request handlers ---

function handleInitialize(id) {
  return jsonRpcResult(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'deepseek-pp-shell', version: '1.0.0' },
    instructions: 'General-purpose shell execution host. Use shell_exec for local commands and python_exec only for short computation or validation snippets.',
  });
}

function handleListTools(id) {
  return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
}

async function handleCallTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === 'shell_status') {
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: `Shell host ready on ${platform()} ${arch()}` }],
      structuredContent: {
        ok: true,
        data: {
          platform: platform(),
          arch: arch(),
          osType: osType(),
          osRelease: osRelease(),
          osVersion: osVersion(),
          windowsVersion: getWindowsVersionLabel(),
          shell: DEFAULT_SHELL,
          cwd: homedir(),
          nodeVersion: process.version,
          hostname: hostname(),
          path: getEnvironmentPath(process.env),
          pathEntries: splitPath(getEnvironmentPath(process.env)),
        },
      },
    });
  }

  if (name === 'shell_exec') {
    const command = args.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: 'command is required and must be a non-empty string.' }],
      });
    }

    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : homedir();
    const env = createChildEnv(args.env);
    const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms >= 1000
      ? Math.min(args.timeout_ms, 600_000)
      : DEFAULT_TIMEOUT_MS;

    try {
      const result = await execCommand(command, { cwd, env, timeoutMs });
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: formatExecSummary(result) }],
        structuredContent: {
          // exitCode != 0 is common for grep (no matches, exit 1) or diff.
          // Treat as OK when the command produced usable output with no stderr.
          ok: result.exitCode === 0 ||
            (result.stdout && !result.stderr &&
             (result.exitCode === 1 || result.exitCode === 2)),
          data: result,
        },
        isError: result.timedOut || (result.exitCode !== 0 && !result.stdout),
      });
    } catch (err) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: err.message }],
      });
    }
  }

  if (name === 'python_status') {
    return jsonRpcResult(id, await createPythonStatusResult());
  }

  if (name === 'python_exec') {
    return jsonRpcResult(id, await executePythonTool(args));
  }

  if (name === 'shell_read_image') {
    return jsonRpcResult(id, await readImageFile(args));
  }

  if (name === 'shell_analyze_image') {
    return jsonRpcResult(id, await analyzeImageContent(args));
  }

  if (name === 'shell_upload_file') {
    return jsonRpcResult(id, await readGenericFile(args));
  }

  return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
}

// --- Shell execution ---

function execCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { shellBin, shellArgs } = createShellInvocation(command);

    const child = spawn(shellBin, shellArgs, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        stdout.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      }
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        stderr.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      }
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn command: ${err.message}`));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        shell: shellBin,
        exitCode: timedOut ? -1 : (exitCode ?? -1),
        signal: signal || (timedOut ? 'SIGTERM' : null),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated: stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES,
        timedOut,
      });
    });
  });
}

async function createPythonStatusResult() {
  const status = await detectPythonStatus();
  const text = status.available
    ? `Python ${status.version} ready at ${status.executable}`
    : 'No local Python interpreter found. Tried environment variables, common paths, and python/python3/py --version.';

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      ok: true,
      data: status,
    },
  };
}

async function executePythonTool(args) {
  const code = args?.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'code is required and must be a non-empty string.' }],
    };
  }

  const codeBytes = Buffer.byteLength(code, 'utf8');
  if (codeBytes > MAX_PYTHON_CODE_BYTES) {
    return {
      isError: true,
      content: [{ type: 'text', text: `code exceeds ${MAX_PYTHON_CODE_BYTES} bytes.` }],
    };
  }

  const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms >= 1000
    ? Math.min(Math.floor(args.timeout_ms), MAX_PYTHON_TIMEOUT_MS)
    : DEFAULT_PYTHON_TIMEOUT_MS;
  const status = await detectPythonStatus();

  if (!status.available || !status.command) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'No local Python interpreter found. Tried environment variables, common paths, and python/python3/py --version.' }],
      structuredContent: {
        ok: false,
        data: status,
      },
    };
  }

  const cwd = mkdtempSync(join(tmpdir(), 'deepseek-pp-python-'));
  try {
    const result = await execPythonProcess(status.command, status.commandArgs ?? [], {
      code,
      cwd,
      timeoutMs,
    });
    return {
      content: [{ type: 'text', text: formatPythonExecSummary(result) }],
      structuredContent: {
        ok: result.exitCode === 0 || (result.stdout && !result.stderr),
        data: {
          ...result,
          pythonPath: status.executable,
          pythonVersion: status.version,
          cwd: '(temporary scratch directory)',
          limits: getPythonLimits(),
        },
      },
      isError: result.timedOut || (result.exitCode !== 0 && !result.stdout),
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err.message }],
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function detectPythonStatus() {
  const candidates = getPythonCandidates();
  const candidateLabels = candidates.map(formatPythonCandidate);

  for (const candidate of candidates) {
    let versionText = null;
    try {
      const versionProbe = await execPythonVersionProbe(candidate);
      versionText = parsePythonVersionOutput(versionProbe);
      if (versionProbe.exitCode !== 0 || !versionText) continue;
    } catch {
      // Try the next environment value, path, or command name.
      continue;
    }

    try {
      const probe = await execPythonProbe(candidate);
      if (probe.exitCode !== 0 || !probe.stdout.trim()) continue;
      const data = JSON.parse(probe.stdout.trim());
      return {
        available: true,
        command: candidate.command,
        commandArgs: getPythonCommandArgs(candidate),
        executable: typeof data.executable === 'string' ? data.executable : candidate.command,
        version: typeof data.version === 'string' ? data.version : versionText,
        versionCheck: versionText,
        packages: normalizePythonPackages(data.packages),
        candidates: candidateLabels,
        isolation: 'python -I',
        policy: getPythonPolicy(),
        limits: getPythonLimits(),
      };
    } catch {
      // --version worked, but the JSON probe failed; try the next common executable name.
    }
  }

  return {
    available: false,
    command: null,
    commandArgs: [],
    executable: null,
    version: null,
    versionCheck: null,
    packages: Object.fromEntries(PYTHON_PACKAGE_CHECKS.map((name) => [name, false])),
    candidates: candidateLabels,
    isolation: 'python -I',
    policy: getPythonPolicy(),
    limits: getPythonLimits(),
  };
}

function getPythonCandidates() {
  const envCandidates = getPythonEnvCandidates();
  const pathCandidates = getPythonPathCandidates();
  const fallbackCandidates = platform() === 'win32'
    ? [
        { command: 'py', args: [], launcherArgs: ['-3'], source: 'command:py -3 --version' },
        { command: 'py.exe', args: [], launcherArgs: ['-3'], source: 'command:py.exe -3 --version' },
        { command: 'python', args: [], source: 'command:python --version' },
        { command: 'python.exe', args: [], source: 'command:python.exe --version' },
        { command: 'python3', args: [], source: 'command:python3 --version' },
        { command: 'python3.exe', args: [], source: 'command:python3.exe --version' },
      ]
    : [
        { command: 'python3', args: [], source: 'command:python3 --version' },
        { command: 'python', args: [], source: 'command:python --version' },
        { command: 'py', args: [], source: 'command:py --version' },
      ];
  return dedupePythonCandidates([...envCandidates, ...pathCandidates, ...fallbackCandidates]);
}

function getPythonEnvCandidates() {
  const names = [
    'DEEPSEEK_PP_PYTHON',
    'PYTHON_EXECUTABLE',
    'PYTHON',
    'PYTHON3',
  ];
  const candidates = [];
  for (const name of names) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    candidates.push({ command: value.trim(), args: [], source: 'env:' + name });
  }
  return candidates;
}

function getPythonPathCandidates() {
  return platform() === 'win32' ? getWindowsPythonPathCandidates() : getPosixPythonPathCandidates();
}

function getPosixPythonPathCandidates() {
  const candidates = [];
  const directPaths = [
    resolve(homedir(), '.pyenv', 'shims', 'python3'),
    resolve(homedir(), '.pyenv', 'shims', 'python'),
    resolve(homedir(), 'miniconda3', 'bin', 'python'),
    resolve(homedir(), 'anaconda3', 'bin', 'python'),
    resolve(homedir(), 'miniforge3', 'bin', 'python'),
    resolve(homedir(), 'mambaforge', 'bin', 'python'),
    '/opt/homebrew/bin/python3',
    '/opt/homebrew/bin/python',
    '/usr/local/bin/python3',
    '/usr/local/bin/python',
    '/usr/bin/python3',
    '/usr/bin/python',
    '/bin/python3',
    '/bin/python',
  ];
  for (const pythonPath of directPaths) addPythonPathCandidate(candidates, pythonPath, 'path:file');
  for (const root of ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge']) {
    addPythonEnvDirCandidates(candidates, resolve(homedir(), root, 'envs'));
  }
  addPythonEnvDirCandidates(candidates, resolve(homedir(), '.pyenv', 'versions'));
  return candidates;
}

function getWindowsPythonPathCandidates() {
  const candidates = [];
  const dirs = [
    resolve(localAppData, 'Programs', 'Python'),
    process.env.ProgramFiles ? resolve(process.env.ProgramFiles) : '',
    process.env['ProgramFiles(x86)'] ? resolve(process.env['ProgramFiles(x86)']) : '',
  ].filter(Boolean);
  addPythonPathCandidate(candidates, resolve(localAppData, 'Microsoft', 'WindowsApps', 'python.exe'), 'path:file');
  for (const dir of dirs) {
    for (const entry of readDirectoryEntries(dir)) {
      if (!/^Python\d+/i.test(entry.name)) continue;
      addPythonPathCandidate(candidates, resolve(dir, entry.name, 'python.exe'), 'path:file');
    }
  }
  return candidates;
}

function addPythonEnvDirCandidates(candidates, envsDir) {
  for (const entry of readDirectoryEntries(envsDir)) {
    if (!entry.isDirectory()) continue;
    const pythonPath = platform() === 'win32'
      ? resolve(envsDir, entry.name, 'python.exe')
      : resolve(envsDir, entry.name, 'bin', 'python');
    addPythonPathCandidate(candidates, pythonPath, 'path:env');
  }
}

function addPythonPathCandidate(candidates, pythonPath, source) {
  if (!existsSync(pythonPath)) return;
  candidates.push({ command: pythonPath, args: [], source });
}

function readDirectoryEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function dedupePythonCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = [candidate.command, ...(candidate.launcherArgs ?? []), ...candidate.args].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function getPythonCommandArgs(candidate) {
  return [...(candidate.launcherArgs ?? []), ...candidate.args];
}

function formatPythonCandidate(candidate) {
  const label = [candidate.command, ...getPythonCommandArgs(candidate)].join(' ');
  return candidate.source ? label + ' (' + candidate.source + ')' : label;
}

function execPythonVersionProbe(candidate) {
  return execProcess(candidate.command, [...getPythonCommandArgs(candidate), '--version'], {
    cwd: homedir(),
    env: createPythonChildEnv(),
    timeoutMs: 2_000,
    maxOutputBytes: 2_000,
  });
}

function parsePythonVersionOutput(probe) {
  const text = [probe.stdout, probe.stderr].join(' ').replace(/\s+/g, ' ').trim();
  const match = text.match(/Python\s+([0-9]+(?:\.[0-9]+){1,2})/i);
  return match ? match[1] : null;
}

function execPythonProbe(candidate) {
  const code = [
    'import importlib.util, json, sys',
    `packages = {name: importlib.util.find_spec(name) is not None for name in ${JSON.stringify(PYTHON_PACKAGE_CHECKS)}}`,
    'print(json.dumps({"executable": sys.executable, "version": sys.version.split()[0], "packages": packages}, ensure_ascii=False))',
  ].join('\n');

  return execProcess(candidate.command, [...getPythonCommandArgs(candidate), '-I', '-c', code], {
    cwd: homedir(),
    env: createPythonChildEnv(),
    timeoutMs: 5_000,
    maxOutputBytes: 16_000,
  });
}

function execPythonProcess(command, commandArgs, { code, cwd, timeoutMs }) {
  return execProcess(command, [...commandArgs, '-I', '-'], {
    cwd,
    env: createPythonChildEnv(),
    input: code,
    timeoutMs,
    maxOutputBytes: MAX_PYTHON_OUTPUT_BYTES,
  });
}

function execProcess(command, args, { cwd, env, input, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stdoutBytes;
        stdout.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      }
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stderrBytes;
        stderr.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      }
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: [command, ...args].join(' '),
        exitCode: timedOut ? -1 : (exitCode ?? -1),
        signal: signal || (timedOut ? 'SIGTERM' : null),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated: stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (input != null) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function createPythonChildEnv() {
  const env = {};
  const posixKeys = [
    'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    // conda / miniforge / mamba
    'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'CONDA_PYTHON_EXE', 'CONDA_SHLVL',
    'MAMBA_ROOT_PREFIX', 'MAMBA_EXE',
    // pyenv
    'PYENV_ROOT', 'PYENV_VERSION', 'PYENV_DIR',
    // virtualenv / venv
    'VIRTUAL_ENV', 'PIP_REQUIRE_VIRTUALENV',
  ];
  const keys = platform() === 'win32'
    ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']
    : posixKeys;

  for (const key of keys) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }

  setEnvironmentPath(env, getEnvironmentPath(process.env));
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONNOUSERSITE = '1';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  return env;
}

function normalizePythonPackages(value) {
  const input = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    PYTHON_PACKAGE_CHECKS.map((name) => [name, input[name] === true]),
  );
}

function getPythonPolicy() {
  return {
    purpose: 'short computation, idea validation, and small data transformations',
    packageInstall: false,
    networkAccess: 'not_allowed_by_policy_not_os_enforced',
    filesystemAccess: 'temporary_cwd_only_by_policy_not_os_enforced',
  };
}

function getPythonLimits() {
  return {
    timeoutMsDefault: DEFAULT_PYTHON_TIMEOUT_MS,
    timeoutMsMax: MAX_PYTHON_TIMEOUT_MS,
    codeBytesMax: MAX_PYTHON_CODE_BYTES,
    outputBytesMax: MAX_PYTHON_OUTPUT_BYTES,
  };
}

function createChildEnv(extraEnv) {
  const explicitPath = getExplicitPathOverride(extraEnv);
  const env = extraEnv && typeof extraEnv === 'object' ? { ...process.env, ...extraEnv } : { ...process.env };
  const pathValue = explicitPath !== null ? explicitPath : (getEnvironmentPath(env) || getEnvironmentPath(process.env));
  setEnvironmentPath(env, pathValue);
  if (platform() === 'win32') {
    env.PYTHONUTF8 ??= '1';
    env.PYTHONIOENCODING ??= 'utf-8';
  }
  return env;
}

function createShellInvocation(command) {
  if (platform() === 'win32') {
    return {
      shellBin: DEFAULT_SHELL,
      shellArgs: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${WINDOWS_POWERSHELL_UTF8_PREAMBLE}; ${command}`,
      ],
    };
  }

  return { shellBin: DEFAULT_SHELL, shellArgs: ['-c', command] };
}

function splitPath(value) {
  return (value || '')
    .split(PATH_SEPARATOR)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function getEnvironmentPath(env) {
  const canonicalKey = platform() === 'win32' ? 'Path' : 'PATH';
  if (typeof env[canonicalKey] === 'string') return env[canonicalKey];
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

function setEnvironmentPath(env, value) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env[platform() === 'win32' ? 'Path' : 'PATH'] = value;
}

function getExplicitPathOverride(env) {
  if (!env || typeof env !== 'object') return null;
  let value = null;
  for (const [key, candidate] of Object.entries(env)) {
    if (key.toLowerCase() === 'path' && typeof candidate === 'string') {
      value = candidate;
    }
  }
  return value;
}

function dedupePathDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = platform() === 'win32'
      ? dir.replace(/[\\/]+$/, '').toLowerCase()
      : dir.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dir);
  }
  return result;
}

function readWindowsUserMachinePathDirs() {
  if (platform() !== 'win32') return [];
  const command = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))",
    "$paths | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }",
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return splitPath(out.replace(/\r?\n/g, PATH_SEPARATOR));
  } catch (err) {
    process.stderr.write(`[shell-mcp-host] Could not read Windows User/Machine PATH: ${err.message}\n`);
    return [];
  }
}

function getWindowsVersionLabel() {
  if (platform() !== 'win32') return null;
  const release = osRelease();
  const parts = release.split('.').map(part => Number.parseInt(part, 10));
  const build = parts[2] || 0;
  if (parts[0] === 10 && build >= 22000) return `Windows 11 (${release})`;
  if (parts[0] === 10) return `Windows 10 (${release})`;
  return `Windows (${release})`;
}

function formatExecSummary(result) {
  const parts = [];
  if (result.timedOut) parts.push('[TIMED OUT]');
  if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]`);
  if (result.truncated) parts.push('[output truncated]');
  if (result.stdout) parts.push(result.stdout.slice(0, 4000));
  if (result.stderr) parts.push(`STDERR: ${result.stderr.slice(0, 2000)}`);
  return parts.join('\n') || '(no output)';
}

function formatPythonExecSummary(result) {
  const parts = [];
  if (result.timedOut) parts.push('[TIMED OUT]');
  if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]`);
  if (result.truncated) parts.push('[output truncated]');
  if (result.stdout) parts.push(result.stdout.slice(0, 4000));
  if (result.stderr) parts.push(`STDERR: ${result.stderr.slice(0, 2000)}`);
  return parts.join('\n') || '(no output)';
}

// --- Image file reading ---

const IMAGE_EXTENSIONS = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

const MAX_MCP_BASE64_BYTES = 650_000; // Keep the full native response under Chrome's 1MB limit

// Supported file types for shell_upload_file — covers DeepSeek's accepted formats:
// PDF, DOC, XLSX, PPT, images, text, code
const FILE_EXTENSIONS = {
  // Images (same as IMAGE_EXTENSIONS)
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff',
  '.tif': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
  // Documents (DeepSeek-supported)
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text & code (DeepSeek-supported)
  '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown',
  '.rtf': 'application/rtf', '.log': 'text/plain',
  '.json': 'application/json', '.xml': 'application/xml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain',
  '.jsx': 'text/plain', '.vue': 'text/plain', '.svelte': 'text/plain',
  '.py': 'text/x-python', '.java': 'text/x-java-source',
  '.c': 'text/x-c', '.cpp': 'text/x-c++src', '.h': 'text/x-c', '.hpp': 'text/x-c++src',
  '.rs': 'text/x-rust', '.go': 'text/x-go', '.rb': 'text/x-ruby',
  '.php': 'text/x-php', '.sh': 'text/x-shellscript', '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript', '.sql': 'text/x-sql',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain',
  '.ini': 'text/plain', '.cfg': 'text/plain', '.conf': 'text/plain',
  '.swift': 'text/plain', '.kt': 'text/plain', '.scala': 'text/plain',
  '.r': 'text/plain', '.m': 'text/plain', '.lua': 'text/plain',
  '.pl': 'text/plain', '.dart': 'text/plain', '.ex': 'text/plain',
  '.erl': 'text/plain', '.hs': 'text/plain', '.clj': 'text/plain',
  '.scm': 'text/plain', '.lisp': 'text/plain',
};

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB for documents (vs 10 MB for images)

// --- Localhost HTTP bridge for large files ---
// Chrome's native messaging has a per-session quota that shell_exec chunked
// reads can exhaust.  Instead of piping file data through MCP JSON, we serve
// the temp file over a one-shot HTTP server bound to 127.0.0.1.  The browser
// extension fetches the URL directly, receiving the full binary with no
// encoding overhead and no native-messaging quota pressure.

/**
 * Find a free TCP port on 127.0.0.1.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * Start a one-shot HTTP server that serves `filePath` exactly once, then
 * closes.  Returns the URL the browser should fetch.
 *
 * The caller remains responsible for cleaning up tmpDir after the browser
 * has successfully downloaded the data (the browser does this via
 * shell_exec `rm -rf` after its fetch completes).
 */
async function serveTempFile(filePath) {
  const port = await findFreePort();
  const server = createServer((req, res) => {
    // Accept only GET — reject everything else so scanners don't trigger
    // the one-shot close.
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    let stream;
    try {
      stream = createReadStream(filePath);
    } catch (err) {
      res.writeHead(500);
      res.end();
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');

    stream.pipe(res);
    res.on('finish', () => server.close());
    stream.on('error', () => { try { res.end(); } catch {} server.close(); });
  });

  // Auto-close after 60 s if no request arrives (browser crash / timeout).
  const timeout = setTimeout(() => server.close(), 60_000);
  server.on('close', () => clearTimeout(timeout));

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  return `http://127.0.0.1:${port}`;
}

async function readImageFile(args) {
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!filePath) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'path is required and must be a non-empty string.' }],
    };
  }

  let resolvedPath;
  try {
    resolvedPath = resolve(filePath);
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: `Invalid path: ${filePath}` }],
    };
  }

  if (!existsSync(resolvedPath)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
    };
  }

  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Cannot stat file: ${err.message}` }],
    };
  }

  if (!stats.isFile()) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Not a regular file: ${resolvedPath}` }],
    };
  }

  const ext = (() => {
    const base = resolvedPath.toLowerCase();
    if (base.endsWith('.jpeg')) return '.jpeg';
    if (base.endsWith('.tiff')) return '.tiff';
    if (base.endsWith('.heic')) return '.heic';
    if (base.endsWith('.heif')) return '.heif';
    if (base.endsWith('.webp')) return '.webp';
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot) : '';
  })();

  const mimeType = IMAGE_EXTENSIONS[ext];
  if (!mimeType) {
    const supported = Object.keys(IMAGE_EXTENSIONS).join(', ');
    return {
      isError: true,
      content: [{ type: 'text', text: `Unsupported image format "${ext || 'unknown'}". Supported: ${supported}` }],
    };
  }

  if (stats.size > MAX_IMAGE_BYTES) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Image too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB (max 10 MB)` }],
    };
  }

  let buffer;
  try {
    buffer = readFileSync(resolvedPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to read file: ${err.message}` }],
    };
  }

  let base64 = buffer.toString('base64');
  let imageSource = 'original';
  let compressedDetails = '';

  // If base64 exceeds MCP message limit, try to compress via Python/Pillow
  if (base64.length > MAX_MCP_BASE64_BYTES) {
    const compressed = await tryCompressImage(resolvedPath, mimeType);
    if (compressed) {
      base64 = compressed.base64;
      imageSource = 'compressed';
      compressedDetails = ` (compressed: ${(compressed.originalKB / 1024).toFixed(1)} KB -> ${(compressed.compressedKB / 1024).toFixed(1)} KB, ${compressed.dimensions || 'unknown'})`;
    }
  }

  // If still too large, serve via localhost HTTP bridge
  if (base64.length > MAX_MCP_BASE64_BYTES) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deepseek-pp-img-'));
    const tmpFile = join(tmpDir, 'image.b64');
    try {
      // Write a created_at marker so startup cleanup can age the dir correctly
      writeFileSync(join(tmpDir, '.created_at'), String(Date.now()), 'utf8');
      writeFileSync(tmpFile, base64, 'utf8');
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to write image data to temp file: ${err.message}` }],
      };
    }

    // Start a one-shot HTTP server on 127.0.0.1 so the browser can fetch
    // the full base64 directly — no JSON encoding, no native-messaging quota.
    let tempDataUrl;
    try {
      tempDataUrl = await serveTempFile(tmpFile);
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to start local HTTP server: ${err.message}` }],
      };
    }

    const sizeKB = (stats.size / 1024).toFixed(1);
    return {
      content: [{
        type: 'text',
        text: [
          `Image metadata (data too large for direct transfer${compressedDetails}).`,
          `Path: ${resolvedPath}`,
          `Size: ${sizeKB} KB`,
          `MIME: ${mimeType}`,
          `Served at: ${tempDataUrl}`,
        ].join('\n'),
      }],
      structuredContent: {
        ok: true,
        data: {
          path: resolvedPath,
          size: stats.size,
          mimeType,
          base64TooLarge: true,
          tempDataFile: tmpFile,
          tempDataUrl,
          tmpDir,
        },
      },
    };
  }

  const sizeKB = (stats.size / 1024).toFixed(1);
  const summary = `Image read successfully. Path: ${resolvedPath} Size: ${sizeKB} KB MIME: ${mimeType} Base64: ${base64.length} chars${compressedDetails}`;

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: {
      ok: true,
      data: {
        path: resolvedPath,
        size: stats.size,
        mimeType,
        base64,
        imageSource,
      },
    },
  };
}

// --- Generic file reading (shell_upload_file) ---

async function readGenericFile(args) {
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!filePath) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'path is required and must be a non-empty string.' }],
    };
  }

  let resolvedPath;
  try {
    resolvedPath = resolve(filePath);
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: `Invalid path: ${filePath}` }],
    };
  }

  if (!existsSync(resolvedPath)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
    };
  }

  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Cannot stat file: ${err.message}` }],
    };
  }

  if (!stats.isFile()) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Not a regular file: ${resolvedPath}` }],
    };
  }

  const ext = (() => {
    const base = resolvedPath.toLowerCase();
    // Multi-char extensions first
    for (const multi of ['.docx', '.xlsx', '.pptx', '.jpeg', '.tiff', '.heic', '.heif', '.webp',
      '.html', '.yaml', '.json', '.bash', '.conf', '.lisp', '.scala', '.swift', '.svelte']) {
      if (base.endsWith(multi)) return multi;
    }
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot) : '';
  })();

  const mimeType = FILE_EXTENSIONS[ext];
  if (!mimeType) {
    const supported = [...new Set(Object.values(FILE_EXTENSIONS))].join(', ');
    return {
      isError: true,
      content: [{ type: 'text', text: `Unsupported file format "${ext || 'unknown'}". DeepSeek supports: PDF, DOC/DOCX, XLSX/XLS, PPT/PPTX, images, text, and code files.` }],
    };
  }

  if (stats.size > MAX_FILE_BYTES) {
    return {
      isError: true,
      content: [{ type: 'text', text: `File too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB (max 20 MB)` }],
    };
  }

  let buffer;
  try {
    buffer = readFileSync(resolvedPath);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to read file: ${err.message}` }],
    };
  }

  let base64 = buffer.toString('base64');

  // If base64 exceeds MCP message limit, serve via localhost HTTP bridge
  if (base64.length > MAX_MCP_BASE64_BYTES) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deepseek-pp-file-'));
    const tmpFile = join(tmpDir, 'file.b64');
    try {
      writeFileSync(join(tmpDir, '.created_at'), String(Date.now()), 'utf8');
      writeFileSync(tmpFile, base64, 'utf8');
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to write file data to temp file: ${err.message}` }],
      };
    }

    // Start a one-shot HTTP server on 127.0.0.1 so the browser can fetch
    // the full base64 directly — no JSON encoding, no native-messaging quota.
    let tempDataUrl;
    try {
      tempDataUrl = await serveTempFile(tmpFile);
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to start local HTTP server: ${err.message}` }],
      };
    }

    const sizeKB = (stats.size / 1024).toFixed(1);
    return {
      content: [{
        type: 'text',
        text: [
          `File metadata (data too large for direct transfer).`,
          `Path: ${resolvedPath}`,
          `Size: ${sizeKB} KB`,
          `MIME: ${mimeType}`,
          `Served at: ${tempDataUrl}`,
        ].join('\n'),
      }],
      structuredContent: {
        ok: true,
        data: {
          path: resolvedPath,
          size: stats.size,
          mimeType,
          base64TooLarge: true,
          tempDataFile: tmpFile,
          tempDataUrl,
          tmpDir,
        },
      },
    };
  }

  const sizeKB = (stats.size / 1024).toFixed(1);
  const summary = `File read successfully. Path: ${resolvedPath} Size: ${sizeKB} KB MIME: ${mimeType} Base64: ${base64.length} chars`;

  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: {
      ok: true,
      data: {
        path: resolvedPath,
        size: stats.size,
        mimeType,
        base64,
      },
    },
  };
}

async function tryCompressImage(imagePath, mimeType) {
  // Try to find Python with Pillow for compression
  const pythonProbe = await getFirstAvailablePython();
  if (!pythonProbe) return null;

  const resizeScript = [
    'import base64, json, sys',
    'try:',
    '  from PIL import Image',
    '  import io',
    `  img = Image.open(${JSON.stringify(imagePath)})`,
    '  orig_w, orig_h = img.size',
    '  max_dim = 1024',
    '  if max(orig_w, orig_h) > max_dim:',
    '    ratio = max_dim / max(orig_w, orig_h)',
    '    img = img.resize((int(orig_w * ratio), int(orig_h * ratio)), Image.LANCZOS)',
    '  if img.mode in ("RGBA", "P"):',
    '    img = img.convert("RGB")',
    '  buf = io.BytesIO()',
    '  img.save(buf, format="JPEG", quality=75)',
    '  compressed = base64.b64encode(buf.getvalue()).decode()',
    `  with open(${JSON.stringify(imagePath)},"rb") as _f: orig_raw = _f.read()`,
    '  orig_b64 = base64.b64encode(orig_raw)',
    '  print(json.dumps({',
    '    "ok": True,',
    '    "base64": compressed,',
    '    "originalKB": len(orig_b64),',
    '    "compressedKB": len(compressed),',
    '    "dimensions": f"{orig_w}x{orig_h}",',
    '  }))',
    'except Exception as e:',
    '  print(json.dumps({"ok": False, "error": str(e)}))',
  ].join('\n');

  try {
    const result = await execProcess(pythonProbe.command, [...pythonProbe.args, '-I', '-c', resizeScript], {
      cwd: tmpdir(),
      env: createPythonChildEnv(),
      timeoutMs: 15_000,
      maxOutputBytes: 800_000, // Need room for compressed base64
    });
    if (result.exitCode !== 0) return null;
    const data = JSON.parse(result.stdout.trim());
    if (!data.ok) return null;
    return {
      base64: data.base64,
      originalKB: data.originalKB,
      compressedKB: data.compressedKB,
      dimensions: data.dimensions,
    };
  } catch {
    return null;
  }
}

async function getFirstAvailablePython() {
  const candidates = getPythonCandidates();
  for (const candidate of candidates) {
    try {
      const probe = await execProcess(candidate.command, [
        ...getPythonCommandArgs(candidate),
        '-I', '-c',
        'import PIL.Image; print("ok")',
      ], {
        cwd: homedir(),
        env: createPythonChildEnv(),
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      });
      if (probe.exitCode === 0 && probe.stdout.includes('ok')) {
        return { command: candidate.command, args: getPythonCommandArgs(candidate) };
      }
    } catch {
      // try next
    }
  }
  return null;
}

// --- Image analysis via Python/Pillow ---

async function analyzeImageContent(args) {
  const filePath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!filePath) {
    return { isError: true, content: [{ type: 'text', text: 'path is required.' }] };
  }

  let resolvedPath;
  try { resolvedPath = resolve(filePath); } catch {
    return { isError: true, content: [{ type: 'text', text: `Invalid path: ${filePath}` }] };
  }

  if (!existsSync(resolvedPath)) {
    return { isError: true, content: [{ type: 'text', text: `File not found: ${resolvedPath}` }] };
  }

  let stats;
  try { stats = statSync(resolvedPath); } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Cannot stat: ${err.message}` }] };
  }

  const doOcr = args.extract_text !== false;

  const pythonProbe = await getFirstAvailablePython();
  if (!pythonProbe) {
    return { isError: true, content: [{ type: 'text', text: 'No Python interpreter with Pillow found. Install Pillow: pip install Pillow' }] };
  }

  const analysisScript = [
    'import json, base64, sys, os',
    'try:',
    '  from PIL import Image, ImageStat',
    `  img = Image.open(${JSON.stringify(resolvedPath)})`,
    '  w, h = img.size',
    '  mode = img.mode',
    '  fmt = img.format',
    '  info = {k: str(v) for k, v in img.info.items() if k not in ("icc_profile",)}',
    '',
    '  # Color statistics',
    '  stat = ImageStat.Stat(img)',
    '  colors = img.getcolors(min(256, w * h))',
    '',
    '  # Dominant colors (top 5)',
    '  dominant = []',
    '  if colors:',
    '    sorted_colors = sorted(colors, key=lambda x: x[0], reverse=True)[:5]',
    '    for count, color in sorted_colors:',
    '      if len(color) >= 3:',
    '        dominant.append({',
    '          "rgb": list(color[:3]),',
    '          "hex": "#{:02x}{:02x}{:02x}".format(*color[:3]),',
    '          "pct": round(count / (w * h) * 100, 1)',
    '        })',
    '',
    '  # Brightness distribution',
    '  if mode in ("RGB", "RGBA"):',
    '    gray = img.convert("L")',
    '    gray_stat = ImageStat.Stat(gray)',
    '    avg_brightness = gray_stat.mean[0]',
    '  elif mode == "L":',
    '    avg_brightness = stat.mean[0]',
    '  else:',
    '    avg_brightness = None',
    '',
    '  result = {',
    '    "ok": True,',
    '    "file": ${JSON.stringify(resolvedPath)},',
    '    "size_bytes": ${stats.size},',
    '    "dimensions": f"{w}x{h}",',
    '    "format": fmt,',
    '    "mode": mode,',
    '    "dominant_colors": dominant,',
    '    "avg_brightness": round(avg_brightness, 1) if avg_brightness is not None else None,',
    '    "info": info,',
    '  }',
    '',
    `  doOcr = ${doOcr ? 'True' : 'False'}`,
    '  if doOcr:',
    '    try:',
    '      import pytesseract',
    '      text = pytesseract.image_to_string(img)',
    '      result["ocr_text"] = text.strip()[:5000]',
    '      result["ocr_available"] = True',
    '    except ImportError:',
    '      result["ocr_available"] = False',
    '      result["ocr_note"] = "pytesseract not installed. Install: pip install pytesseract"',
    '    except Exception as e:',
    '      result["ocr_error"] = str(e)',
    '',
    '  print(json.dumps(result, ensure_ascii=False))',
    'except Exception as e:',
    '  print(json.dumps({"ok": False, "error": str(e)}))',
  ].join('\n');

  try {
    const result = await execProcess(pythonProbe.command, [...pythonProbe.args, '-I', '-c', analysisScript], {
      cwd: tmpdir(),
      env: createPythonChildEnv(),
      timeoutMs: 20_000,
      maxOutputBytes: 100_000,
    });

    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Image analysis failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}` }],
      };
    }

    const data = JSON.parse(result.stdout.trim());
    if (!data.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Image analysis error: ${data.error}` }],
      };
    }

    const lines = [
      `=== Image Analysis: ${data.file} ===`,
      `Dimensions: ${data.dimensions}`,
      `Format: ${data.format} | Mode: ${data.mode}`,
      `File size: ${(data.size_bytes / 1024).toFixed(1)} KB`,
      `Average brightness: ${data.avg_brightness ?? 'N/A'} (0=black, 255=white)`,
      '',
      'Dominant colors:',
      ...(data.dominant_colors || []).map((c) => `  ${c.hex} (rgb: ${c.rgb.join(',')}) - ${c.pct}%`),
      '',
    ];

    if (data.ocr_text) {
      lines.push('=== Extracted Text (OCR) ===');
      lines.push(data.ocr_text);
    } else if (data.ocr_note) {
      lines.push(`Note: ${data.ocr_note}`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { ok: true, data },
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Image analysis failed: ${err.message}` }],
    };
  }
}

// --- Message dispatch ---

async function handleMessage(envelope) {
  if (envelope.protocol !== 'deepseek-pp-mcp-native' || envelope.version !== 1) {
    await writeNativeMessage(jsonRpcError(null, -32600, 'Invalid envelope: expected deepseek-pp-mcp-native v1'));
    return;
  }

  const message = envelope.message;
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    await writeNativeMessage(jsonRpcError(null, -32600, 'Invalid JSON-RPC request.'));
    return;
  }

  const id = message.id ?? null;

  if (!('id' in message)) {
    return;
  }

  let response;
  switch (message.method) {
    case 'initialize':
      response = handleInitialize(id);
      break;
    case 'tools/list':
      response = handleListTools(id);
      break;
    case 'tools/call':
      response = await handleCallTool(id, message.params);
      break;
    default:
      response = jsonRpcError(id, -32601, `Unsupported method: ${message.method}`);
  }

  await writeNativeMessage(response);
}

// --- Persistent main loop ---

// --- Temp directory cleanup ---

const IMAGE_TMP_DIR_PREFIX = 'deepseek-pp-img-';
const FILE_TMP_DIR_PREFIX = 'deepseek-pp-file-';
const IMAGE_TMP_DIR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function cleanupOldTempDirs() {
  let tmpRoot;
  try { tmpRoot = tmpdir(); } catch { return; }
  let entries;
  try { entries = readdirSync(tmpRoot); } catch { return; }
  const now = Date.now();

  for (const name of entries) {
    if (!name.startsWith(IMAGE_TMP_DIR_PREFIX) && !name.startsWith(FILE_TMP_DIR_PREFIX)) continue;
    const dirPath = join(tmpRoot, name);
    let stat;
    try { stat = statSync(dirPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    // Check created_at marker for accurate age; fall back to directory mtime
    let age = now - stat.mtimeMs;
    try {
      const markerPath = join(dirPath, '.created_at');
      const markerText = readFileSync(markerPath, 'utf8').trim();
      const markerTs = Number(markerText);
      if (Number.isFinite(markerTs) && markerTs > 0) {
        age = now - markerTs;
      }
    } catch { /* marker may not exist for pre-marker dirs */ }

    if (age > IMAGE_TMP_DIR_MAX_AGE_MS) {
      try {
        rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // Non-fatal — leave stale dirs rather than crash startup
      }
    }
  }
}

async function main() {
  cleanupOldTempDirs();

  while (true) {
    let envelope;
    try {
      envelope = await readMessage();
    } catch {
      break;
    }
    if (envelope === EOF) break;
    try {
      await handleMessage(envelope);
    } catch (err) {
      process.stderr.write(`[shell-mcp-host] Error: ${err.message || err}\n`);
      await writeNativeMessage(jsonRpcError(null, -32603, err.message || 'Internal error'));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[shell-mcp-host] Fatal: ${err.message || err}\n`);
  process.exit(1);
});
